/**
 * Move clients (contacts) and everything attached to them from one agency
 * (organization) to another, without creating duplicates.
 *
 *   DATABASE_URL=postgres://... PHI_ENCRYPTION_KEY=... PHI_HMAC_KEY=... \
 *     pnpm --filter @workspace/scripts move:clients \
 *     --from "<source org id, name or slug>" --to "<target org id, name or slug>" [--operator you@x.com]   # dry run
 *   ... same command plus --apply                                                                          # real move
 *
 * Safe by construction:
 *  - Dry run is the default. The whole move runs in ONE transaction and is
 *    rolled back unless --apply is passed. A transaction-level advisory lock
 *    refuses to start if another run is in progress.
 *  - Organizations are matched exactly (id, name or slug, case-insensitive).
 *    No wildcards.
 *  - A source client who already exists in the target (live OR soft-deleted)
 *    is NOT moved and NOT copied. It stays where it is and is listed in a CSV
 *    (ids only, no PHI) for a human to decide. Matching follows the importer's
 *    rules: Medicare ID (canonical and dashed spellings, so it needs the same
 *    PHI_* keys as the app), email or phone (normalized) + first name,
 *    or name + date of birth.
 *  - Every table that points at a moved client (found through the database's
 *    foreign keys, plus bare `contact_id` columns) moves with it, recursively
 *    (client -> policies -> applications ...).
 *  - Carriers are matched to the target's carriers by name (created if
 *    missing). Agents are matched by email, else left unassigned.
 *  - Any reference to some other agency-owned row that cannot be carried over
 *    is nulled when the column allows it; otherwise the whole run aborts
 *    (nothing is changed) and names the table and column.
 *
 * Known limit: clients with deals or campaign history point at pipelines and
 * campaigns that belong to the source agency through NOT NULL columns. Those
 * rows cannot be re-pointed, so the run aborts safely (nothing changes) and
 * lists EVERY such blocker at once, so the clean-up list is complete before
 * --apply. Detach or delete those records first, or extend the walker.
 *
 * Other guards: a unique-key clash with a row already in the target is reported
 * by table, constraint and key columns (never values); a reference to a table
 * that no agency owns aborts unless allowed with --allow-shared-parent
 * <table.column>; clients that only have a Medicare ID hash (no stored ID)
 * block --apply unless --allow-hash-only is passed; the "already in target" CSV
 * is written only at the end and named .dryrun.csv or .applied.csv (none on abort).
 *
 * On --apply a row is written to audit_log in BOTH agencies (operator, org ids,
 * per-table counts; no PHI).
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { decryptMedicareId, hashMedicareId } from "@workspace/db/encryption/medicareId";

const { Client } = pg;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes("--apply");
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

type Edge = { child: string; col: string; parent: string; notNull: boolean };
type Job = { child: string; col: string; parent: string };

const MBI_RE = /^[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y]{2}[0-9]{2}$/;

/** The hashes a stored Medicare ID could carry: canonical and 4-3-4 dashed (what the importer checks). */
function mbiCandidateHashes(plain: string): Buffer[] {
  const canonical = plain.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!MBI_RE.test(canonical)) return [hashMedicareId(plain)];
  const dashed = `${canonical.slice(0, 4)}-${canonical.slice(4, 7)}-${canonical.slice(7)}`;
  return [hashMedicareId(canonical), hashMedicareId(dashed)];
}

