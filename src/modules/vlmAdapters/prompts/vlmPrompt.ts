// src/modules/vlmAdapters/prompts/vlmPrompt.ts
// Obsolete prompt builder; basePrompt.ts keeps the active implementation.

import type { EvidenceView, VlmFollowUp, VlmVerdict } from "../../vlmChecker";

export type VlmDecisionJson = {
  verdict: VlmVerdict;
  confidence: number; // range 0 to 1
  rationale: string;

  // VLM describes visible evidence and refers to nav metrics when present.
  visibility: {
    isRuleTargetVisible: boolean;
    occlusionAssessment: "LOW" | "MEDIUM" | "HIGH";
    missingEvidence?: string[];
  };

  followUp?: VlmFollowUp;

  evidence: {
    snapshotIds: string[]; // subset of the input evidence IDs, preserving order
    note?: string;
  };
};

export function buildDeterministicVlmPrompt(args: {
  ruleText: string;
  evidenceViews: EvidenceView[];
  allowedFollowUps: VlmFollowUp["request"][];
  step: number;
  maxSteps: number;
  minConfidence: number;
}) {
  // Deterministic JSON payload with stable key ordering.
  const payload = {
    ruleText: args.ruleText,
    step: args.step,
    maxSteps: args.maxSteps,
    minConfidence: args.minConfidence,
    evidenceViews: args.evidenceViews.map(v => ({
      snapshotId: v.snapshotId,
      mode: v.mode,
      note: v.note ?? "",
      nav: v.nav ?? null, // navigation owns these metrics
    })),
    allowedFollowUps: args.allowedFollowUps,
    outputSchema: {
      verdict: ["PASS", "FAIL", "UNCERTAIN"],
      confidence: "number(0..1)",
      rationale: "string",
      visibility: {
        isRuleTargetVisible: "boolean",
        occlusionAssessment: ["LOW", "MEDIUM", "HIGH"],
        missingEvidence: "string[] optional",
      },
      followUp: "optional VlmFollowUp",
      evidence: {
        snapshotIds: "string[] from evidenceViews.snapshotId",
        note: "string optional",
      },
    },
  };

  // Provider-agnostic instruction block with no tool calls assumed.
  // Determinism rules: JSON only, no markdown, and no extra keys.
  const system = [
    "You are a compliance vision-language model for IFC model snapshots.",
    "Return ONLY valid JSON. No markdown. No extra keys.",
    "Be deterministic: use ONLY the provided ruleText + evidenceViews + nav metrics.",
    "Do NOT infer hidden geometry. If something is not visible or is occluded, say UNCERTAIN and request a follow-up.",
    "Navigation metrics (projectedAreaRatio, occlusionRatio, convergenceScore) are authoritative for visibility/occlusion; do not guess them.",
    "Choose verdict:",
    "- PASS: rule clearly satisfied in visible evidence.",
    "- FAIL: rule clearly violated in visible evidence.",
    "- UNCERTAIN: evidence insufficient/occluded/ambiguous.",
    "Confidence meaning:",
    "- 0.0 = no confidence, 1.0 = absolute confidence.",
    "If verdict is UNCERTAIN OR confidence < minConfidence, request exactly one followUp from allowedFollowUps when helpful.",
    "If no followUp would help, omit followUp.",
    // ISOLATE_CATEGORY is intentionally omitted from VLM guidance; it is tree UI only for now.
    "For NAVIGATE_TO, do not invent locations; only request if you think a better view would help.",
    "In evidence.note, briefly explain which parts of the evidence were most relevant to your decision.",
  ].join("\n");

  const user = JSON.stringify(payload);

  return { system, user };
}
