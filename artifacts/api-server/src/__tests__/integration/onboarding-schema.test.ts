/**
 * Migration smoke-test: verifies the 0018 migration created the three
 * onboarding tables + their partial-unique indexes. The pglite snapshot
 * replays every migration, so a missing table here means the migration
 * file itself is broken.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const { dbF, authF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  authF: async (): Promise<Record<string, unknown>> => {
    const { identityMockFactory } = await import("../helpers/testApp");
    return identityMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";

beforeAll(async () => {
  await bootTestDb();
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("migration 0018 — onboarding schema", () => {
  it("creates agent_onboarding_runs table", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relname = 'agent_onboarding_runs'",
    );
    expect(r.rows.length).toBe(1);
  });

  it("creates agent_contracting_profiles table", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relname = 'agent_contracting_profiles'",
    );
    expect(r.rows.length).toBe(1);
  });

  it("creates carrier_contracting_requests table", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relname = 'carrier_contracting_requests'",
    );
    expect(r.rows.length).toBe(1);
  });

  it("creates the partial-unique 'active onboarding per agent' index", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'agent_onboarding_runs_active_per_agent_unique'",
    );
    expect(r.rows.length).toBe(1);
    // Confirm it's actually partial (filtered on cancelled).
    expect(r.rows[0].indexdef).toMatch(/cancelled/);
  });

  it("creates the partial-unique 'active request per carrier' index", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'carrier_contracting_requests_active_per_carrier_unique'",
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].indexdef).toMatch(/cancelled/);
  });

  it("creates the ssn_hash blind-index", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'agent_contracting_profiles_ssn_hash_idx'",
    );
    expect(r.rows.length).toBe(1);
  });
});

describe("migration 0019 — onboarding started_by + contracting task dedup", () => {
  it("adds agent_onboarding_runs.started_by_user_id", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'agent_onboarding_runs' AND column_name = 'started_by_user_id'",
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].data_type).toBe("text");
  });

  it("adds task_instances.contracting_task_key", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'task_instances' AND column_name = 'contracting_task_key'",
    );
    expect(r.rows.length).toBe(1);
  });

  it("creates the partial-unique index for contracting_task_key", async () => {
    const handle = (await bootTestDb()).pg;
    const r = await handle.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'task_instances_contracting_task_key_unique'",
    );
    expect(r.rows.length).toBe(1);
    // Confirm it's partial — only fires when key IS NOT NULL — same idiom
    // as the auto_assign / retention_review_key indexes (migrations 0010,
    // 0011) so the orchestration tasks don't collide with manually-
    // created tasks that have a NULL key.
    expect(r.rows[0].indexdef).toMatch(/contracting_task_key/);
    expect(r.rows[0].indexdef.toLowerCase()).toMatch(/where.*not null/);
  });
});
