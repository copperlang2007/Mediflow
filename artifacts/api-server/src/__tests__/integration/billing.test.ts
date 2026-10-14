/**
 * Billing — entitlements, plan enforcement, and route contracts.
 *
 * The properties worth pinning here are the ones that cost money or leak
 * product when they break:
 *
 *  - An unconfigured deployment grants everything (demo installs must work).
 *  - A configured deployment with no subscription grants only Starter.
 *  - A delinquent subscription loses its paid tier.
 *  - Record limits are enforced at the creation route, not merely advertised.
 *  - Only the roles that own the agency's money can read or change billing.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

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

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { subscriptionsTable, contactsTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, type TestDb } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let agent: { id: string };

/** Applies a subscription state to the test org and clears the 30s cache. */
async function setSubscription(values: {
  planTier: "starter" | "growth" | "agency";
  status: string;
  seats?: number;
}): Promise<void> {
  const { invalidateEntitlements } = await import(
    "../../lib/billing/entitlements"
  );
  await testDb
    .insert(subscriptionsTable)
    .values({
      id: `sub-${randomUUID()}`,
      orgId: org.id,
      planTier: values.planTier,
      status: values.status as never,
      seats: values.seats ?? 3,
    })
    .onConflictDoUpdate({
      target: subscriptionsTable.orgId,
      set: {
        planTier: values.planTier,
        status: values.status as never,
        seats: values.seats ?? 3,
      },
    });
  invalidateEntitlements(org.id);
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as never as { default: typeof import("supertest") }).default;

  org = await seedOrg(testDb, { id: "billing-test-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  agent = await seedUser(testDb, { orgId: org.id, role: "agent" });
});

afterAll(async () => {
  await shutdownTestDb();
  delete process.env.STRIPE_SECRET_KEY;
});

beforeEach(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
  const { resetEntitlementsCacheForTests } = await import(
    "../../lib/billing/entitlements"
  );
  resetStripeClientForTests();
  resetEntitlementsCacheForTests();
});

describe("entitlements", () => {
  it("grants the full plan when the deployment has no Stripe keys", async () => {
    // A design-partner or demo install must not be crippled by the absence of
    // a payment processor it was never given.
    const { getEntitlements } = await import("../../lib/billing/entitlements");
    const ent = await getEntitlements(org.id);

    expect(ent.tier).toBe("agency");
    expect(ent.billingConfigured).toBe(false);
    expect(ent.unbilledGrant).toBe(true);
    expect(ent.plan.limits.agents).toBeNull();
  });

  it("grants only Starter when billing IS configured but the org has never paid", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    const { getEntitlements, resetEntitlementsCacheForTests } = await import(
      "../../lib/billing/entitlements"
    );
    resetStripeClientForTests();
    resetEntitlementsCacheForTests();

    await setSubscription({ planTier: "starter", status: "none" });
    const ent = await getEntitlements(org.id);

    expect(ent.tier).toBe("starter");
    expect(ent.unbilledGrant).toBe(false);
    expect(ent.plan.limits.features.commissionReconciliation).toBe(false);
  });

  it("keeps the paid tier while Stripe is still retrying the card (past_due)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    const { getEntitlements, resetEntitlementsCacheForTests } = await import(
      "../../lib/billing/entitlements"
    );
    resetStripeClientForTests();
    resetEntitlementsCacheForTests();

    await setSubscription({ planTier: "growth", status: "past_due" });
    expect((await getEntitlements(org.id)).tier).toBe("growth");
  });

  it("drops a canceled subscription back to Starter", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    const { getEntitlements, resetEntitlementsCacheForTests } = await import(
      "../../lib/billing/entitlements"
    );
    resetStripeClientForTests();
    resetEntitlementsCacheForTests();

    await setSubscription({ planTier: "agency", status: "canceled" });
    const ent = await getEntitlements(org.id);

    expect(ent.tier).toBe("starter");
    expect(ent.plan.limits.features.voiceStack).toBe(false);
  });
});

describe("plan limit enforcement", () => {
  it("refuses to create a contact past the Starter cap and says how to lift it", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    const { resetEntitlementsCacheForTests } = await import(
      "../../lib/billing/entitlements"
    );
    resetStripeClientForTests();
    resetEntitlementsCacheForTests();

    await setSubscription({ planTier: "starter", status: "none" });

    // Seed the org right up to the Starter contact cap (250).
    const { PLANS } = await import("../../lib/billing/plans");
    const cap = PLANS.starter.limits.contacts as number;
    const existing = await testDb
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(eq(contactsTable.orgId, org.id));

    const rows = Array.from({ length: cap - existing.length }, (_, i) => ({
      id: `cap-contact-${i}-${randomUUID()}`,
      orgId: org.id,
      firstName: "Cap",
      lastName: `Filler ${i}`,
    }));
    for (let i = 0; i < rows.length; i += 100) {
      await testDb.insert(contactsTable).values(rows.slice(i, i + 100));
    }

    const res = await request(app)
      .post("/api/contacts")
      .set(withAuth(admin.id))
      .send({ firstName: "One", lastName: "TooMany" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("plan_limit_exceeded");
    expect(res.body.limit).toBe(cap);
    // The response must name the tier that lifts the cap, so the UI can render
    // an upgrade prompt without a second round trip.
    expect(res.body.upgradeTo).toBe("growth");
  });

  it("allows the same create once the org is on a plan with headroom", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    const { resetEntitlementsCacheForTests } = await import(
      "../../lib/billing/entitlements"
    );
    resetStripeClientForTests();
    resetEntitlementsCacheForTests();

    await setSubscription({ planTier: "growth", status: "active" });

    const res = await request(app)
      .post("/api/contacts")
      .set(withAuth(admin.id))
      .send({ firstName: "Now", lastName: "Allowed" });

    expect(res.status).toBe(201);
  });
});

describe("billing routes", () => {
  it("returns the plan catalog and current usage to an agency admin", async () => {
    const res = await request(app)
      .get("/api/billing/subscription")
      .set(withAuth(admin.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tier");
    expect(res.body.usage).toHaveProperty("agents");
    expect(res.body.usage).toHaveProperty("contacts");
  });

  it("denies an agent read access to the agency's billing", async () => {
    // Billing is the narrowest matrix in the RBAC system on purpose: an agent
    // administers their book of business, not the agency's money.
    const res = await request(app)
      .get("/api/billing/subscription")
      .set(withAuth(agent.id));

    expect(res.status).toBe(403);
  });

  it("returns 503, not a crash, when checkout is attempted with no Stripe keys", async () => {
    const res = await request(app)
      .post("/api/billing/checkout")
      .set(withAuth(admin.id))
      .send({ tier: "growth" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("billing_unconfigured");
  });

  it("rejects checkout for an unknown tier", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    resetStripeClientForTests();

    const res = await request(app)
      .post("/api/billing/checkout")
      .set(withAuth(admin.id))
      .send({ tier: "enterprise" });

    expect(res.status).toBe(400);
  });
});

describe("stripe webhook", () => {
  it("rejects an unsigned webhook before reading the body", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    resetStripeClientForTests();

    const res = await request(app)
      .post("/webhooks/stripe")
      .send({ id: "evt_forged", type: "customer.subscription.updated" });

    // Anyone who can reach this URL could otherwise grant themselves a plan.
    expect(res.status).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("rejects a webhook carrying a bogus signature", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
    const { resetStripeClientForTests } = await import("../../lib/billing/stripe");
    resetStripeClientForTests();

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "t=1,v1=deadbeef")
      .send({ id: "evt_forged_2", type: "customer.subscription.updated" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
