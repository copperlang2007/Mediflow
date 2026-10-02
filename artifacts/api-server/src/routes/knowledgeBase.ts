/**
 * Knowledge Base articles (stage 2, migration 0053).
 *
 *   GET    /kb/articles        — list (search, category, includeInactive)
 *   GET    /kb/articles/:id    — one article
 *   POST   /kb/articles        — create (agency owners)
 *   PATCH  /kb/articles/:id    — edit / turn on or off (agency owners)
 *   DELETE /kb/articles/:id    — remove (agency owners)
 *
 * Mediflow library (migration 0065) — platform-wide articles each agency
 * chooses from:
 *   GET /kb/library            — list, with this agency's on/off state
 *   PUT /kb/library/choices    — turn library articles on or off (agency owners)
 *   POST/PATCH/DELETE /kb/library/articles[/:id]
 *                              — write the shared library itself (super_admin,
 *                                the platform owner, MFA). Changes reach EVERY
 *                                agency; deleting also removes each agency's choice.
 *
 * Articles are non-PHI reference notes. Every handler is org-scoped: an
 * article id from another agency 404s. Active articles feed the AI
 * assistant's context (see lib/kbContext.ts).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, kbArticlesTable, kbLibraryArticlesTable, kbLibraryChoicesTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { requireMfa } from "../middlewares/requireMfa";
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

const LibraryChoicesSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(200),
  enabled: z.boolean(),
});

router.get(
  "/kb/library",
  requireAuth,
  requirePermission("kb_article", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = req.query as Record<string, string | undefined>;

    const effective = sql<boolean>`coalesce(${kbLibraryChoicesTable.enabled}, ${kbLibraryArticlesTable.defaultEnabled})`;
    const conditions: SQL[] = [];
    if (q.kind === "mediflow_guide" || q.kind === "medicare_reference") {
      conditions.push(eq(kbLibraryArticlesTable.kind, q.kind));
    }
    if (q.category) conditions.push(eq(kbLibraryArticlesTable.category, q.category));
    const search = q.search?.trim().slice(0, 100);
    if (search) {
      const pattern = `%${likeEscape(search)}%`;
      conditions.push(
        or(
          ilike(kbLibraryArticlesTable.title, pattern),
          ilike(kbLibraryArticlesTable.content, pattern),
          ilike(kbLibraryArticlesTable.category, pattern),
          sql`EXISTS (SELECT 1 FROM unnest(${kbLibraryArticlesTable.keywords}) AS k WHERE k ILIKE ${pattern})`,
        ) as SQL,
      );
    }

    const rows = await db
      .select({
        id: kbLibraryArticlesTable.id,
        category: kbLibraryArticlesTable.category,
        title: kbLibraryArticlesTable.title,
        content: kbLibraryArticlesTable.content,
        keywords: kbLibraryArticlesTable.keywords,
        kind: kbLibraryArticlesTable.kind,
        needsReview: kbLibraryArticlesTable.needsReview,
        defaultEnabled: kbLibraryArticlesTable.defaultEnabled,
        enabled: effective,
        chosen: sql<boolean>`${kbLibraryChoicesTable.enabled} IS NOT NULL`,
        updatedAt: kbLibraryArticlesTable.updatedAt,
      })
      .from(kbLibraryArticlesTable)
      .leftJoin(
        kbLibraryChoicesTable,
        and(
          eq(kbLibraryChoicesTable.articleId, kbLibraryArticlesTable.id),
          eq(kbLibraryChoicesTable.orgId, authReq.orgId),
        ),
      )
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        asc(kbLibraryArticlesTable.kind),
        asc(kbLibraryArticlesTable.category),
        asc(kbLibraryArticlesTable.title),
      )
      .limit(safeLimit(q.limit, 200, 500))
      .offset(safeOffset(q.offset));

    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        enabled: sql<number>`count(*) FILTER (WHERE ${effective})::int`,
      })
      .from(kbLibraryArticlesTable)
      .leftJoin(
        kbLibraryChoicesTable,
        and(
          eq(kbLibraryChoicesTable.articleId, kbLibraryArticlesTable.id),
          eq(kbLibraryChoicesTable.orgId, authReq.orgId),
        ),
      );

    res.json({
      articles: rows,
      stats: { total: Number(counts?.total ?? 0), enabled: Number(counts?.enabled ?? 0) },
    });
  },
);

const LibraryArticleCreateSchema = CreateSchema.omit({ isActive: true }).extend({
  kind: z.enum(["mediflow_guide", "medicare_reference"]).default("mediflow_guide"),
  defaultEnabled: z.boolean().default(true),
  needsReview: z.boolean().default(false),
});
const LibraryArticleUpdateSchema = LibraryArticleCreateSchema.partial();

const libraryAudit = auditMiddleware("kb_article", undefined, {
  getResourceId: (req) => {
    const raw = req.params.id;
    return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  },
});

router.post(
  "/kb/library/articles",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  libraryAudit,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = LibraryArticleCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const uid = randomUUID();
    const [row] = await db
      .insert(kbLibraryArticlesTable)
      .values({
        id: `lib-${uid}`,
        key: `custom-${uid}`,
        category: d.category,
        title: d.title,
        content: d.content,
        keywords: normalizeKeywords(d.keywords ?? []),
        kind: d.kind,
        defaultEnabled: d.defaultEnabled,
        needsReview: d.needsReview,
      })
      .returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/kb/library/articles/:id",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  libraryAudit,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = LibraryArticleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const updates: Partial<typeof kbLibraryArticlesTable.$inferInsert> = {};
    if (d.category !== undefined) updates.category = d.category;
    if (d.title !== undefined) updates.title = d.title;
    if (d.content !== undefined) updates.content = d.content;
    if (d.keywords !== undefined) updates.keywords = normalizeKeywords(d.keywords);
    if (d.kind !== undefined) updates.kind = d.kind;
    if (d.defaultEnabled !== undefined) updates.defaultEnabled = d.defaultEnabled;
    if (d.needsReview !== undefined) updates.needsReview = d.needsReview;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [row] = await db
      .update(kbLibraryArticlesTable)
      .set(updates)
      .where(eq(kbLibraryArticlesTable.id, idParam(req)))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Library article not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/kb/library/articles/:id",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  libraryAudit,
  async (req: Request, res: Response): Promise<void> => {
    const [row] = await db
      .delete(kbLibraryArticlesTable)
      .where(eq(kbLibraryArticlesTable.id, idParam(req)))
      .returning({ id: kbLibraryArticlesTable.id });
    if (!row) {
      res.status(404).json({ error: "Library article not found" });
      return;
    }
    res.status(204).end();
  },
);

router.put(
  "/kb/library/choices",
  requireAuth,
  requirePermission("kb_article", "update"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = LibraryChoicesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const { ids, enabled } = parsed.data;
    const unique = Array.from(new Set(ids));

    const found = await db
      .select({ id: kbLibraryArticlesTable.id })
      .from(kbLibraryArticlesTable)
      .where(inArray(kbLibraryArticlesTable.id, unique));
    if (found.length !== unique.length) {
      res.status(404).json({ error: "Library article not found" });
      return;
    }

    await db
      .insert(kbLibraryChoicesTable)
      .values(unique.map((articleId) => ({ orgId: authReq.orgId, articleId, enabled, updatedBy: authReq.userId })))
      .onConflictDoUpdate({
        target: [kbLibraryChoicesTable.orgId, kbLibraryChoicesTable.articleId],
        set: { enabled, updatedBy: authReq.userId, updatedAt: new Date() },
      });
    res.json({ updated: unique.length, enabled });
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
