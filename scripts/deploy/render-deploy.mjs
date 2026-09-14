#!/usr/bin/env node
// @ts-check
/**
 * MediFlow → Render PRODUCTION deploy engine.
 *
 * Run by .github/workflows/deploy-mediflow-render.yml. Does everything needed to
 * ship a production MediFlow to Render so the operator never touches the Render
 * dashboard:
 *
 *   1. Validates that the required third-party secrets are present (fails fast
 *      with the exact GitHub Secret name to add).
 *   2. Ensures a managed Postgres exists (creates it if missing).
 *   3. Ensures the web service exists (creates it from this repo if missing).
 *   4. Computes the FULL production env set:
 *        - generates the cryptographic keys ONCE and reuses the persisted value
 *          on every later deploy (PHI keys must stay stable or encrypted data is
 *          orphaned),
 *        - copies your SaaS credentials from the process env (GitHub Secrets),
 *        - sets the static config (NODE_ENV=production, AI provider=azure, …),
 *        - wires DATABASE_URL from the managed Postgres,
 *        - sets ALLOWED_ORIGIN + VITE_CLERK_PUBLISHABLE_KEY automatically.
 *   5. Pushes that env to the service, triggers a deploy, and polls until the
 *      deploy is live (or fails).
 *
 * No npm dependencies — uses Node's built-in fetch + crypto (Node >= 20).
 *
 * Required env:
 *   RENDER_API_KEY              Render API key (GitHub Secret).
 * Optional env (sensible defaults):
 *   RENDER_SERVICE_ID          Skip lookup/creation; deploy this service.
 *   RENDER_DATABASE_ID         Skip lookup/creation; use this Postgres.
 *   RENDER_SERVICE_NAME        Default: mediflow-prod
 *   RENDER_DATABASE_NAME       Default: mediflow-prod-db
 *   RENDER_OWNER_ID            Default: first owner on the API key.
 *   RENDER_REGION              Default: oregon
 *   RENDER_PLAN                Default: standard
 *   RENDER_DB_PLAN             Default: standard
 *   RENDER_REPO_URL            Default: derived from GITHUB_SERVER_URL/REPOSITORY
 *   RENDER_BRANCH              Default: GITHUB_REF_NAME or current branch
 *   APP_ORIGIN                 Override ALLOWED_ORIGIN (else the service URL).
 *   DEPLOY_WAIT_TIMEOUT_MS     Default: 1_800_000 (30 min)
 *   plus every MediFlow secret/config var (see REQUIRED_SECRETS / OPTIONAL_SECRETS).
 */

import { randomBytes } from "node:crypto";

const API = "https://api.render.com/v1";
const KEY = required("RENDER_API_KEY");

// ---------------------------------------------------------------------------
// Env contract (mirrors the production env audit + prodEnvGuard / aiProvider /
// medicareId / objectStorage boot guards).
// ---------------------------------------------------------------------------

/** Third-party credentials with no safe default — deploy aborts if missing. */
const REQUIRED_SECRETS = [
  "CLERK_SECRET_KEY", // sk_live_…
  "CLERK_PUBLISHABLE_KEY", // pk_live_…  (also mirrored to VITE_CLERK_PUBLISHABLE_KEY)
  "PRIVATE_OBJECT_DIR", // GCS bucket/path (hard-required at boot)
];

/**
 * The AI base URL, which may be supplied under EITHER name — exactly the
 * contract resolveAiBaseUrl() implements and the deploy workflow gates on:
 *
 *   AI_INTEGRATIONS_BEDROCK_BASE_URL  canonical
 *   AI_INTEGRATIONS_OPENAI_BASE_URL   legacy fallback, still read at runtime
 *
 * These must NOT live in REQUIRED_SECRETS: that list demands every entry, so
 * listing both there would make the deploy succeed only when BOTH are set —
 * failing the documented canonical-only setup and every existing legacy-only
 * one. preflight() instead requires that at least one is present.
 *
 * Bedrock's endpoint is the Anthropic Messages path (.../anthropic), NOT
 * /openai/v1: AWS lists Chat Completions as unsupported for every Anthropic
 * model.
 */
const AI_BASE_URL_SECRETS = [
  "AI_INTEGRATIONS_BEDROCK_BASE_URL",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
];

/**
 * The AI API key, under EITHER name. For bedrock this is an AWS Bedrock
 * bearer token from the operator's own account -- never an OpenAI
 * credential. BEDROCK is canonical; OPENAI is the legacy fallback.
 */
const AI_API_KEY_SECRETS = [
  "AI_INTEGRATIONS_BEDROCK_API_KEY",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
];

