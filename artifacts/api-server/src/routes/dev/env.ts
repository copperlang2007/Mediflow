/**
 * Dev console — masked env viewer.
 *
 * Returns process.env with values masked for any key that looks like a
 * secret. We intentionally mask aggressively (any of SECRET/TOKEN/KEY/
 * PASSWORD/DSN/URL) — even with ENABLE_DEV_CONSOLE=true, there is no
 * legitimate reason for an in-browser dev console to display the raw
 * value of a production secret. If the operator really needs the literal
 * value, they should shell onto the box.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth, requirePermission } from "../../middlewares/requireAuth";

const SECRET_KEY_RE = /SECRET|TOKEN|KEY|PASSWORD|DSN|URL/i;

const router: IRouter = Router();

// Mirror the auth gate that /dev/ops applies — env-var alone is not enough.
router.use(requireAuth, requirePermission("dev_console", "read"));

export function maskValue(raw: string): string {
  // Below the safe-leakage threshold, replace the whole value. 12 chars is
  // long enough that the first 4 + last 4 are not the entire secret.
  if (raw.length <= 12) return "***";
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

router.get("/env", (_req: Request, res: Response) => {
  const entries = Object.entries(process.env)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => {
      const isSecret = SECRET_KEY_RE.test(key);
      const raw = String(value);
      return {
        key,
        value: isSecret ? maskValue(raw) : raw,
        isSecret,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  res.json(entries);
});

export default router;
