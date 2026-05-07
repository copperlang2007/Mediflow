import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getAuth } from "@clerk/express";
import { db, usersTable, organizationsTable } from "@workspace/db";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { seedDefaultCarriers } from "../lib/carrierSeed";

const ProvisionSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1).max(100),
  orgName: z.string().min(1).max(100).optional(),
  orgSlug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
});

const router: IRouter = Router();

router.post("/auth/provision", async (req: Request, res: Response): Promise<void> => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const clerkUserId = auth.userId;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, clerkUserId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(usersTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(usersTable.id, clerkUserId));

    res.json({ user: existing[0], isNew: false });
    return;
  }

  const bodyParsed = ProvisionSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid request body", details: bodyParsed.error.issues });
    return;
  }

  const { email, fullName, orgName, orgSlug } = bodyParsed.data;

  const orgId = randomUUID();
  const slug = orgSlug ?? orgName?.toLowerCase().replace(/[^a-z0-9]/g, "-") ?? orgId;

  const [org] = await db
    .insert(organizationsTable)
    .values({
      id: orgId,
      name: orgName ?? `${fullName}'s Agency`,
      slug: `${slug}-${orgId.slice(0, 8)}`,
      planTier: "starter",
    })
    .returning();

  const [user] = await db
    .insert(usersTable)
    .values({
      id: clerkUserId,
      orgId: org.id,
      email,
      fullName,
      role: "agency_admin",
      isActive: true,
      lastLoginAt: new Date(),
    })
    .returning();

  // Seed the default Medicare carriers so the Carrier Certification Matrix
  // works out of the box. Failures here shouldn't block provisioning — admins
  // can re-run via POST /carriers/seed.
  try {
    const seeded = await seedDefaultCarriers(org.id);
    logger.info({ orgId: org.id, seeded }, "Seeded default carriers for new org");
  } catch (err) {
    logger.error({ err, orgId: org.id }, "Failed to seed default carriers");
  }

  logger.info({ userId: user.id, orgId: org.id }, "New user provisioned");

  res.status(201).json({ user, org, isNew: true });
});

export default router;
