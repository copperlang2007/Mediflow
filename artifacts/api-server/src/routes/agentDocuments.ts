import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, agentsTable, documentsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

const CreateDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().max(100).default("other"),
  storageKey: z.string().min(1),
  fileSizeBytes: z.number().int().optional(),
  mimeType: z.string().max(100).optional(),
});

router.use(
  auditMiddleware("storage", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.docId ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

async function getAgentOrFail(agentId: string, orgId: string, res: Response): Promise<boolean> {
  const [agent] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return false;
  }
  return true;
}

router.get(
  "/agents/:id/documents",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.agentId, agentId), eq(documentsTable.orgId, authReq.orgId)))
      .orderBy(documentsTable.createdAt);

    res.json(docs);
  },
);

router.post(
  "/agents/:id/documents",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!(await getAgentOrFail(agentId, authReq.orgId, res))) return;

    const parsed = CreateDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const [doc] = await db
      .insert(documentsTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        agentId,
        name: data.name,
        category: data.category,
        storageKey: data.storageKey,
        fileSizeBytes: data.fileSizeBytes ?? null,
        mimeType: data.mimeType ?? null,
        uploadedBy: authReq.userId,
      })
      .returning();

    res.status(201).json(doc);
  },
);

router.delete(
  "/documents/:docId",
  requireAuth,
  requirePermission("agent", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const docId = Array.isArray(req.params.docId) ? req.params.docId[0] : req.params.docId;

    const [deleted] = await db
      .delete(documentsTable)
      .where(and(eq(documentsTable.id, docId), eq(documentsTable.orgId, authReq.orgId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
