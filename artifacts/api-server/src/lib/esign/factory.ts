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
 *                            SDK. HIPAA-eligible plan + BAA required. Wired
 *                            up in a follow-up PR.
 *
 * Boot-time enforcement of the prod gate lives in
 * `assertEsignProviderHipaaCompliant`, which is called from `index.ts`
 * alongside the AI provider and storage backend guards. The assertion is
 * a no-op until the DocuSign implementation lands — wired here so the
 * call site in `index.ts` doesn't need to move twice.
 */
import type { ESignProvider } from "./provider";
import { getMediflowProvider } from "./mediflowProvider";

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
      // The DocuSign implementation lands in a follow-up PR. Until then a
      // misconfigured deploy that sets ESIGN_PROVIDER=docusign should fail
      // loudly rather than silently fall back to the Beta provider.
      throw new Error(
        "ESIGN_PROVIDER=docusign is not yet implemented in this build. " +
          "Either unset the env var (defaults to 'mediflow') or wait for the " +
          "DocuSignESignProvider integration.",
      );
  }
}

/**
 * Boot-time HIPAA guard. Mirrors `assertAiProviderHipaaCompliant` and
 * `assertStorageBackendHipaaCompliant`. Called from the bootstrap path so a
 * misconfigured production deploy fails fast before the first envelope is
 * created.
 *
 * Today this only validates that `ESIGN_PROVIDER` parses to a known value —
 * the production-must-be-docusign assertion turns on in the follow-up PR
 * that ships `DocuSignESignProvider`. Wiring the call site now means
 * `index.ts` doesn't need a second edit then.
 */
export function assertEsignProviderHipaaCompliant(): void {
  // Side-effect: throws if ESIGN_PROVIDER is set to an unsupported value.
  readProviderEnv();
}
