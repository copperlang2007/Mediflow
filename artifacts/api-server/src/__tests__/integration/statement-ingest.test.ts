/**
 * Automatic statement intake, end to end against the in-process Postgres.
 *
 * A fake StatementSource stands in for Drive; the real parse, line-item insert,
 * reconcile and ledger code all run.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, clerkF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  clerkF: async (): Promise<Record<string, unknown>> => {
    const { clerkMockFactory } = await import("../helpers/testApp");
    return clerkMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  carriersTable,
  contactsTable,
  commissionLineItemsTable,
  commissionStatementsTable,
  notificationsTable,
  statementIngestFilesTable,
  statementIngestSourcesTable,
  type StatementIngestSource,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, clearEnqueuedJobs } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact, seedAgent } from "../helpers/testDb";
import type { SourceFile, StatementSource } from "../../lib/statementIngest/types";

let ingestFile: typeof import("../../lib/statementIngest/ingest").ingestFile;
let approveHeldFile: typeof import("../../lib/statementIngest/ingest").approveHeldFile;
let pollWorker: typeof import("../../workers/statementIngestPoll").statementIngestPollWorker;

const stored: string[] = [];
const deps = () => ({
  storeFile: async (_c: Buffer, name: string, orgId: string) => {
    stored.push(name);
    return `/objects/documents/${orgId}/${randomUUID()}/${name}`;
  },
  reconcile: (async (...a: Parameters<typeof import("../../workers/reconcileCommissionStatement").reconcileStatement>) =>
    (await import("../../workers/reconcileCommissionStatement")).reconcileStatement(...a)),
});

/** Humana's headerless pipe layout: policy|last|member|first|dob|state|plan|year|start|end|premium|commission|type */
function humanaFile(rows: Array<{ member: string; amount: string; type?: string }>): Buffer {
  return Buffer.from(
    rows
      .map((r, i) =>
        [`POL${i}`, "Doe", r.member, "Jane", "1/2/1950", "TX", "MAPD", "2026", "9/1/2026", "9/30/2026", "100.00", r.amount, r.type ?? "NEW"].join("|"),
      )
      .join("\n"),
  );
}

class FakeSource implements StatementSource {
  contents = new Map<string, Buffer>();
  files: SourceFile[] = [];
  downloads = 0;
  add(name: string, content: Buffer, over: Partial<SourceFile> = {}): SourceFile {
    const f: SourceFile = {
      externalId: over.externalId ?? `ext-${randomUUID()}`,
      name,
      folderName: over.folderName ?? "Humana",
      checksum: over.checksum ?? `sum-${randomUUID()}`,
      modifiedTime: over.modifiedTime ?? new Date("2026-10-02T12:00:00Z"),
      sizeBytes: over.sizeBytes ?? content.length,
      downloadable: over.downloadable ?? true,
    };
    this.files.push(f);
    this.contents.set(`${f.externalId}|${f.checksum}`, content);
    return f;
  }
  async list(): Promise<SourceFile[]> { return [...this.files]; }
  async download(f: SourceFile): Promise<Buffer> {
    this.downloads += 1;
    return this.contents.get(`${f.externalId}|${f.checksum}`)!;
  }
}

let orgId: string;
let humanaId: string;

async function newSource(mode: "hold" | "auto", over: Partial<StatementIngestSource> = {}): Promise<StatementIngestSource> {
  const { db } = await bootTestDb();
  const [row] = await db
    .insert(statementIngestSourcesTable)
    .values({ id: randomUUID(), orgId, kind: "drive", folderId: `folder-${randomUUID()}`, mode, ...over })
    .returning();
  return row;
}

/** A client the reconcile worker can fully match: known member id AND an assigned writing agent. */
async function seedMatchableMember(): Promise<string> {
  const { db } = await bootTestDb();
  const agent = await seedAgent(db, { orgId });
  const contact = await seedContact(db, { orgId, medicareId: `MBI-${randomUUID()}` });
  await db.update(contactsTable).set({ assignedAgentId: agent.id }).where(eq(contactsTable.id, contact.id));
  return contact.medicareId!;
}

