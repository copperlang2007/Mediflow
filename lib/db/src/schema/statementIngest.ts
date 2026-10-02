/**
 * Automatic carrier-statement ingestion: a watched folder per org, and a ledger
 * of every file seen in it. See migration 0064.
 */
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./core";
import { commissionStatementsTable } from "./commissions";

export const STATEMENT_INGEST_MODES = ["hold", "auto"] as const;
export type StatementIngestMode = (typeof STATEMENT_INGEST_MODES)[number];

export const STATEMENT_INGEST_FILE_STATUSES = [
  "processing",
  "held",
  "ingested",
  "needs_review",
  "failed",
  "approved",
  "dismissed",
] as const;
export type StatementIngestFileStatus = (typeof STATEMENT_INGEST_FILE_STATUSES)[number];

export const statementIngestSourcesTable = pgTable(
  "statement_ingest_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    kind: text("kind").notNull().default("drive"),
    folderId: text("folder_id").notNull(),
    /** 'hold' = parse then wait for approval; 'auto' = reconcile when all checks pass. */
    mode: text("mode").$type<StatementIngestMode>().notNull().default("hold"),
    enabled: boolean("enabled").notNull().default(true),
    /** Optional explicit { "<folder or file name>": "<carrier id>" } overrides for inference. */
    carrierFolderMap: jsonb("carrier_folder_map")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("statement_ingest_sources_org_folder_key").on(t.orgId, t.kind, t.folderId)],
);

export type StatementIngestSource = typeof statementIngestSourcesTable.$inferSelect;

export const statementIngestFilesTable = pgTable(
  "statement_ingest_files",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => statementIngestSourcesTable.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    checksum: text("checksum").notNull(),
    fileName: text("file_name").notNull(),
    folderName: text("folder_name"),
    status: text("status").$type<StatementIngestFileStatus>().notNull(),
    reason: text("reason"),
    statementId: text("statement_id").references(() => commissionStatementsTable.id, {
      onDelete: "set null",
    }),
    lineCount: integer("line_count"),
    matchedCount: integer("matched_count"),
    unmatchedCount: integer("unmatched_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("statement_ingest_files_source_file_key").on(t.sourceId, t.externalId, t.checksum),
    index("statement_ingest_files_org_status_idx").on(t.orgId, t.status, t.createdAt),
  ],
);

export type StatementIngestFile = typeof statementIngestFilesTable.$inferSelect;