/** Optional credentials — passed through only when set (feature no-ops if absent). */
const OPTIONAL_SECRETS = [
  "PUBLIC_OBJECT_SEARCH_PATHS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_WEBHOOK_PUBLIC_HOST",
  "RESEND_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "CONTRACTING_EMAIL_FROM",
  "SENTRY_DSN",
  "ESIGN_SIGNING_CERT_PEM",
  "ESIGN_SIGNING_KEY_PEM",
];

/**
 * Static, non-secret production config. NOTE: when the workflow runs, this
 * script is the single source of truth for the service env — the PUT below
 * replaces the full env set. The matching keys in render.prod.yaml apply only
 * to the optional "connect the blueprint manually" path; keep the two in sync
 * if you change a value here.
 */
const STATIC_CONFIG = {
  NODE_ENV: "production",
  AI_INTEGRATIONS_PROVIDER: "bedrock", // HIPAA: AWS Bedrock, covered by your AWS BAA
  AI_INTEGRATIONS_MODEL:
    process.env.AI_INTEGRATIONS_MODEL || "us.anthropic.claude-sonnet-4-6",
  MFA_REQUIRED: "true",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  WEB_STATIC_DIR: "/opt/render/project/src/artifacts/web-app/dist/public",
  BUILD_SHA: process.env.GITHUB_SHA || "",
};

/**
 * Cryptographic keys generated once and then reused from the service's existing
 * env on every subsequent deploy. `b64` → base64 of 32 bytes (PHI keys, which
 * must decode to exactly 32 bytes); otherwise hex.
 */
const GENERATED_KEYS = [
  { name: "PHI_ENCRYPTION_KEY", b64: true },
  { name: "PHI_HMAC_KEY", b64: true },
  { name: "METRICS_TOKEN", b64: false },
  { name: "DIALER_WEBHOOK_SECRET", b64: false },
  { name: "LEAD_QUEUE_WEBHOOK_SECRET", b64: false },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`FATAL: required env ${name} is not set.`);
    process.exit(1);
  }
  return v.trim();
}

function log(msg) {
  console.log(`▶ ${msg}`);
}

function genSecret(b64) {
  const buf = randomBytes(32);
  return b64 ? buf.toString("base64") : buf.toString("hex");
}

/** Authenticated Render API call with basic error surfacing. */
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new Error(
      `Render API ${method} ${path} → ${res.status} ${res.statusText}: ${text}`,
    );
  }
  return data;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function preflight() {
  const missing = REQUIRED_SECRETS.filter(
    (n) => !process.env[n] || !process.env[n].trim(),
  );
  if (missing.length) {
    console.error(
      "FATAL: the following required GitHub Secrets are missing. Add them in\n" +
        "  Settings → Secrets and variables → Actions, then re-run:\n" +
        missing.map((n) => `   - ${n}`).join("\n"),
    );
    process.exit(1);
  }
  if (!AI_API_KEY_SECRETS.some((n) => (process.env[n] || "").trim())) {
    console.error(
      "FATAL: the AI API key is not set. Add ONE of these GitHub Secrets in\n" +
        "  Settings \u2192 Secrets and variables \u2192 Actions, then re-run:\n" +
        "   - AI_INTEGRATIONS_BEDROCK_API_KEY  (canonical; preferred)\n" +
        "   - AI_INTEGRATIONS_OPENAI_API_KEY   (legacy name, still honored)\n" +
        "  This is an AWS Bedrock bearer token from your own AWS account,\n" +
        "  NOT an OpenAI credential.",
    );
    process.exit(1);
  }
  // The AI base URL may arrive under either name; require at least one,
  // matching resolveAiBaseUrl() and the workflow gate. Whitespace is unset.
  if (!AI_BASE_URL_SECRETS.some((n) => (process.env[n] || "").trim())) {
    console.error(
      "FATAL: the AI base URL is not set. Add ONE of these GitHub Secrets in\n" +
        "  Settings \u2192 Secrets and variables \u2192 Actions, then re-run:\n" +
        "   - AI_INTEGRATIONS_BEDROCK_BASE_URL  (canonical; preferred)\n" +
        "   - AI_INTEGRATIONS_OPENAI_BASE_URL   (legacy name, still honored)\n" +
        "  For Bedrock this is the Anthropic Messages endpoint, e.g.\n" +
        "  https://bedrock-runtime.<region>.amazonaws.com/anthropic",
    );
    process.exit(1);
  }
  // Format sanity — catch the most common foot-guns early with a clear message.
  const sk = process.env.CLERK_SECRET_KEY || "";
  const pk = process.env.CLERK_PUBLISHABLE_KEY || "";
  if (!sk.startsWith("sk_live_")) {
    console.error(
      "FATAL: CLERK_SECRET_KEY must be a LIVE key (sk_live_…) for production.",
    );
    process.exit(1);
  }
  if (!pk.startsWith("pk_live_")) {
    console.error(
      "FATAL: CLERK_PUBLISHABLE_KEY must be a LIVE key (pk_live_…) for production.",
    );
    process.exit(1);
  }
  log("Preflight passed — required secrets present and well-formed.");
}