async function ledger(sourceId: string) {
  const { db } = await bootTestDb();
  return db.select().from(statementIngestFilesTable).where(eq(statementIngestFilesTable.sourceId, sourceId));
}

beforeAll(async () => {
  const handle = await bootTestDb();
  ({ ingestFile, approveHeldFile } = await import("../../lib/statementIngest/ingest"));
  ({ statementIngestPollWorker: pollWorker } = await import("../../workers/statementIngestPoll"));
  const org = await seedOrg(handle.db, { id: `ingest-org-${randomUUID()}` });
  orgId = org.id;
  await seedUser(handle.db, { orgId, role: "agency_admin", id: `ingest-admin-${randomUUID()}` });
  humanaId = `carrier-${randomUUID()}`;
  await handle.db.insert(carriersTable).values({ id: humanaId, orgId, name: "Humana", isActive: true });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
  stored.length = 0;
});

describe("ingestFile", () => {
  it("hold mode: creates a parsed statement with its lines and waits for approval", async () => {
    const { db } = await bootTestDb();
    const source = await newSource("hold");
    const from = new FakeSource();
    const f = from.add("Humana_2026-09.csv", humanaFile([{ member: "M1", amount: "50.00" }, { member: "M2", amount: "75.50" }]));

    expect(await ingestFile(source, f, from, deps())).toBe("held");

    const [row] = await ledger(source.id);
    expect(row).toMatchObject({ status: "held", lineCount: 2, fileName: "Humana_2026-09.csv" });
    const [stmt] = await db.select().from(commissionStatementsTable).where(eq(commissionStatementsTable.id, row.statementId!));
    expect(stmt).toMatchObject({
      carrierId: humanaId,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      status: "parsed",
      source: "api",
      totalAmount: null,
      statementDate: "2026-10-02",
    });
    expect(stmt.storageKey).toContain("Humana_2026-09.csv");
    const lines = await db.select().from(commissionLineItemsTable).where(eq(commissionLineItemsTable.statementId, stmt.id));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.matchStatus === "unmatched")).toBe(true);
  });

  it("approve reconciles the held statement exactly once", async () => {
    const { db } = await bootTestDb();
    const source = await newSource("hold");
    const from = new FakeSource();
    const member = await seedMatchableMember();
    const f = from.add("Humana_2026-08.csv", humanaFile([{ member, amount: "40.00" }]));
    await ingestFile(source, f, from, deps());
    const [row] = await ledger(source.id);

    expect(await approveHeldFile(orgId, row.id, deps())).toBe("approved");
    const [after] = await ledger(source.id);
    expect(after).toMatchObject({ status: "approved", matchedCount: 1, unmatchedCount: 0 });
    const [stmt] = await db.select().from(commissionStatementsTable).where(eq(commissionStatementsTable.id, row.statementId!));
    expect(stmt.status).toBe("reconciled");

    // A second click must not reconcile again.
    expect(await approveHeldFile(orgId, row.id, deps())).toBeNull();
  });

  it("approve is scoped to the org", async () => {
    const source = await newSource("hold");
    const from = new FakeSource();
    await ingestFile(source, from.add("Humana_2026-07.csv", humanaFile([{ member: "MX", amount: "1.00" }])), from, deps());
    const [row] = await ledger(source.id);
    expect(await approveHeldFile("some-other-org", row.id, deps())).toBeNull();
    expect((await ledger(source.id))[0].status).toBe("held");
  });

  it("auto mode: reconciles straight away and records the counts", async () => {
    const { db } = await bootTestDb();
    const source = await newSource("auto");
    const from = new FakeSource();
    const member = await seedMatchableMember();
    const f = from.add("Humana_2026-06.csv", humanaFile([{ member, amount: "20.00" }]));

    expect(await ingestFile(source, f, from, deps())).toBe("ingested");
    const [row] = await ledger(source.id);
    expect(row).toMatchObject({ status: "ingested", matchedCount: 1, unmatchedCount: 0 });
  });

  it("auto mode flags a statement where most lines match no client", async () => {
    const source = await newSource("auto");
    const from = new FakeSource();
    const f = from.add("Humana_2026-05.csv", humanaFile([
      { member: "NOPE1", amount: "10.00" }, { member: "NOPE2", amount: "10.00" },
    ]));
    expect(await ingestFile(source, f, from, deps())).toBe("needs_review");
    const [row] = await ledger(source.id);
    expect(row.reason).toMatch(/did not match a client/);
    expect(row.statementId).not.toBeNull();
  });

  it("a re-listed file is processed once", async () => {
    const source = await newSource("hold");
    const from = new FakeSource();
    const f = from.add("Humana_2026-04.csv", humanaFile([{ member: "M1", amount: "5.00" }]));
    expect(await ingestFile(source, f, from, deps())).toBe("held");
    expect(await ingestFile(source, f, from, deps())).toBe("skipped_seen");
    expect(from.downloads).toBe(1);
    expect(await ledger(source.id)).toHaveLength(1);
  });

  it("a file replaced in place is held for review instead of silently re-applied", async () => {
    const { db } = await bootTestDb();
    const source = await newSource("auto");
    const from = new FakeSource();
    const externalId = `ext-${randomUUID()}`;
    const v1 = from.add("Humana_2026-03.csv", humanaFile([{ member: "M1", amount: "5.00" }]), { externalId, checksum: "v1" });
    await ingestFile(source, v1, from, deps());
    const v2 = from.add("Humana_2026-03.csv", humanaFile([{ member: "M1", amount: "9.00" }]), { externalId, checksum: "v2" });

    expect(await ingestFile(source, v2, from, deps())).toBe("needs_review");
    const rows = await ledger(source.id);
    expect(rows.find((r) => r.checksum === "v2")!.reason).toMatch(/already exists/);
    const stmts = await db.select().from(commissionStatementsTable).where(eq(commissionStatementsTable.carrierId, humanaId));
    expect(stmts.filter((s) => s.periodStart === "2026-03-01")).toHaveLength(1);
  });

  it.each([
    ["unknown carrier", "statement_2026-09.csv", "Inbox", /Could not tell which carrier/],
    ["unsupported type", "Humana_2026-09.pdf", "Humana", /Unsupported file type/],
    ["no period", "Humana.csv", "Humana", /statement period/],
  ])("sends %s to review without creating a statement", async (_label, name, folder, reason) => {
    const { db } = await bootTestDb();
    const before = (await db.select().from(commissionStatementsTable)).length;
    const source = await newSource("auto");
    const from = new FakeSource();
    // No period in the lines either: blank dates.
    const content = Buffer.from("POL1|Doe|M1|Jane|1/2/1950|TX|MAPD|2026|||100.00|5.00|NEW");
    const f = from.add(name, content, { folderName: folder });
    expect(await ingestFile(source, f, from, deps())).toBe("needs_review");
    expect((await ledger(source.id))[0].reason).toMatch(reason);
    expect((await db.select().from(commissionStatementsTable)).length).toBe(before);
    expect(stored).toHaveLength(0);
  });

  it("an empty file is flagged", async () => {
    const source = await newSource("auto");
    const from = new FakeSource();
    const f = from.add("Humana_2026-02.csv", Buffer.from(""));
    expect(await ingestFile(source, f, from, deps())).toBe("needs_review");
    expect((await ledger(source.id))[0].reason).toMatch(/no commission lines/);
  });

  it("a storage failure leaves no statement behind and is recorded as failed", async () => {
    const { db } = await bootTestDb();
    const source = await newSource("hold");
    const from = new FakeSource();
    const f = from.add("Humana_2026-01.csv", humanaFile([{ member: "M1", amount: "5.00" }]));
    const failing = { ...deps(), storeFile: async () => { throw new Error("bucket down"); } };

    expect(await ingestFile(source, f, from, failing)).toBe("failed");
    const [row] = await ledger(source.id);
    expect(row.statementId).toBeNull();
    // The reason must not echo the underlying message (could carry file content).
    expect(row.reason).toBe("Unexpected error: Error");
    const stmts = await db.select().from(commissionStatementsTable).where(eq(commissionStatementsTable.carrierId, humanaId));
    expect(stmts.filter((s) => s.periodStart === "2026-01-01")).toHaveLength(0);
  });

  it("an explicit folder mapping routes a folder the names cannot identify", async () => {
    const source = await newSource("hold", { carrierFolderMap: { "Q3 Payments": humanaId } });
    const from = new FakeSource();
    const f = from.add("2025-10.csv", humanaFile([{ member: "M1", amount: "5.00" }]), { folderName: "Q3 Payments" });
    // Neither "Q3 Payments" nor "2025-10.csv" names a carrier; the mapping carries it.
    expect(await ingestFile(source, f, from, deps())).toBe("held");
  });
});

