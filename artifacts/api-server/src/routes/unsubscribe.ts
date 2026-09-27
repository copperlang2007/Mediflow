/**
 * Public email unsubscribe endpoint (CAN-SPAM opt-out).
 *
 *   GET  /api/public/unsubscribe?t=<token>  — confirmation page with a button.
 *   POST /api/public/unsubscribe?t=<token>  — records the opt-out. Also the
 *        RFC 8058 one-click target mail clients POST to directly.
 *
 * GET never changes state: corporate mail scanners follow every link in a
 * message, and a GET that unsubscribed would opt people out without their
 * action. Trust comes from the signed token (lib/compliance/unsubscribe.ts),
 * so this router is mounted above the Clerk-guarded /api router.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, contactsTable, optOutsTable, auditLogTable } from "@workspace/db";
import { UNSUBSCRIBE_PATH, verifyUnsubscribeToken } from "../lib/compliance/unsubscribe";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const unsubscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { forwardedHeader: false },
  message: "Too many requests. Please try again in a minute.",
});

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}
  main{max-width:480px;margin:12vh auto;padding:32px 24px;background:#fff;border:1px solid #e2e8f0;border-radius:12px}
  h1{font-size:20px;margin:0 0 12px}
  p{line-height:1.5;color:#334155}
  button{margin-top:12px;padding:10px 18px;font-size:15px;border-radius:8px;border:0;background:#0f172a;color:#fff;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
}

function tokenFrom(req: Request): string {
  const t = req.query.t;
  return typeof t === "string" ? t : "";
}

const INVALID = page(
  "Link not valid",
  "<h1>This unsubscribe link is not valid</h1><p>Reply to the email you received and ask to be removed, and we will take you off the list.</p>",
);

router.get(UNSUBSCRIBE_PATH, unsubscribeLimiter, (req: Request, res: Response): void => {
  const token = tokenFrom(req);
  if (!verifyUnsubscribeToken(token)) {
    res.status(400).type("html").send(INVALID);
    return;
  }
  res.type("html").send(
    page(
      "Unsubscribe",
      `<h1>Unsubscribe from emails</h1><p>Confirm below and we will stop sending you these emails.</p>
<form method="post" action="${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`,
    ),
  );
});

router.post(UNSUBSCRIBE_PATH, unsubscribeLimiter, async (req: Request, res: Response): Promise<void> => {
  const claims = verifyUnsubscribeToken(tokenFrom(req));
  if (!claims) {
    res.status(400).type("html").send(INVALID);
    return;
  }

  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: contactsTable.id,
          email: contactsTable.email,
          optOutEmail: contactsTable.optOutEmail,
        })
        .from(contactsTable)
        .where(and(eq(contactsTable.id, claims.contactId), eq(contactsTable.orgId, claims.orgId)))
        .limit(1);
      if (!current?.email) {
        throw new Error("unsubscribe target has no email");
      }
      // Already unsubscribed (a repeat click, a retry or a mail-client
      // prefetch): record nothing new, so the log shows one opt-out.
      if (current.optOutEmail) return;
      await tx
        .update(contactsTable)
        .set({ optOutEmail: true })
        .where(and(eq(contactsTable.id, claims.contactId), eq(contactsTable.orgId, claims.orgId)));

      await tx.insert(optOutsTable).values({
        id: randomUUID(),
        orgId: claims.orgId,
        email: current.email,
        channel: "email",
        source: "unsubscribe_link",
      });
      await tx.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: claims.orgId,
        userId: null,
        userRole: null,
        action: "email_unsubscribe",
        resourceType: "contact",
        resourceId: current.id,
        changes: { optOutEmail: true, via: "unsubscribe_link" },
        ipAddress: req.ip ?? null,
      });
    });
  } catch (err) {
    logger.error({ err, contactId: claims.contactId }, "Email unsubscribe failed");
    res.status(500).type("html").send(
      page("Something went wrong", "<h1>We could not process that</h1><p>Please try again, or reply to the email and ask to be removed.</p>"),
    );
    return;
  }

  res.type("html").send(
    page("Unsubscribed", "<h1>You are unsubscribed</h1><p>You will not receive these emails any more.</p>"),
  );
});

export default router;