async function resolveOwnerId() {
  if (process.env.RENDER_OWNER_ID) return process.env.RENDER_OWNER_ID.trim();
  const owners = await api("GET", "/owners?limit=1");
  const id = owners?.[0]?.owner?.id;
  if (!id) {
    throw new Error(
      "Could not resolve a Render owner from the API key. Set RENDER_OWNER_ID.",
    );
  }
  return id;
}

async function findByName(path, name) {
  // Render list endpoints return [{ <singular>: {...}, cursor }]. Match on name.
  const items = await api("GET", `${path}?limit=100`);
  for (const wrapper of items || []) {
    const obj = wrapper.service || wrapper.postgres || wrapper;
    if (obj?.name === name) return obj;
  }
  return null;
}

async function ensurePostgres(ownerId) {
  if (process.env.RENDER_DATABASE_ID) {
    const id = process.env.RENDER_DATABASE_ID.trim();
    log(`Using existing Postgres ${id} (RENDER_DATABASE_ID).`);
    return id;
  }
  const name = process.env.RENDER_DATABASE_NAME || "mediflow-prod-db";
  const existing = await findByName("/postgres", name);
  if (existing) {
    log(`Found Postgres "${name}" (${existing.id}).`);
    return existing.id;
  }
  log(`Creating Postgres "${name}"…`);
  const created = await api("POST", "/postgres", {
    name,
    ownerId,
    plan: process.env.RENDER_DB_PLAN || "standard",
    region: process.env.RENDER_REGION || "oregon",
    databaseName: "mediflow_prod",
    databaseUser: "mediflow",
    version: "16",
  });
  return created.id;
}

async function getDatabaseUrl(dbId) {
  const info = await api("GET", `/postgres/${dbId}/connection-info`);
  // Prefer the internal connection string (same-region, no egress).
  return info.internalConnectionString || info.externalConnectionString;
}

function repoUrl() {
  if (process.env.RENDER_REPO_URL) return process.env.RENDER_REPO_URL.trim();
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY; // owner/name
  if (!repo) {
    throw new Error("Set RENDER_REPO_URL (could not derive from GITHUB_REPOSITORY).");
  }
  return `${server}/${repo}`;
}

async function ensureService(ownerId) {
  if (process.env.RENDER_SERVICE_ID) {
    const id = process.env.RENDER_SERVICE_ID.trim();
    log(`Using existing service ${id} (RENDER_SERVICE_ID).`);
    return await api("GET", `/services/${id}`);
  }
  const name = process.env.RENDER_SERVICE_NAME || "mediflow-prod";
  const existing = await findByName("/services", name);
  if (existing) {
    log(`Found service "${name}" (${existing.id}).`);
    return existing;
  }
  const branch =
    process.env.RENDER_BRANCH ||
    process.env.GITHUB_REF_NAME ||
    "claude/product-market-launch-selection-iw23qv";
  log(`Creating web service "${name}" from ${repoUrl()}@${branch}…`);
  const created = await api("POST", "/services", {
    type: "web_service",
    name,
    ownerId,
    repo: repoUrl(),
    branch,
    autoDeploy: "no", // this workflow is the single deploy trigger
    serviceDetails: {
      runtime: "node",
      plan: process.env.RENDER_PLAN || "standard",
      region: process.env.RENDER_REGION || "oregon",
      healthCheckPath: "/api/healthz",
      preDeployCommand: "pnpm --filter @workspace/db run migrate",
      envSpecificDetails: {
        buildCommand:
          "corepack enable && corepack prepare pnpm@10.28.1 --activate && " +
          "pnpm install --frozen-lockfile && " +
          "pnpm --filter @workspace/web-app run build && " +
          "pnpm --filter @workspace/api-server run build",
        startCommand: "pnpm --filter @workspace/api-server run start",
      },
    },
  });
  return created.service || created;
}