describe("statementIngestPollWorker", () => {
  it("processes new files once across repeated polls and notifies reviewers about flagged ones", async () => {
    const { db } = await bootTestDb();
    const source = await newSource("hold");
    const from = new FakeSource();
    from.add("Humana_2025-12.csv", humanaFile([{ member: "M1", amount: "5.00" }]));
    from.add("notes.pdf", Buffer.from("x"));

    await pollWorker({ sourceId: source.id }, { makeSource: () => from, ingest: deps() });
    let rows = await ledger(source.id);
    expect(rows.map((r) => r.status).sort()).toEqual(["held", "needs_review"]);

    await pollWorker({ sourceId: source.id }, { makeSource: () => from, ingest: deps() });
    rows = await ledger(source.id);
    expect(rows).toHaveLength(2);
    expect(from.downloads).toBe(1);

    const [updated] = await db.select().from(statementIngestSourcesTable).where(eq(statementIngestSourcesTable.id, source.id));
    expect(updated.lastPolledAt).not.toBeNull();
    expect(updated.lastError).toBeNull();

    const notes = await db.select().from(notificationsTable).where(eq(notificationsTable.resourceId, source.id));
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe("statement_ingest_review");
  });

  it("records a listing failure on the source and does not throw", async () => {
    const { db } = await bootTestDb();
    const source = await newSource("hold");
    const broken: StatementSource = {
      list: async () => { throw new Error("403 forbidden"); },
      download: async () => Buffer.alloc(0),
    };
    await pollWorker({ sourceId: source.id }, { makeSource: () => broken, ingest: deps() });
    const [updated] = await db.select().from(statementIngestSourcesTable).where(eq(statementIngestSourcesTable.id, source.id));
    expect(updated.lastError).toContain("403");
  });

  it("skips disabled sources", async () => {
    const source = await newSource("hold", { enabled: false });
    const from = new FakeSource();
    from.add("Humana_2025-11.csv", humanaFile([{ member: "M1", amount: "5.00" }]));
    await pollWorker({ sourceId: source.id }, { makeSource: () => from, ingest: deps() });
    expect(await ledger(source.id)).toHaveLength(0);
  });

  it("caps work per run and queues a continuation", async () => {
    const source = await newSource("hold");
    const from = new FakeSource();
    for (let i = 0; i < 27; i++) from.add(`weird_${i}.pdf`, Buffer.from("x"));
    await pollWorker({ sourceId: source.id }, { makeSource: () => from, ingest: deps() });
    expect(await ledger(source.id)).toHaveLength(25);
    const queued = (globalThis.__TEST_ENQUEUED__ ?? []) as Array<{ name: string; data: { sourceId?: string } }>;
    expect(queued.some((j) => j.name === "statement-ingest-poll" && j.data.sourceId === source.id)).toBe(true);
  });
});