async function main() {
  const fromArg = arg("from");
  const toArg = arg("to");
  if (!process.env.DATABASE_URL || !fromArg || !toArg) {
    console.error('Usage: DATABASE_URL=... move-clients-between-orgs --from "<org id|name|slug>" --to "<org id|name|slug>" [--operator <who>] [--apply]');
    process.exit(2);
  }
  const operator = arg("operator") ?? process.env.USER ?? process.env.USERNAME ?? "unknown";
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];

  async function resolveOrg(label: string, v: string) {
    const rows = await one<{ id: string; name: string }>(
      `select id, name from organizations where id = $1 or lower(name) = lower($1) or lower(slug) = lower($1)`, [v]);
    if (rows.length !== 1) {
      throw new Error(`--${label} "${v}" matched ${rows.length} organizations${rows.length ? `: ${rows.map((r) => `${r.name} (${r.id})`).join(", ")}` : ""}. Use the exact id.`);
    }
    return rows[0]!;
  }

  let committed = false;
  await db.query("BEGIN");
  await db.query("SET LOCAL statement_timeout = 0");
  try {
    const [{ ok }] = await one<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended('mediflow:move-clients', 0)) as ok`);
    if (!ok) throw new Error("Another move-clients run is in progress; aborting.");

    const from = await resolveOrg("from", fromArg);
    const to = await resolveOrg("to", toArg);
    if (from.id === to.id) throw new Error("--from and --to are the same organization");
    console.log(`FROM: ${from.name} (${from.id})\nTO:   ${to.name} (${to.id})\nMODE: ${APPLY ? "APPLY (will commit)" : "DRY RUN (will roll back)"}\nOPERATOR: ${operator}\n`);

    const snapshot = async () => (await one<{ k: string; n: string }>(
      `select 'src_contacts' k, count(*) n from contacts where org_id=$1 and deleted_at is null
       union all select 'src_enrollments', count(*) from enrollments where org_id=$1
       union all select 'tgt_contacts', count(*) from contacts where org_id=$2 and deleted_at is null
       union all select 'tgt_enrollments', count(*) from enrollments where org_id=$2
       union all select 'tgt_duplicate_mbi_groups', count(*) from (
         select medicare_id_hash from contacts where org_id=$2 and medicare_id_hash is not null
         group by 1 having count(*) > 1) d`, [from.id, to.id]))
      .reduce<Record<string, number>>((a, r) => ({ ...a, [r.k]: Number(r.n) }), {});
    const before = await snapshot();

    // ── 1. Who is already in the target (live or soft-deleted)? ─────────────
    await db.query(`create function pg_temp.pn(p text) returns text language sql immutable as $f$
      select case when p is null then null else (
        select case when length(d) = 11 and left(d, 1) = '1' then substr(d, 2) when length(d) = 10 then d else null end
        from (select regexp_replace(regexp_replace(p, '\\s*(x|ext\\.?|extension)\\s*\\d+\\s*$', '', 'i'), '\\D', '', 'g') d) x) end $f$`);

    // Medicare IDs: decrypt the source's, then check every spelling the app could have hashed.
    await db.query(`create temp table src_mbi (id text, h bytea) on commit drop`);
    const enc = await one<{ id: string; e: Buffer; h: Buffer | null }>(
      `select id, medicare_id_encrypted e, medicare_id_hash h from contacts where org_id = $1 and deleted_at is null and (medicare_id_encrypted is not null or medicare_id_hash is not null)`, [from.id]);
    const ids: string[] = [];
    const hashes: string[] = [];
    const undecryptable: string[] = [];
    const hashOnlyIds = new Set<string>();
    for (const r of enc) {
      const set = new Set<string>();
      if (r.h) set.add(Buffer.from(r.h).toString("hex"));
      if (r.e) {
        try {
          for (const h of mbiCandidateHashes(decryptMedicareId(r.e))) set.add(h.toString("hex"));
        } catch {
          undecryptable.push(r.id);
        }
      } else if (r.h) {
        // Only the hash is on file: the other spelling of this MBI cannot be derived.
        hashOnlyIds.add(r.id);
      }
      for (const h of set) { ids.push(r.id); hashes.push(h); }
    }
    if (undecryptable.length) {
      throw new Error(`Could not decrypt the Medicare ID on ${undecryptable.length} source contact(s) with the PHI_* keys in this environment (contact ids: ${undecryptable.slice(0, 20).join(", ")}${undecryptable.length > 20 ? ", ..." : ""}). Use the same PHI_ENCRYPTION_KEY / PHI_HMAC_KEY as the app, or repair those rows, then re-run.`);
    }
    for (let i = 0; i < ids.length; i += 5000) {
      await db.query(`insert into src_mbi select i, decode(h, 'hex') from unnest($1::text[], $2::text[]) as u(i, h)`, [ids.slice(i, i + 5000), hashes.slice(i, i + 5000)]);
    }

    const sameName = `lower(s.first_name) = lower(t.first_name)
      and (case when s.dob is not null and t.dob is not null then s.dob = t.dob else lower(s.last_name) = lower(t.last_name) end)`;
    const reasons: { reason: string; sql: string }[] = [
      { reason: "Medicare ID", sql: `select m.id src, t.id tgt from src_mbi m join contacts t on t.org_id = $2 and t.medicare_id_hash = m.h where $1::text is not null` },
      { reason: "email + name", sql: `select s.id src, t.id tgt from contacts s join contacts t on lower(t.email) = lower(s.email) and t.org_id = $2
          where s.org_id = $1 and s.deleted_at is null and s.email is not null and ${sameName}` },
      { reason: "phone + name", sql: `select s.id src, t.id tgt from contacts s join contacts t on pg_temp.pn(t.phone) = pg_temp.pn(s.phone) and t.org_id = $2
          where s.org_id = $1 and s.deleted_at is null and pg_temp.pn(s.phone) is not null and ${sameName}` },
      { reason: "name + date of birth", sql: `select s.id src, t.id tgt from contacts s join contacts t
          on lower(t.first_name) = lower(s.first_name) and lower(t.last_name) = lower(s.last_name) and t.dob = s.dob and t.org_id = $2
          where s.org_id = $1 and s.deleted_at is null and s.dob is not null` },
    ];
    const matchMap = new Map<string, { src: string; tgt: string; reason: string }>();
    for (const r of reasons) { // priority order: first reason wins
      for (const m of await one<{ src: string; tgt: string }>(r.sql, [from.id, to.id])) {
        if (!matchMap.has(m.src)) matchMap.set(m.src, { ...m, reason: r.reason });
      }
    }
    const matches = [...matchMap.values()];
    // Written only once the outcome is known, and named for it, so a file can never be mistaken for a record of a move that did not happen.
    const csvName = `move-clients-already-in-target-${Date.now()}.${APPLY ? "applied" : "dryrun"}.csv`;
    const csvBody = ["source_contact_id,target_contact_id,matched_on", ...matches.map((m) => `${m.src},${m.tgt},${m.reason}`)].join("\n") + "\n";

    await db.query(`create temp table mv_contacts (id text primary key) on commit drop`);
    await db.query(
      `insert into mv_contacts select id from contacts where org_id = $1 and deleted_at is null and id <> all($2::text[])`,
      [from.id, matches.map((m) => m.src)]);
    const toMove = Number((await one<{ n: string }>(`select count(*) n from mv_contacts`))[0]!.n);
    const hashOnly = [...hashOnlyIds].filter((id) => !matchMap.has(id)).length;

    // ── 2. Discover everything that hangs off a client ──────────────────────
    const orgTables = new Set((await one<{ t: string }>(
      `select table_name t from information_schema.columns where table_schema='public' and column_name='org_id'`)).map((r) => r.t));
    const idTables = new Set((await one<{ t: string }>(
      `select table_name t from information_schema.columns where table_schema='public' and column_name='id'`)).map((r) => r.t));
    const fks = await one<Edge>(
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
    const norm = (c: string) => `regexp_replace(lower(trim(${c})), '\\s+', ' ', 'g')`;
    type SrcCarrier = { id: string; name: string; cms_contract_number: string | null; logo_url: string | null; is_active: boolean };
    const used = new Map<string, SrcCarrier>();
    for (const r of carrierRefs) {
      for (const c of await one<SrcCarrier>(
        `select s.id, s.name, s.cms_contract_number, s.logo_url, s.is_active from carriers s
         where s.org_id = $1 and s.id in (select ${q(r.col)} from ${q(r.child)} where id in (select id from ${mv.get(r.child)}))`, [from.id])) used.set(c.id, c);
    }
    // Two source carriers that collapse to one name must agree on their metadata, or we'd silently drop one.
    const byName = new Map<string, SrcCarrier[]>();
    const jsNorm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    for (const c of used.values()) byName.set(jsNorm(c.name), [...(byName.get(jsNorm(c.name)) ?? []), c]);
    for (const [name, group] of byName) {
      const key = (c: SrcCarrier) => `${c.cms_contract_number ?? ""}|${c.is_active}|${c.logo_url ?? ""}`;
      if (group.length > 1 && new Set(group.map(key)).size > 1) {
        throw new Error(`Carriers "${name}" exist more than once in the source with different contract number / active flag / logo (${group.map((c) => c.id).join(", ")}). Merge them in the source first.`);
      }
    }
    let carriersCreated = 0;
    for (const group of byName.values()) {
      const c = group[0]!;
      const exists = await one(`select 1 from carriers where org_id = $1 and ${norm("name")} = $2`, [to.id, jsNorm(c.name)]);
      if (exists.length) continue;
      await db.query(
        `insert into carriers (id, org_id, name, cms_contract_number, logo_url, is_active) values ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), to.id, c.name.trim().replace(/\s+/g, " "), c.cms_contract_number, c.logo_url, c.is_active]);
      carriersCreated++;
    }
    // Two of one client's policies must not collapse onto the same target carrier.
    if (mv.has("enrollments") && fks.some((f) => f.child === "enrollments" && f.col === "carrier_id" && f.parent === "carriers")) {
      const clash = await one<{ contact_id: string; plan_year: number; plan_type: string; names: string[] }>(
        `select e.contact_id, e.plan_year, e.plan_type, array_agg(distinct sc.name) names
         from enrollments e join carriers sc on sc.id = e.carrier_id and sc.org_id = $1
         left join carriers tc on tc.org_id = $2 and ${norm("tc.name")} = ${norm("sc.name")}
         where e.id in (select id from ${mv.get("enrollments")})
         group by e.contact_id, e.plan_year, e.plan_type, coalesce(tc.id, sc.id) having count(*) > 1`, [from.id, to.id]);
      if (clash.length) {
        throw new Error(`${clash.length} client(s) have two ${clash[0]!.plan_type} policies for ${clash[0]!.plan_year} with carriers that become one carrier in the target (${clash[0]!.names.join(" / ")}). Consolidate those policies in the source first.`);
      }
    }

    // ── 4. Move the rows ────────────────────────────────────────────────────
    const moved: Record<string, number> = {};
    const contactsMoved = await db.query(`update contacts set org_id = $2 where org_id = $1 and id in (select id from mv_contacts)`, [from.id, to.id]);
    moved.contacts = contactsMoved.rowCount ?? 0;
    for (const j of jobs) {
      try {
        const r = await db.query(
          `update ${q(j.child)} set org_id = $2 where org_id = $1 and ${q(j.col)}::text in (select id from ${mv.get(j.parent)})`, [from.id, to.id]);
        moved[j.child] = (moved[j.child] ?? 0) + (r.rowCount ?? 0);
      } catch (e) {
        const pgErr = e as { code?: string; constraint?: string; detail?: string };
        if (pgErr.code !== "23505") throw e;
        // Names the table, constraint and key columns, never the values (they can be PHI).
        const keyCols = /Key \(([^)]*)\)=/.exec(pgErr.detail ?? "")?.[1] ?? "unknown columns";
        throw new Error(`Moving ${j.child} would break unique constraint "${pgErr.constraint}" on (${keyCols}): a moved row has the same key as a row already in the target agency. Resolve those ${j.child} rows first, then re-run.`);
      }
    }
    for (const [t, tmp] of mv) {
      if (t === "contacts") continue;
      const stragglers = await one<{ n: string }>(`select count(*) n from ${q(t)} where org_id = $1 and id in (select id from ${tmp})`, [from.id]);
      if (Number(stragglers[0]!.n) > 0) throw new Error(`${stragglers[0]!.n} rows in ${t} did not move`);
    }

    // ── 5. Re-point references that must not cross agencies ─────────────────
    const remapped: Record<string, number> = {};
    const sharedParents = new Set<string>();
    const blockers: string[] = [];
    const allowShared = new Set(process.argv.flatMap((a, i, all) => (a === "--allow-shared-parent" && all[i + 1] ? [all[i + 1]!] : [])));
    for (const [t, tmp] of mv) {
      for (const f of fks.filter((x) => x.child === t && x.col !== "org_id" && !mv.has(x.parent))) {
        const where = `id in (select id from ${tmp}) and ${q(f.col)} is not null`;
        if (f.parent === "carriers" || f.parent === "agents") {
          const key = f.parent === "carriers" ? norm("{a}.name") : "lower({a}.email)";
          const match = `select t.id from ${f.parent} s join ${f.parent} t on t.org_id = $2 and ${key.replace(/\{a\}/g, "t")} = ${key.replace(/\{a\}/g, "s")} where s.id = ${q(t)}.${q(f.col)} limit 1`;
          const stale = `exists (select 1 from ${f.parent} s where s.id = ${q(t)}.${q(f.col)} and s.org_id = $1)`;
          if (f.notNull) {
            const bad = await one<{ n: string }>(`select count(*) n from ${q(t)} where ${where} and ${stale} and not exists (${match})`, [from.id, to.id]);
            if (Number(bad[0]!.n) > 0) {
              blockers.push(`${t}.${f.col}: ${bad[0]!.n} rows need a ${f.parent} match in the target agency (none by ${f.parent === "agents" ? "email" : "name"}). Create or match it there first.`);
              continue; // the update below would null a required column and mask this message
            }
          }
          const r = await db.query(`update ${q(t)} set ${q(f.col)} = (${match}) where ${where} and ${stale}`, [from.id, to.id]);
          if (r.rowCount) remapped[`${t}.${f.col} -> ${f.parent}`] = r.rowCount;
        } else if (orgTables.has(f.parent)) {
          const foreign = `not exists (select 1 from ${q(f.parent)} p where p.id = ${q(t)}.${q(f.col)} and p.org_id = $1)`;
          const n = Number((await one<{ n: string }>(`select count(*) n from ${q(t)} where ${where} and ${foreign}`, [to.id]))[0]!.n);
          if (n === 0) continue;
          if (f.notNull) {
            blockers.push(`${t}.${f.col} (-> ${f.parent}): ${n} rows are required to point at the source agency's ${f.parent}. Detach or remove those records first.`);
            continue;
          }
          await db.query(`update ${q(t)} set ${q(f.col)} = null where ${where} and ${foreign}`, [to.id]);
          remapped[`${t}.${f.col} -> ${f.parent} (cleared)`] = n;
        } else if (f.parent !== "organizations") {
          // The parent has no agency of its own, so we cannot tell whether the row it points at is the source's. Refuse unless allowed.
          const n = Number((await one<{ n: string }>(`select count(*) n from ${q(t)} where ${where}`))[0]!.n);
          if (n === 0) continue;
          const edge = `${t}.${f.col}`;
          if (allowShared.has(edge)) sharedParents.add(`${edge} -> ${f.parent} (allowed)`);
          else blockers.push(`${edge} (-> ${f.parent}): ${n} rows point at a table that is not owned by an agency, so they cannot be checked. If that is intended, re-run with --allow-shared-parent ${edge}.`);
        }
      }
    }
    if (blockers.length) {
      throw new Error(`${blockers.length} blocker(s) prevent a safe move:\n  - ${blockers.join("\n  - ")}`);
    }

    // ── 6. Invariants, report, audit ────────────────────────────────────────
    // No moved row may still point at a source-agency row.
    for (const [t, tmp] of mv) {
      for (const f of fks.filter((x) => x.child === t && x.col !== "org_id" && !mv.has(x.parent) && orgTables.has(x.parent))) {
        const leak = await one<{ n: string }>(
          `select count(*) n from ${q(t)} c join ${q(f.parent)} p on p.id = c.${q(f.col)} where c.id in (select id from ${tmp}) and p.org_id = $1`, [from.id]);
        if (Number(leak[0]!.n) > 0) throw new Error(`${leak[0]!.n} rows in ${t}.${f.col} still point at the source agency's ${f.parent}`);
      }
    }
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
    if (sharedParents.size) console.log(`Left pointing at shared (non-agency) tables: ${[...sharedParents].join(", ")}`);
    if (hashOnly > 0) console.log(`WARNING: ${hashOnly} client(s) to move have a Medicare ID hash but no stored Medicare ID, so only the exact spelling could be checked for duplicates. The duplicate-Medicare-ID check below compares the same raw hashes, so it will NOT catch a dashed-vs-undashed duplicate either. Check the target for same-name, same-birthdate pairs yourself, or backfill the stored IDs first.`);
    console.log(`Source contacts/enrollments:    ${before.src_contacts}/${before.src_enrollments}  ->  ${after.src_contacts}/${after.src_enrollments}`);
    console.log(`Target contacts/enrollments:    ${before.tgt_contacts}/${before.tgt_enrollments}  ->  ${after.tgt_contacts}/${after.tgt_enrollments}`);
    console.log(`Duplicate Medicare-ID groups in target: ${before.tgt_duplicate_mbi_groups} -> ${after.tgt_duplicate_mbi_groups}`);

    if (APPLY && hashOnly > 0 && !process.argv.includes("--allow-hash-only")) {
      throw new Error(`${hashOnly} client(s) to move have a Medicare ID hash but no stored Medicare ID, so a dashed-vs-undashed duplicate cannot be ruled out. Run an encryption backfill, or re-run with --allow-hash-only to accept that.`);
    }
    if (APPLY) {
      const changes = JSON.stringify({ operator, fromOrgId: from.id, toOrgId: to.id, movedRows: moved, leftInPlace: matches.length, carriersCreated, dedupCsv: csvName,
        // Ids and reasons only (no PHI), so the record survives even if the CSV could not be written.
        dedupPairs: matches.map((m) => ({ src: m.src, tgt: m.tgt, reason: m.reason })) });
      for (const orgId of [from.id, to.id]) {
        await db.query(
          `insert into audit_log (id, org_id, user_role, action, resource_type, changes) values ($1, $2, 'system', 'cross_org_client_move', 'contact', $3::jsonb)`,
          [randomUUID(), orgId, changes]);
      }
      await db.query("COMMIT");
      console.log("\nCOMMITTED.");
      committed = true;
      // The move is done and audited; a file problem must not read as a failed move.
      try {
        writeFileSync(csvName, csvBody);
        console.log(`Clients left in place (already in target): ${csvName}`);
      } catch (fsErr) {
        console.error(`WARNING: the move committed (see audit_log) but ${csvName} could not be written: ${(fsErr as Error).message}`);
      }
    } else {
      await db.query("ROLLBACK");
      console.log("\nDRY RUN: rolled back, nothing changed. Re-run with --apply to commit.");
      try {
        writeFileSync(csvName, csvBody);
        console.log(`Clients that would be left in place (already in target): ${csvName}`);
      } catch (fsErr) {
        console.error(`WARNING: could not write ${csvName}: ${(fsErr as Error).message}`);
      }
    }
  } catch (err) {
    if (committed) {
      console.error("\nWARNING (the move itself had already committed):", (err as Error).message);
    } else {
      await db.query("ROLLBACK").catch(() => undefined);
      console.error("\nABORTED, nothing changed:", (err as Error).message);
      process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

void main();
