export type ComplianceReasoningMode = "conservative" | "binary";

export const DEFAULT_COMPLIANCE_REASONING_MODE: ComplianceReasoningMode = "binary";

export function normalizeComplianceReasoningMode(value: unknown): ComplianceReasoningMode {
  return value === "binary" || value === "conservative" ? value : "conservative";
}

export function isBinaryReasoningMode(value: unknown): boolean {
  return normalizeComplianceReasoningMode(value) === "binary";
}