function serviceUrl(service) {
  // Only serviceDetails.url is a valid public origin. (dashboardUrl points at
  // dashboard.render.com and is NOT the app origin.) When it's absent, return
  // "" and let main() fall back to the predictable <name>.onrender.com host.
  return service?.serviceDetails?.url || "";
}

/**
 * Build the complete env-var array to PUT. Generated keys reuse any value that
 * already exists on the service; everything else is computed from process.env.
 */
function buildEnv(existing, databaseUrl, origin) {
  /** @type {Record<string,string>} */
  const out = {};
  const existingByKey = new Map(
    (existing || []).map((e) => [e.envVar?.key ?? e.key, e.envVar?.value ?? e.value]),
  );

  // 1) Static config
  for (const [k, v] of Object.entries(STATIC_CONFIG)) if (v !== "") out[k] = v;

  // 2) Database + origin + build-time Clerk key
  out.DATABASE_URL = databaseUrl;
  out.PORT = existingByKey.get("PORT") || "10000";
  out.ALLOWED_ORIGIN = origin;
  out.VITE_CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY.trim();

  // 3) Generated cryptographic keys — reuse if already set, else generate once.
  for (const { name, b64 } of GENERATED_KEYS) {
    const prior = existingByKey.get(name);
    out[name] = prior && prior.trim() ? prior : genSecret(b64);
  }

  // 4) Required + optional SaaS secrets
  for (const name of [
    ...REQUIRED_SECRETS,
    ...AI_BASE_URL_SECRETS,
    ...AI_API_KEY_SECRETS,
    ...OPTIONAL_SECRETS,
  ]) {
    const v = process.env[name];
    if (v && v.trim()) out[name] = v.trim();
  }

  return Object.entries(out).map(([key, value]) => ({ key, value }));
}

async function putEnv(serviceId, envArray) {
  // PUT replaces the full env set; we send the complete computed list.
  await api("PUT", `/services/${serviceId}/env-vars`, envArray);
  log(`Synced ${envArray.length} environment variables.`);
}

async function triggerDeploy(serviceId) {
  const deploy = await api("POST", `/services/${serviceId}/deploys`, {
    clearCache: "do_not_clear",
  });
  return deploy.id;
}

async function waitForDeploy(serviceId, deployId) {
  // Guard against a non-numeric override producing NaN, which would make the
  // loop condition immediately false and skip polling entirely.
  let timeout = Number(process.env.DEPLOY_WAIT_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = 1_800_000;
  const start = Date.now();
  const terminalOk = new Set(["live"]);
  const terminalBad = new Set([
    "build_failed",
    "update_failed",
    "canceled",
    "deactivated",
    "pre_deploy_failed",
  ]);
  let last = "";
  while (Date.now() - start < timeout) {
    const d = await api("GET", `/services/${serviceId}/deploys/${deployId}`);
    const status = d.status || d?.deploy?.status;
    if (status !== last) {
      log(`Deploy status: ${status}`);
      last = status;
    }
    if (terminalOk.has(status)) return true;
    if (terminalBad.has(status)) {
      throw new Error(`Deploy ${deployId} ended in "${status}".`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`Timed out waiting for deploy ${deployId} after ${timeout}ms.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  preflight();
  const ownerId = await resolveOwnerId();
  log(`Owner: ${ownerId}`);

  const dbId = await ensurePostgres(ownerId);
  const databaseUrl = await getDatabaseUrl(dbId);
  if (!databaseUrl) throw new Error(`No connection string for Postgres ${dbId}.`);

  let service = await ensureService(ownerId);
  const serviceId = service.id;

  const origin =
    (process.env.APP_ORIGIN && process.env.APP_ORIGIN.trim()) ||
    serviceUrl(service) ||
    `https://${process.env.RENDER_SERVICE_NAME || "mediflow-prod"}.onrender.com`;
  log(`Public origin (ALLOWED_ORIGIN): ${origin}`);

  const existing = await api("GET", `/services/${serviceId}/env-vars?limit=100`);
  const envArray = buildEnv(existing, databaseUrl, origin);
  await putEnv(serviceId, envArray);

  log("Triggering deploy…");
  const deployId = await triggerDeploy(serviceId);
  log(`Deploy ${deployId} started. Waiting for it to go live…`);
  await waitForDeploy(serviceId, deployId);

  console.log("\n✅ MediFlow production deploy is LIVE.");
  console.log(`   Service: ${serviceId}`);
  console.log(`   URL:     ${origin}`);
}

main().catch((err) => {
  console.error(`\n❌ Deploy failed: ${err.message}`);
  process.exit(1);
});
