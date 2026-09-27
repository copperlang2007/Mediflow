import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, agentsTable, documentsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware, scopeToRouter } from "../middlewares/auditMiddleware";
import { safeLimit, safeOffset } from "../lib/listGuards";

const router: IRouter = Router();

const CreateDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().max(100).default("other"),
  storageKey: z.string().min(1),
  fileSizeBytes: z.number().int().optional(),
  mimeType: z.string().max(100).optional(),
});

router.use(
  scopeToRouter(router, auditMiddleware("storage", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.docId ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  })),
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

// GET /documents — org-wide list with optional filters
router.get(
  "/documents",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { agentId, category } = req.query as {
      agentId?: string;
      category?: string;
    };
    const limitNum = safeLimit(req.query.limit, 100, 500);
    const offsetNum = safeOffset(req.query.offset);

    const conditions: SQL[] = [eq(documentsTable.orgId, authReq.orgId)];
    if (agentId) conditions.push(eq(documentsTable.agentId, agentId));
    if (category) conditions.push(eq(documentsTable.category, category));

    // Join agents so the UI can render the owner without an N+1.
    const docs = await db
      .select({
        id: documentsTable.id,
        orgId: documentsTable.orgId,
        agentId: documentsTable.agentId,
        contactId: documentsTable.contactId,
        name: documentsTable.name,
        category: documentsTable.category,
        storageKey: documentsTable.storageKey,
        fileSizeBytes: documentsTable.fileSizeBytes,
        mimeType: documentsTable.mimeType,
        uploadedBy: documentsTable.uploadedBy,
        createdAt: documentsTable.createdAt,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
      })
      .from(documentsTable)
      .leftJoin(agentsTable, eq(documentsTable.agentId, agentsTable.id))
      .where(and(...conditions))
      .orderBy(desc(documentsTable.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    res.json({ documents: docs, total: docs.length });
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

// GET /documents/:docId/download — stream the object via signed url
router.get(
  "/documents/:docId/download",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const docId = Array.isArray(req.params.docId) ? req.params.docId[0] : req.params.docId;

    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, docId), eq(documentsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    try {
      const { ObjectStorageService } = await import("../lib/objectStorage");
      const { ObjectPermission } = await import("../lib/objectAcl");
      const objectStorage = new ObjectStorageService();
      const file = await objectStorage.getObjectEntityFile(doc.storageKey);

      const canAccess = await objectStorage.canAccessObjectEntity({
        userId: authReq.userId,
        objectFile: file,
        requestedPermission: ObjectPermission.READ,
      });
      if (!canAccess) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const contentType = doc.mimeType ?? "application/octet-stream";
      const safeName = encodeURIComponent(doc.name.replace(/[^\w\s.-]/g, "_"));

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

      const dlResponse = await objectStorage.downloadObject(file);
      const buffer = Buffer.from(await dlResponse.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      req.log.error({ err, docId }, "Failed to stream document");
      res.status(500).json({ error: "Failed to retrieve document file" });
    }
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
