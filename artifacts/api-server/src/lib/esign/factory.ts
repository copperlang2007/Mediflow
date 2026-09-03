/**
 * E-sign provider factory.
 *
 * Routes and callers MUST go through `getEsignProvider()` rather than
 * instantiating a concrete provider directly. This is the seam that lets us
 * swap the underlying implementation (native `MediflowESignProvider` Beta
 * today; managed DocuSign for production once the BAA + integration land)
 * without re-threading every call site.
 *
 * Provider selection is controlled by the `ESIGN_PROVIDER` env var:
 *
 *   - `mediflow` (default) — in-process `MediflowESignProvider`. Beta-quality,
 *                            no PKI seal, no KBA. Fine for dev / design-partner
 *                            demos. Must NOT be used in production once
 *                            DocuSign is wired (Phase-3 gate).
 *   - `docusign`           — managed DocuSign envelopes via the docusign-esign
 *                            SDK. HIPAA-eligible plan + BAA required.
 *
 * Boot-time enforcement of the prod gate lives in
 * `assertEsignProviderHipaaCompliant`, which is called from `index.ts`
 * alongside the AI provider and storage backend guards. The assertion is
 * a no-op until the DocuSign implementation lands — wired here so the
 * call site in `index.ts` doesn't need to move twice.
 */
import type { ESignProvider } from "./provider";
import { getMediflowProvider } from "./mediflowProvider";
import { getDocuSignProvider } from "./docusignProvider";

export type EsignProviderName = "mediflow" | "docusign";

const SUPPORTED_PROVIDERS: ReadonlySet<EsignProviderName> = new Set([
  "mediflow",
  "docusign",
]);

function readProviderEnv(): EsignProviderName {
  const raw = (process.env.ESIGN_PROVIDER ?? "mediflow").toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(raw as EsignProviderName)) {
    throw new Error(
      `Invalid ESIGN_PROVIDER=${raw}. Supported: ${[...SUPPORTED_PROVIDERS].join(", ")}`,
    );
  }
  return raw as EsignProviderName;
}

/**
 * Resolve and return the configured `ESignProvider`. Lazy — the underlying
 * concrete provider is constructed once on first call (and the singletons
 * inside each provider module enforce per-process reuse).
 */
export function getEsignProvider(): ESignProvider {
  const provider = readProviderEnv();
  switch (provider) {
    case "mediflow":
      return getMediflowProvider();
    case "docusign":
      // `DocuSignESignProvider` is fully implemented in `docusignProvider.ts`;
      // this factory simply never reached it, so ~450 lines of working client
      // code sat behind a hard throw. `getDocuSignProvider()` validates its own
      // env (integration key, user/account id, RSA private key, base path) and
      // throws with the specific missing variable if the deploy is incomplete.
      return getDocuSignProvider();
  }
}

/**
 * Boot-time HIPAA guard. Mirrors `assertAiProviderHipaaCompliant` and
 * `assertStorageBackendHipaaCompliant`. Called from the bootstrap path so a
 * misconfigured production deploy fails fast before the first envelope is
 * created.
 *
 * Now that `DocuSignESignProvider` is actually reachable, the gate this
 * function was always meant to enforce is live: the native `mediflow` provider
 * is Beta — no KBA, no managed audit trail — and must not sign real
 * beneficiary paperwork in production.
 *
 * Escape hatch: `ESIGN_ALLOW_BETA_IN_PROD=true` acknowledges the risk
 * explicitly. It exists so an operator can make a deliberate, recorded choice
 * rather than being tempted to weaken the guard itself — and it logs nothing
 * quietly; the caller sees the provider name at boot.
 */
export function assertEsignProviderHipaaCompliant(): void {
  // Side-effect: throws if ESIGN_PROVIDER is set to an unsupported value.
  const provider = readProviderEnv();

  if (process.env.NODE_ENV !== "production") return;
  if (provider === "docusign") return;
  if (process.env.ESIGN_ALLOW_BETA_IN_PROD === "true") return;

  throw new Error(
    "ESIGN_PROVIDER=mediflow is a Beta signature path (no KBA, no managed " +
      "audit trail) and must not be used in production. Set " +
      "ESIGN_PROVIDER=docusign with a HIPAA-eligible DocuSign plan and a " +
      "signed BAA, or set ESIGN_ALLOW_BETA_IN_PROD=true to accept the risk " +
      "explicitly.",
  );
}
