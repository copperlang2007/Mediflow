/**
 * Recording playback uses an <audio> element pointed at a signed GCS URL, so
 * the helmet CSP must allow that origin in `media-src` (and keep 'self').
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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

import type { Express } from "express";
import { bootTestDb, shutdownTestDb } from "../helpers/testApp";

let app: Express;
let request: typeof import("supertest");

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("CSP media-src", () => {
  it("allows Cloud Storage for audio playback and keeps 'self'", async () => {
    const res = await request(app).get("/api/healthz");
    const csp = String(res.headers["content-security-policy"] ?? "");
    const media = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("media-src "));
    expect(media, csp).toBeDefined();
    expect(media).toContain("https://storage.googleapis.com");
    expect(media).toContain("'self'");
  });
});
