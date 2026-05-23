/**
 * Per-carrier PDF-template registry.
 *
 * The Day-3 `generatePlaceholderPaperwork` route fills the same dummy 1-page
 * template for every carrier. This registry replaces that with a lookup by
 * carrier name → the carrier-specific `CarrierTemplateConfig`, falling
 * back to `default.ts` when no match exists.
 *
 * Adding a new carrier:
 *   1. Create `./<carrier-slug>.ts` exporting `config: CarrierTemplateConfig`.
 *   2. Add a mapping entry in `CARRIER_NAME_TO_CONFIG` below.
 *   3. Drop the real PDF into `./fixtures/<templatePath>` when INSUREitALL
 *      delivers it (until then a stub is synthesized on the fly from the
 *      config — see `stubBuilder.ts`).
 *
 * Why name-based lookup instead of id-based? Carriers are seeded per-org
 * with random UUIDs (`carrierSeed.ts` → `randomUUID`), so the id is
 * org-local. The carrier NAME is the stable global identifier across orgs,
 * which is what the registry can key on.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { fillTemplateFromBytes, type PdfFieldMap } from "../pdfFiller";
import { config as aetnaConfig } from "./aetna";
import { config as anthemConfig } from "./anthem";
import { config as cignaConfig } from "./cigna";
import { config as defaultConfig } from "./default";
import { config as devotedConfig } from "./devoted";
import { config as humanaConfig } from "./humana";
import { config as unitedhealthConfig } from "./unitedhealth";
import { config as wellcareConfig } from "./wellcare";
import { buildStubPdfFromConfig } from "./stubBuilder";
import {
  resolveField,
  type CarrierTemplateConfig,
  type ResolveFieldContext,
} from "./types";

// Re-export for ergonomic callers.
export {
  resolveField,
  type CarrierTemplateConfig,
  type ResolveFieldContext,
  type FieldSource,
  type CarrierTemplateFieldBinding,
} from "./types";
export { buildStubPdfFromConfig, STUB_MARKER } from "./stubBuilder";

/**
 * Authoritative carrier name → config map. Keys MUST match the strings in
 * `lib/carrierSeed.ts::DEFAULT_CARRIERS` for the lookup to hit. Unknown
 * carriers (e.g. an admin who manually added a new carrier name) fall back
 * to `defaultConfig` via `getCarrierTemplate`.
 */
const CARRIER_NAME_TO_CONFIG: Record<string, CarrierTemplateConfig> = {
  Aetna: aetnaConfig,
  "Aetna/CVS": aetnaConfig,
  Humana: humanaConfig,
  UnitedHealth: unitedhealthConfig,
  "UnitedHealth/AARP": unitedhealthConfig,
  Anthem: anthemConfig,
  "Anthem/BCBS": anthemConfig,
  Cigna: cignaConfig,
  Wellcare: wellcareConfig,
  Devoted: devotedConfig,
};

/**
 * Returns the carrier-specific config, or `defaultConfig` when the carrier
 * has no dedicated file. Never returns null — callers can rely on always
 * getting SOME config back.
 */
export function getCarrierTemplate(carrierName: string): CarrierTemplateConfig {
  return CARRIER_NAME_TO_CONFIG[carrierName] ?? defaultConfig;
}

/**
 * Build the AcroForm field map for a given config from the context.
 * Honors the `literal` override and skips nulls (so blank fields stay
 * blank on the PDF rather than showing the word "null").
 */
export function buildFieldMap(
  config: CarrierTemplateConfig,
  ctx: ResolveFieldContext,
): PdfFieldMap {
  const out: PdfFieldMap = {};
  for (const binding of config.fields) {
    if (binding.literal !== undefined) {
      out[binding.name] = binding.literal;
      continue;
    }
    out[binding.name] = resolveField(binding.source, ctx);
  }
  return out;
}

/**
 * Load the template PDF bytes for a config. If the file at `templatePath`
 * does not exist (stub mode), synthesize one inline from the config — this
 * is the throwaway path that disappears once INSUREitALL delivers the real
 * PDFs.
 *
 * Cached per-config (by reference identity, which is stable for a process)
 * to avoid hitting the filesystem on every paperwork-generation call.
 */
const TEMPLATE_BYTES_CACHE = new WeakMap<CarrierTemplateConfig, Buffer>();

export async function loadCarrierTemplateBytes(
  config: CarrierTemplateConfig,
): Promise<Buffer> {
  const cached = TEMPLATE_BYTES_CACHE.get(config);
  if (cached) return cached;

  const fixturesDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
  );
  const full = path.join(fixturesDir, config.templatePath);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(full);
  } catch {
    // Stub mode — synthesize from the config.
    bytes = await buildStubPdfFromConfig(config);
  }

  TEMPLATE_BYTES_CACHE.set(config, bytes);
  return bytes;
}

/**
 * One-shot helper: pick the template for `carrierName`, build the field
 * map from `ctx`, fill the PDF, and return the bytes.
 *
 * This is the function `generateCarrierPaperwork` in routes/onboarding.ts
 * calls — keeping it here means the route stays small and the registry
 * owns the (lookup + load + fill) pipeline.
 */
export async function generateCarrierPaperworkPdf(
  carrierName: string,
  ctx: ResolveFieldContext,
): Promise<{
  bytes: Buffer;
  config: CarrierTemplateConfig;
  fieldMap: PdfFieldMap;
}> {
  const config = getCarrierTemplate(carrierName);
  const fieldMap = buildFieldMap(config, ctx);
  const templateBytes = await loadCarrierTemplateBytes(config);
  // `flatten: true` so carrier desks receive a non-editable PDF — same
  // posture as the Day-3 placeholder path.
  const bytes = await fillTemplateFromBytes(templateBytes, fieldMap, {
    flatten: true,
  });
  return { bytes, config, fieldMap };
}

/** Exposed for tests. */
export const __testing = {
  CARRIER_NAME_TO_CONFIG,
  defaultConfig,
  clearTemplateBytesCache(): void {
    // WeakMap has no clear(); reassign isn't possible since it's a const.
    // Tests that need a fresh cache can call this — it deletes every known
    // config entry, which is the entire universe of cache keys.
    for (const cfg of Object.values(CARRIER_NAME_TO_CONFIG)) {
      TEMPLATE_BYTES_CACHE.delete(cfg);
    }
    TEMPLATE_BYTES_CACHE.delete(defaultConfig);
  },
};
