/**
 * Knowledge Base articles (stage 2, migration 0053).
 *
 *   GET    /kb/articles        — list (search, category, includeInactive)
 *   GET    /kb/articles/:id    — one article
 *   POST   /kb/articles        — create (agency owners)
 *   PATCH  /kb/articles/:id    — edit / turn on or off (agency owners)
 *   DELETE /kb/articles/:id    — remove (agency owners)
 *
 * Articles are non-PHI reference notes. Every handler is org-scoped: an
 * article id from another agency 404s. Active articles feed the AI
 * assistant's context (see lib/kbContext.ts).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, kbArticlesTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { safeLimit, safeOffset } from "../lib/listGuards";
import { normalizeKeywords } from "../lib/kbContext";

const router: IRouter = Router();

const TITLE_MAX = 200;
const CONTENT_MAX = 20_000;
const CATEGORY_MAX = 80;

const CreateSchema = z.object({
  category: z.string().trim().min(1).max(CATEGORY_MAX),
  title: z.string().trim().min(1).max(TITLE_MAX),
  content: z.string().trim().min(1).max(CONTENT_MAX),
  keywords: z.array(z.string().max(60)).max(50).optional(),
  isActive: z.boolean().optional(),
});

const UpdateSchema = CreateSchema.partial();

function idParam(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

const audit = auditMiddleware("kb_article", undefined, {
  getResourceId: (req) => {
    const raw = req.params.id;
    return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  },
});

/** Escape LIKE wildcards so a search for "100%" matches literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

router.get(
  "/kb/articles",
  requireAuth,
  requirePermission("kb_article", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = req.query as Record<string, string | undefined>;

    const conditions: SQL[] = [eq(kbArticlesTable.orgId, authReq.orgId)];
    if (q.includeInactive !== "true") {
      conditions.push(eq(kbArticlesTable.isActive, true));
    }
    if (q.category) conditions.push(eq(kbArticlesTable.category, q.category));
    const search = q.search?.trim().slice(0, 100);
    if (search) {
      const pattern = `%${likeEscape(search)}%`;
      conditions.push(
        or(
          ilike(kbArticlesTable.title, pattern),
          ilike(kbArticlesTable.content, pattern),
          ilike(kbArticlesTable.category, pattern),
          sql`EXISTS (SELECT 1 FROM unnest(${kbArticlesTable.keywords}) AS k WHERE k ILIKE ${pattern})`,
        ) as SQL,
      );
    }

    const [rows, [counts]] = await Promise.all([
      db
        .select()
        .from(kbArticlesTable)
        .where(and(...conditions))
        .orderBy(asc(kbArticlesTable.category), asc(kbArticlesTable.title))
        .limit(safeLimit(q.limit, 200, 500))
        .offset(safeOffset(q.offset)),
      db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) FILTER (WHERE ${kbArticlesTable.isActive})::int`,
          categories: sql<number>`count(DISTINCT ${kbArticlesTable.category})::int`,
          keywords: sql<number>`coalesce(sum(cardinality(${kbArticlesTable.keywords})), 0)::int`,
        })
        .from(kbArticlesTable)
        .where(eq(kbArticlesTable.orgId, authReq.orgId)),
    ]);

    res.json({
      articles: rows,
      stats: {
        total: Number(counts?.total ?? 0),
        active: Number(counts?.active ?? 0),
        categories: Number(counts?.categories ?? 0),
        keywords: Number(counts?.keywords ?? 0),
      },
    });
  },
);

router.get(
  "/kb/articles/:id",
  requireAuth,
  requirePermission("kb_article", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const [row] = await db
      .select()
      .from(kbArticlesTable)
      .where(and(eq(kbArticlesTable.id, idParam(req)), eq(kbArticlesTable.orgId, authReq.orgId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    res.json(row);
  },
);

router.post(
  "/kb/articles",
  requireAuth,
  requirePermission("kb_article", "create"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const [row] = await db
      .insert(kbArticlesTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        category: d.category,
        title: d.title,
        content: d.content,
        keywords: normalizeKeywords(d.keywords ?? []),
        isActive: d.isActive ?? true,
        createdBy: authReq.userId,
      })
      .returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/kb/articles/:id",
  requireAuth,
  requirePermission("kb_article", "update"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const updates: Partial<typeof kbArticlesTable.$inferInsert> = {};
    if (d.category !== undefined) updates.category = d.category;
    if (d.title !== undefined) updates.title = d.title;
    if (d.content !== undefined) updates.content = d.content;
    if (d.keywords !== undefined) updates.keywords = normalizeKeywords(d.keywords);
    if (d.isActive !== undefined) updates.isActive = d.isActive;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [row] = await db
      .update(kbArticlesTable)
      .set(updates)
      .where(and(eq(kbArticlesTable.id, idParam(req)), eq(kbArticlesTable.orgId, authReq.orgId)))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/kb/articles/:id",
  requireAuth,
  requirePermission("kb_article", "delete"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const [row] = await db
      .delete(kbArticlesTable)
      .where(and(eq(kbArticlesTable.id, idParam(req)), eq(kbArticlesTable.orgId, authReq.orgId)))
      .returning({ id: kbArticlesTable.id });
    if (!row) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
