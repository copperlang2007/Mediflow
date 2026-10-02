/**
 * Move clients (contacts) and everything attached to them from one agency
 * (organization) to another, without creating duplicates.
 *
 *   DATABASE_URL=postgres://... pnpm --filter @workspace/scripts move:clients \
 *     --from "<source org id or name>" --to "<target org id or name>"          # dry run
 *   ... same command plus --apply                                              # real move
 *
 * Safe by construction:
 *  - Dry run is the default. The whole move runs in ONE transaction and is
 *    rolled back unless --apply is passed.
 *  - A source client who already exists in the target (same Medicare ID, or
 *    email/phone + first name, or name + date of birth: the importer's rules)
 *    is NOT moved and NOT copied. It stays where it is and is listed in a CSV
 *    (ids only, no PHI) for a human to decide.
 *  - Every table that points at a moved client (found through the database's
 *    foreign keys, plus bare `contact_id` columns) moves with it, recursively
 *    (client -> policies -> applications ...).
 *  - Carriers are matched to the target's carriers by name (created if
 *    missing). Agents are matched by email, else left unassigned.
 *  - Any reference to some other agency-owned row that cannot be carried over
 *    is nulled when the column allows it; otherwise the whole run aborts.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes("--apply");
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

type Edge = { child: string; col: string; parent: string; notNull: boolean };
type Job = { child: string; col: string; parent: string };

async function main() {
  const fromArg = arg("from");
  const toArg = arg("to");
  if (!process.env.DATABASE_URL || !fromArg || !toArg) {
    console.error('Usage: DATABASE_URL=... move-clients-between-orgs --from "<org id|name>" --to "<org id|name>" [--apply]');
    process.exit(2);
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];

  async function resolveOrg(label: string, v: string) {
    const rows = await one<{ id: string; name: string }>(
      `select id, name from organizations where id = $1 or name ilike $1 or slug ilike $1`, [v]);
    if (rows.length !== 1) {
      throw new Error(`--${label} "${v}" matched ${rows.length} organizations${rows.length ? `: ${rows.map((r) => `${r.name} (${r.id})`).join(", ")}` : ""}. Use the exact id.`);
    }
    return rows[0]!;
  }

  await db.query("BEGIN");
  await db.query("SET LOCAL statement_timeout = 0");
  try {
    const from = await resolveOrg("from", fromArg);
    const to = await resolveOrg("to", toArg);
    if (from.id === to.id) throw new Error("--from and --to are the same organization");
    console.log(`FROM: ${from.name} (${from.id})\nTO:   ${to.name} (${to.id})\nMODE: ${APPLY ? "APPLY (will commit)" : "DRY RUN (will roll back)"}\n`);

    const snapshot = async () => (await one<{ k: string; n: string }>(
      `select 'src_contacts' k, count(*) n from contacts where org_id=$1 and deleted_at is null
       union all select 'src_enrollments', count(*) from enrollments where org_id=$1
       union all select 'tgt_contacts', count(*) from contacts where org_id=$2 and deleted_at is null
       union all select 'tgt_enrollments', count(*) from enrollments where org_id=$2
       union all select 'tgt_duplicate_mbi_groups', count(*) from (
         select medicare_id_hash from contacts where org_id=$2 and deleted_at is null and medicare_id_hash is not null
         group by 1 having count(*) > 1) d`, [from.id, to.id]))
      .reduce<Record<string, number>>((a, r) => ({ ...a, [r.k]: Number(r.n) }), {});
    const before = await snapshot();

    // ── 1. Who is already in the target? ────────────────────────────────────
    const matches = await one<{ src: string; tgt: string; reason: string }>(
      `select distinct on (s.id) s.id src, t.id tgt, m.reason
       from contacts s
       join contacts t on t.org_id = $2 and t.deleted_at is null
       cross join lateral (select case
           when s.medicare_id_hash is not null and s.medicare_id_hash = t.medicare_id_hash then 'Medicare ID'
           when s.email is not null and lower(s.email) = lower(t.email) and lower(s.first_name) = lower(t.first_name)
                and (case when s.dob is not null and t.dob is not null then s.dob = t.dob else lower(s.last_name) = lower(t.last_name) end) then 'email + name'
           when s.phone is not null and s.phone = t.phone and lower(s.first_name) = lower(t.first_name)
                and (case when s.dob is not null and t.dob is not null then s.dob = t.dob else lower(s.last_name) = lower(t.last_name) end) then 'phone + name'
           when s.dob is not null and s.dob = t.dob and lower(s.first_name) = lower(t.first_name) and lower(s.last_name) = lower(t.last_name) then 'name + date of birth'
         end reason) m
       where s.org_id = $1 and s.deleted_at is null and m.reason is not null
       order by s.id, case m.reason when 'Medicare ID' then 1 when 'email + name' then 2 when 'phone + name' then 3 else 4 end`,
      [from.id, to.id]);
    const csvName = `move-clients-already-in-target-${Date.now()}.csv`;
    writeFileSync(csvName, ["source_contact_id,target_contact_id,matched_on", ...matches.map((m) => `${m.src},${m.tgt},${m.reason}`)].join("\n") + "\n");

    await db.query(`create temp table mv_contacts (id text primary key) on commit drop`);
    await db.query(
      `insert into mv_contacts select id from contacts where org_id = $1 and deleted_at is null and id <> all($2::text[])`,
      [from.id, matches.map((m) => m.src)]);
    const toMove = Number((await one<{ n: string }>(`select count(*) n from mv_contacts`))[0]!.n);

    // ── 2. Discover everything that hangs off a client ──────────────────────
    const orgTables = new Set((await one<{ t: string }>(
      `select table_name t from information_schema.columns where table_schema='public' and column_name='org_id'`)).map((r) => r.t));
    const idTables = new Set((await one<{ t: string }>(
      `select table_name t from information_schema.columns where table_schema='public' and column_name='id'`)).map((r) => r.t));
    const fks = await one<Edge & { child: string }>(
      `select cl.relname child, a.attname col, pl.relname parent, a.attnotnull "notNull"
       from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_class pl on pl.oid = k.confrelid
       join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
       join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       where k.contype = 'f' and array_length(k.conkey, 1) = 1`);
    const edges: Edge[] = fks.filter((f) => orgTables.has(f.child) && !/audit/.test(f.child));
    const softContactRefs = await one<{ t: string }>(
      `select table_name t from information_schema.columns where table_schema='public' and column_name='contact_id'`);
    for (const { t } of softContactRefs) {
      if (orgTables.has(t) && t !== "contacts" && !/audit/.test(t) && !edges.some((e) => e.child === t && e.col === "contact_id" && e.parent === "contacts")) {
        edges.push({ child: t, col: "contact_id", parent: "contacts", notNull: false });
      }
    }

    const mv = new Map<string, string>([["contacts", "mv_contacts"]]);
    const jobs: Job[] = [];
    const queue = ["contacts"];
    while (queue.length) {
      const p = queue.shift()!;
      for (const e of edges.filter((x) => x.parent === p && x.child !== "contacts" && x.child !== p)) {
        if (!mv.has(e.child) && idTables.has(e.child)) {
          const tmp = `mv_${mv.size}`;
          await db.query(`create temp table ${tmp} (id text primary key) on commit drop`);
          mv.set(e.child, tmp);
          queue.push(e.child);
        }
        jobs.push({ child: e.child, col: e.col, parent: p });
        const tmp = mv.get(e.child);
        if (tmp) {
          await db.query(
            `insert into ${tmp} select id::text from ${q(e.child)} where org_id = $1 and ${q(e.col)}::text in (select id from ${mv.get(p)}) on conflict do nothing`,
            [from.id]);
        }
      }
    }

    // ── 3. Carriers and agents: map by name / email ─────────────────────────
    const refTo = (parent: string) => [...mv.keys()].flatMap((m) =>
      fks.filter((f) => f.child === m && f.parent === parent && f.col !== "org_id").map((f) => ({ ...f })));
    const carrierRefs = refTo("carriers");
    const agentRefs = refTo("agents");
    const norm = (c: string) => `regexp_replace(lower(trim(${c})), '\\s+', ' ', 'g')`;
    let carriersCreated = 0;
    for (const r of carrierRefs) {
      const missing = await one<{ id: string; name: string; cms_contract_number: string | null; logo_url: string | null; is_active: boolean }>(
        `select s.id, s.name, s.cms_contract_number, s.logo_url, s.is_active from carriers s
         where s.org_id = $1 and s.id in (select ${q(r.col)} from ${q(r.child)} where id in (select id from ${mv.get(r.child)}))
           and not exists (select 1 from carriers t where t.org_id = $2 and ${norm("t.name")} = ${norm("s.name")})`,
        [from.id, to.id]);
      for (const c of missing) {
        const exists = await one(`select 1 from carriers where org_id = $1 and ${norm("name")} = ${norm("$2::text")}`, [to.id, c.name]);
        if (exists.length) continue;
        await db.query(
          `insert into carriers (id, org_id, name, cms_contract_number, logo_url, is_active) values ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), to.id, c.name.trim().replace(/\s+/g, " "), c.cms_contract_number, c.logo_url, c.is_active]);
        carriersCreated++;
      }
    }

    // ── 4. Move the rows ────────────────────────────────────────────────────
    const moved: Record<string, number> = {};
    const contactsMoved = await db.query(`update contacts set org_id = $2 where org_id = $1 and id in (select id from mv_contacts)`, [from.id, to.id]);
    moved.contacts = contactsMoved.rowCount ?? 0;
    for (const j of jobs) {
      const r = await db.query(
        `update ${q(j.child)} set org_id = $2 where org_id = $1 and ${q(j.col)}::text in (select id from ${mv.get(j.parent)})`, [from.id, to.id]);
      moved[j.child] = (moved[j.child] ?? 0) + (r.rowCount ?? 0);
    }
    for (const [t, tmp] of mv) {
      if (t === "contacts") continue;
      const stragglers = await one<{ n: string }>(`select count(*) n from ${q(t)} where org_id = $1 and id in (select id from ${tmp})`, [from.id]);
      if (Number(stragglers[0]!.n) > 0) throw new Error(`${stragglers[0]!.n} rows in ${t} did not move`);
    }

    // ── 5. Re-point references that must not cross agencies ─────────────────
    const remapped: Record<string, number> = {};
    for (const [t, tmp] of mv) {
      for (const f of fks.filter((x) => x.child === t && x.col !== "org_id" && !mv.has(x.parent))) {
        const where = `id in (select id from ${tmp}) and ${q(f.col)} is not null`;
        if (f.parent === "carriers" || f.parent === "agents") {
          const key = f.parent === "carriers" ? norm("{a}.name") : "lower({a}.email)";
          const match = `select t.id from ${f.parent} s join ${f.parent} t on t.org_id = $2 and ${key.replace(/\{a\}/g, "t")} = ${key.replace(/\{a\}/g, "s")} where s.id = ${q(t)}.${q(f.col)} limit 1`;
          const stale = `exists (select 1 from ${f.parent} s where s.id = ${q(t)}.${q(f.col)} and s.org_id = $1)`;
          if (f.notNull) {
            const bad = await one<{ n: string }>(`select count(*) n from ${q(t)} where ${where} and ${stale} and not exists (${match})`, [from.id, to.id]);
            if (Number(bad[0]!.n) > 0) throw new Error(`${t}.${f.col} is required but ${bad[0]!.n} rows have no ${f.parent} match in the target agency`);
          }
          const r = await db.query(`update ${q(t)} set ${q(f.col)} = (${match}) where ${where} and ${stale}`, [from.id, to.id]);
          if (r.rowCount) remapped[`${t}.${f.col} -> ${f.parent}`] = r.rowCount;
        } else if (orgTables.has(f.parent)) {
          const foreign = `not exists (select 1 from ${q(f.parent)} p where p.id = ${q(t)}.${q(f.col)} and p.org_id = $1)`;
          const n = Number((await one<{ n: string }>(`select count(*) n from ${q(t)} where ${where} and ${foreign}`, [to.id]))[0]!.n);
          if (n === 0) continue;
          if (f.notNull) throw new Error(`${t}.${f.col} (-> ${f.parent}) is required and points at another agency's row on ${n} rows; cannot move safely`);
          await db.query(`update ${q(t)} set ${q(f.col)} = null where ${where} and ${foreign}`, [to.id]);
          remapped[`${t}.${f.col} -> ${f.parent} (cleared)`] = n;
        }
      }
    }

    // ── 6. Report ───────────────────────────────────────────────────────────
    const after = await snapshot();
    const leftover = Number((await one<{ n: string }>(
      `select count(*) n from contacts where org_id = $1 and id in (select id from mv_contacts)`, [from.id]))[0]!.n);
    if (leftover > 0) throw new Error(`${leftover} contacts still in the source agency`);
    if (after.tgt_duplicate_mbi_groups > before.tgt_duplicate_mbi_groups) {
      throw new Error("Move would create duplicate Medicare IDs in the target agency");
    }

    console.log(`Clients in source:              ${before.src_contacts}`);
    console.log(`  already in target (left, see ${csvName}): ${matches.length}`);
    console.log(`  to move:                      ${toMove}`);
    console.log(`Rows moved per table:           ${JSON.stringify(moved)}`);
    console.log(`Carriers created in target:     ${carriersCreated}`);
    console.log(`References re-pointed/cleared:  ${JSON.stringify(remapped)}`);
    console.log(`Source contacts/enrollments:    ${before.src_contacts}/${before.src_enrollments}  ->  ${after.src_contacts}/${after.src_enrollments}`);
    console.log(`Target contacts/enrollments:    ${before.tgt_contacts}/${before.tgt_enrollments}  ->  ${after.tgt_contacts}/${after.tgt_enrollments}`);
    console.log(`Duplicate Medicare-ID groups in target: ${before.tgt_duplicate_mbi_groups} -> ${after.tgt_duplicate_mbi_groups}`);

    if (APPLY) {
      await db.query("COMMIT");
      console.log("\nCOMMITTED.");
    } else {
      await db.query("ROLLBACK");
      console.log("\nDRY RUN: rolled back, nothing changed. Re-run with --apply to commit.");
    }
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    console.error("\nABORTED, nothing changed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

void main();
