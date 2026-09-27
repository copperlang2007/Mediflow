/**
 * agencyBRIDGE-look shared building blocks. Import from here in new/restyled
 * pages so every screen reads the same way:
 *
 *   import { PageHeader, KpiCard, MiniStat, SectionCard, StatusPill, EmptyState } from "@/components/shared";
 */
export { PageHeader } from "./PageHeader";
export { KpiCard, MiniStat, type KpiColor, type KpiTrend } from "./KpiCard";
export { SectionCard } from "./SectionCard";
export { StatusPill, statusTone, humanizeStatus, type StatusTone } from "./StatusPill";
export { EmptyState } from "./EmptyState";
export { SensitiveValue, maskSensitive, isAlreadyMasked, type SensitiveKind } from "./SensitiveValue";
