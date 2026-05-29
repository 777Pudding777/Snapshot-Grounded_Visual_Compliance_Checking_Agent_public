import type { ComplianceRule } from "../../../types/rule.types";
import type { EvidenceRequirementKey } from "../../../types/evidenceRequirements.types";
import type { ComplianceReasoningMode } from "../../../types/reasoning.types";
import { normalizeComplianceReasoningMode } from "../../../types/reasoning.types";
import { assessRuleRegulatoryGrounding } from "../../regulatoryContext";
import { PLAN_CUT_FOLLOW_UPS_ENABLED } from "../../../config/prototypeSettings";

export type WrapPromptInput = {
  taskPrompt: string;
  evidenceViewsJson: string;
  imageIndexJson?: string;
  reasoningMode?: ComplianceReasoningMode;
};

function buildPromptCore(args: {
  mode: "base" | "enhanced";
  taskPrompt: string;
  evidenceViewsJson: string;
  imageIndexJson?: string;
  reasoningMode?: ComplianceReasoningMode;
}): string {
  const { mode, taskPrompt, evidenceViewsJson, imageIndexJson } = args;
  const reasoningMode = normalizeComplianceReasoningMode(args.reasoningMode);
  const binaryMode = reasoningMode === "binary";
  const followUpActionReference = [
    "FOLLOW-UP ACTION CONTRACT:",
    "- You may include followUp when one executable viewer action would materially improve missing evidence. The runtime may still override repeated, disabled, or low-novelty actions.",
    "- Use only the action names below. Do not invent action names. Do not request ISOLATE_CATEGORY; category isolation is disabled in compliance runs.",
    "- params must contain only the fields shown for the selected action. Use ids/storeyId/spaceId exactly as provided in evidenceViews.context, DYNAMIC_CHECKLIST, availableStoreys, availableSpaces, activeEntity, highlightedIds, or visible metadata.",
    "- Prefer reporting evidenceRequirementsStatus first, then add followUp when the right action is obvious.",
    "",
    "Scope and Visibility:",
    "- ISOLATE_STOREY: show only one building storey. params: { \"storeyId\": string }. Use when activeStorey is known and the target is hidden among other levels, when a plan/layout check is storey-specific, or before checking repeated entities on the same level.",
    "- ISOLATE_SPACE: show only one room/space. params: { \"spaceId\": string }. Use when a room/space boundary or interior clearance must be inspected and spaceId is available.",
    "- RESET_VISIBILITY: restore the default model visibility and clear isolation/hidden state. No params. Use when prior hiding/isolation removed needed context.",
    "- HIDE_CATEGORY: hide an occluding IFC category. params: { \"category\": string, \"reason\"?: string }. Use for broad occluders such as IfcSlab, IfcCovering, IfcRoof, IfcWall, or IfcFurnishingElement when they block the target or clearance zone.",
    "- SHOW_CATEGORY: restore a hidden category. params: { \"category\": string }. Use when hidden context is needed again.",
    "- HIDE_IDS: hide specific occluding elements. params: { \"ids\": string[], \"reason\"?: string }. Use for known blocker ids.",
    "- SHOW_IDS: restore specific hidden elements. params: { \"ids\": string[] }.",
    "- HIDE_SELECTED: hide the currently selected/highlighted element. No params. Use only when the selected element is an occluder rather than the rule target.",
    "",
    "Target Focus and Metadata:",
    "- HIGHLIGHT_IDS: highlight candidate target elements. params: { \"ids\": string[], \"style\"?: \"primary\" | \"warn\" }. Preferred when activeEntity is known but not visually obvious or when the next entity should become the focus.",
    "- ZOOM_IN: move closer to the current camera target or highlighted target. params: { \"factor\"?: number }. Use at most once per entity and never when evidenceViews.nav.zoomPotentialExhausted is true.",
    "- PICK_CENTER: legacy fallback that asks runtime to highlight likely central/focus candidates. params optional: { \"reason\"?: string }. Prefer HIGHLIGHT_IDS when ids are available.",
    "- PICK_OBJECT: legacy fallback that maps to candidate highlighting. params: { \"x\": number, \"y\": number }. Avoid unless explicit screen coordinates are meaningful.",
    "- GET_PROPERTIES: request modeled properties for an object id. params: { \"objectId\": string }. Use for missing IFC/property context, not as a substitute for visual measurement.",
    "",
    "View and Camera:",
    "- TOP_VIEW: switch to a plan-like top view. No params. Use for floor clearances, door swings, corridor widths, turning spaces, and other plan-based relationships.",
    "- ISO_VIEW: switch to isometric overview. No params. Use for overall 3D context, vertical relationships, stairs, ramps, guards, and occlusion diagnosis.",
    "- SET_VIEW_PRESET: explicit preset. params: { \"preset\": \"TOP\" | \"ISO\" | \"ORBIT\" }. Prefer TOP_VIEW or ISO_VIEW unless a preset field is specifically useful.",
    "- ORBIT: initial bounded entity-centered alternate angle. params: { \"yawDegrees\"?: number, \"pitchDegrees\"?: number, \"degrees\"?: number, \"reason\"?: string }. Use after the target is highlighted/focused and context side evidence is missing; each angle must be within +/-90 degrees.",
    "- ORBIT_90: quarter-turn confirmation after at least one ORBIT for the same entity. params: { \"direction\"?: \"left\" | \"right\", \"reason\"?: string }.",
    "- ORBIT_180: opposite-side confirmation after at least one ORBIT for the same entity. params: { \"reason\"?: string }. Use when both sides or surrounding context are needed.",
    "- NEW_VIEW: generic different angle. params optional: { \"reason\"?: string }. Use only when no more specific view/focus/scope action fits.",
    "- RESTORE_VIEW: restore a previous bookmark/snapshot view. params: { \"step\"?: number, \"snapshotId\"?: string, \"bookmarkId\"?: string }. Use only when a previous view had needed context that was lost.",
    "",
    "Plan Cut:",
    PLAN_CUT_FOLLOW_UPS_ENABLED
      ? "- SET_STOREY_PLAN_CUT: isolate a storey and clip above floor height for CAD-like plan evidence. params: { \"storeyId\": string, \"offsetFromFloor\"?: number, \"mode\"?: \"WORLD_UP\" | \"CAMERA\" }. Use after TOP_VIEW when local floor/door/clearance context is still unreadable."
      : "- SET_STOREY_PLAN_CUT is currently disabled at runtime. Do not request it; request TOP_VIEW, ISOLATE_STOREY, HIGHLIGHT_IDS, HIDE_CATEGORY/HIDE_IDS, or ORBIT instead.",
    PLAN_CUT_FOLLOW_UPS_ENABLED
      ? "- SET_PLAN_CUT: general clipping plane. params: { \"height\": number, \"thickness\"?: number, \"mode\"?: \"WORLD_UP\" | \"CAMERA\" }. Prefer SET_STOREY_PLAN_CUT when a storeyId is known."
      : "- SET_PLAN_CUT is currently disabled at runtime. Do not request it.",
    PLAN_CUT_FOLLOW_UPS_ENABLED
      ? "- CLEAR_PLAN_CUT: remove active clipping. No params."
      : "- CLEAR_PLAN_CUT is currently disabled at runtime. Do not request it.",
    "",
    "Web and Regulatory Text:",
    "- WEB_FETCH: fetch authoritative clause text. params: { \"url\": string, \"maxChars\"?: number, \"selector\"?: string, \"focus\"?: { \"contains\"?: string[], \"windowChars\"?: number } }. Use only when local ruleLibrary/prompt context lacks thresholds, definitions, or exceptions.",
    "",
    "Common Evidence Sequences:",
    "- Storey-specific target not ready: ISOLATE_STOREY(activeStorey) -> HIGHLIGHT_IDS(activeEntity) -> ZOOM_IN or TOP_VIEW depending on the missing evidence.",
    "- Door or clearance check: ISOLATE_STOREY(activeStorey) -> HIGHLIGHT_IDS(activeEntity) -> TOP_VIEW -> remove occluders if needed -> ORBIT/ORBIT_180 only for side/surrounding confirmation.",
    "- Stair/ramp/guard check: HIGHLIGHT_IDS(activeEntity) -> ISO_VIEW or ORBIT for context -> TOP_VIEW only if plan width/landing relationship is still needed.",
    "- Occlusion problem: HIDE_CATEGORY broad blocker first; use HIDE_IDS only when blocker ids are known.",
    "- Missing rule text: WEB_FETCH only from AllowedSources; otherwise explain the missing clause in missingEvidence.",
  ];

  const workflow =
    mode === "enhanced"
      ? [
          "WORKFLOW (expert guidance):",
          "1) Read the task as an inspection mission: identify the target class, the measurable question, the likely storey/space focus, and any special hint from the user prompt.",
          "2) Treat DYNAMIC_CHECKLIST as a compact runtime task brief inferred from prompt text, runtime evidence, and any grounded regulatory context. Use activeTask, activeEntity, activeStorey, and progress only; ignore completed or unrelated work.",
          "3) Focus on evidence requirements, not navigation recipes. Report what is still missing or not ready, especially visibility, measurement readiness, surrounding-context readiness, occlusion, and regulatory context.",
          "4) Treat evidenceViews.context.evidenceRequirements as the generalized runtime evidence state. If present, update or confirm that status instead of inventing a rule-specific action sequence.",
          "5) Use evidenceViews.context.activeEntity, currentView, visualReference.targetMetadata, navigationQuality, semanticProgress, and runtimeNotice as the compact runtime evidence summary for the latest snapshot.",
          "6) If floor-based clearance cannot be grounded because local floor context is missing, describe that as a plan-measurement readiness gap rather than prescribing a specific tool unless a follow-up suggestion is still helpful.",
          "7) Use side or oblique views as confirmation evidence after a readable measurement-oriented view, not as the primary basis for plan-based measurements.",
          "8) When the user prompt mentions a storey, level, side, or specific inspection strategy, prioritize that hint if compatible with the visible evidence and available storeys.",
          "9) If SOURCE: RULE_LIBRARY is present, treat the injected ruleLibrary thresholds, references, dimensional notes, and evaluation criteria as authoritative local regulatory context for this predefined check.",
          "10) Do not say that regulatory context is absent when local ruleLibrary context is present. Distinguish local ruleLibrary grounding from externally fetched web evidence.",
          "11) Only report regulatoryClauseNeeded when thresholds, clause text, definitions, or exceptions are still missing after considering the local ruleLibrary context or prompt-provided grounding.",
          binaryMode
            ? "12) If repeated targeted evidence is still incomplete, choose the more evidence-supported binary verdict; do not emit an uncertainty verdict."
            : "12) If repeated targeted evidence is still insufficient for PASS or FAIL, it is acceptable to stay UNCERTAIN for the active entity rather than forcing more unproductive navigation.",
          "13) followUp is advisory to the runtime, but include one when a concrete executable action would resolve the reported evidence gap.",
        ]
      : [
          "WORKFLOW:",
          "1) Interpret the requirement: identify target elements, measurable constraints, units, thresholds, and applicability.",
          "2) Use DYNAMIC_CHECKLIST only as the current task brief. Focus on the active target if one is provided.",
          "3) Check whether the target is visible, focused, and measurable enough from the current evidence.",
          "4) If measurable, evaluate PASS or FAIL from visible evidence plus authoritative nav/context values.",
          binaryMode
            ? "5) If not fully measurable, still choose PASS or FAIL from the strongest available evidence and report missingEvidence plus evidenceRequirementsStatus."
            : "5) If not measurable, return UNCERTAIN and report missingEvidence plus evidenceRequirementsStatus.",
          "6) If SOURCE: RULE_LIBRARY is present, treat the injected ruleLibrary thresholds, references, and evaluation criteria as authoritative local regulatory context.",
          "7) Absence of fetched web evidence does not mean absence of regulatory context when local ruleLibrary context is already provided.",
          "8) Only report regulatoryClauseNeeded when clause text, thresholds, or definitions are still missing after considering local ruleLibrary or prompt-provided grounding.",
          "9) followUp is optional and advisory, but include one when a concrete executable action would resolve the reported evidence gap.",
          binaryMode
            ? "10) If multiple targeted attempts have not made the active entity fully measurable, make the most defensible PASS/FAIL call rather than repeating low-value navigation."
            : "10) If multiple targeted attempts have already failed to make the active entity measurable, remain UNCERTAIN rather than repeating low-value navigation.",
        ];

  return [
    "SYSTEM ROLE:",
    "You are a BIM compliance vision checker for IFC/BIM models.",
    "Goal: determine compliance for the given requirement using only provided evidence and model interactions.",
    "",
    "NON-NEGOTIABLES:",
    "- Do not guess geometry or dimensions.",
    "- Treat evidenceViews.nav and evidenceViews.context as authoritative runtime evidence.",
    "- If evidenceViews.context.visualReference.targetMetadata is present, use it as snapshot reference metadata for the active target, but do not treat neutral bounding-box dimensions as semantic width/depth unless the image and annotations confirm that mapping.",
    "- Treat BIM scene metadata, IFC properties, HUD values, and viewer overlay annotations as the existing modeled condition. Do not ask what the condition should be when the compliance task is to assess whether the existing condition satisfies the rule.",
    "- For doors, swing/opening annotations describe the current door operation, hinge/latch side, push side, pull side, and swing arc. Use them to decide which clearance zones and obstructions to inspect; do not require an external 'correct opening direction' unless the rule text explicitly defines a required swing direction.",
    "- If compact context is unavailable because debug fallback used the full trace context, prefer the smallest directly relevant legacy fields and ignore unrelated debug internals.",
    "- If evidenceViews.nav.zoomPotentialExhausted is true for the latest step, do not request another generic ZOOM_IN for that entity. Work with the current evidence, request a different view type, or remain UNCERTAIN.",
    "- If a top HUD/info tab is visible, treat its IFC class, object id, neutral bounding-box dimensions, and color legend as explicit snapshot reference evidence.",
    "- Use the visible viewer grid as the primary dimensional reference whenever it is clearly visible: 1 primary cell = 1 m x 1 m, 1 major cell = 10 m x 10 m.",
    "- HUD BBox A/B or legacy W/D values are horizontal bounding-box extents, not guaranteed rule semantics. For stairs, ramps, corridors, doors, and windows, determine the rule-relevant width/depth/run/sill dimension from the snapshots, grid, highlight shape, run-axis/swing annotations, and view direction.",
    binaryMode
      ? "- It is acceptable to estimate dimensions from pixel proportions against visible 1 m grid cells or neutral HUD/object bbox extents; state limitations without using an uncertainty verdict."
      : "- It is acceptable to estimate dimensions from pixel proportions against the visible 1 m grid cells or neutral HUD/object bbox extents; state uncertainty if the perspective makes the estimate unreliable.",
    binaryMode
      ? "- If a measurable requirement cannot be fully grounded from visible evidence plus nav/context values, choose the most evidence-supported PASS or FAIL."
      : "- If a measurable requirement cannot be grounded from visible evidence plus nav/context values, return UNCERTAIN.",
    binaryMode ? "- Binary mode is active: verdict MUST be exactly PASS or FAIL. Never output UNCERTAIN." : "",
    binaryMode ? "- Missing evidence is not automatically a failure. If a missing item is outside the configured/rule-relevant scope, say so in missingEvidence or rationale and choose the verdict from the strongest configured evidence." : "",
    "- Return only valid JSON with no markdown, commentary, or extra keys.",
    "",
    ...workflow,
    "",
    "WEB / REFERENCE POLICY:",
    "- Treat local ruleLibrary context as the default regulatory basis for predefined rule checks.",
    "- Keep external web evidence separate from local ruleLibrary context in your reasoning and wording.",
    "- If AllowedSources or allowlisted domains are provided and clause text is needed, use WEB_FETCH from those sources.",
    "- If no allowlist is provided, do not browse; ask for the missing clause or definition in the rationale or follow-up.",
    "- If SOURCE: RULE_LIBRARY is present and local rule thresholds appear usable, do not request WEB_FETCH unless the local rule context is still insufficient.",
    "- If the requirement is vague on thresholds, section number, or edition, prioritize WEB_FETCH before model navigation only when local grounding is still insufficient.",
    "- Prefer authoritative code repositories over summaries.",
    "",
    "FOLLOW-UP ADVISORY REFERENCE:",
    "- Prefer top-level missingEvidence and evidenceRequirementsStatus as the main control output.",
    "- followUp is optional, but include it when a specific executable action clearly matches the missing evidence.",
    "- Use WEB_FETCH only when regulatory clause text, definitions, or exceptions are missing.",
    "- Use scope/focus suggestions such as ISOLATE_STOREY, HIGHLIGHT_IDS, or ZOOM_IN when the target is not visible, not storey-scoped, or not focused.",
    PLAN_CUT_FOLLOW_UPS_ENABLED
      ? "- Use plan-oriented suggestions such as TOP_VIEW or SET_STOREY_PLAN_CUT only when a plan-based measurement state is still not ready."
      : "- Use TOP_VIEW for plan-oriented checks; plan-cut follow-ups are temporarily disabled.",
    "- Use ORBIT or NEW_VIEW only when another context angle is needed after the target is already reasonably focused.",
    "- Use ORBIT for the initial entity-centered orbit stage. ORBIT_90 and ORBIT_180 become meaningful only after at least one generic ORBIT has already run for that same entity; from TOP_VIEW alone they can be redundant image rotations.",
    "- ORBIT_90 and ORBIT_180 are allowed after any generic ORBIT. They are executed relative to the latest executed orbit pose for the same entity, not relative to the current view if the current view has since changed to TOP_VIEW or another preset.",
    "- Separately, generic ORBIT itself is capped at two initial calls per entity; after that, further generic ORBIT requests are forwarded to ORBIT_90 or ORBIT_180.",
    "- ORBIT_90 and ORBIT_180 are confirmation presets, not first-step navigation. Prefer ORBIT_180 when both sides or surrounding context are specifically needed.",
    "",
    ...followUpActionReference,
    "",
    "JSON shape:",
    "{",
    binaryMode ? '  "verdict": "PASS" | "FAIL",' : '  "verdict": "PASS" | "FAIL" | "UNCERTAIN",',
    '  "confidence": number,',
    '  "rationale": string,',
    '  "missingEvidence"?: string[],',
    '  "evidenceRequirementsStatus"?: {',
    '    "targetVisible"?: boolean,',
    '    "targetFocused"?: boolean,',
    '    "planMeasurementNeeded"?: boolean,',
    '    "planMeasurementReady"?: boolean,',
    '    "contextViewNeeded"?: boolean,',
    '    "contextViewReady"?: boolean,',
    '    "obstructionContextNeeded"?: boolean,',
    '    "dimensionReferenceNeeded"?: boolean,',
    '    "regulatoryClauseNeeded"?: boolean,',
    '    "occlusionProblem"?: boolean,',
    '    "lowNoveltyOrRepeatedView"?: boolean,',
    '    "bothSidesOrSurroundingsNeeded"?: boolean',
    "  },",
    '  "visibility": { "isRuleTargetVisible": boolean, "occlusionAssessment": "LOW"|"MEDIUM"|"HIGH", "missingEvidence"?: string[] },',
    '  "evidence": { "snapshotIds": string[], "mode": string, "note"?: string },',
    '  "followUp"?: { "request": "<ACTION_NAME>", "params"?: object }',
    "}",
    "Rules:",
    "- confidence must be within [0,1].",
    ...(binaryMode ? ["- Verdict must be PASS or FAIL only, even when evidence is incomplete."] : []),
    ...(binaryMode ? ["- Do not fail a check only because an unconfigured or visually unrepresented sub-check is unavailable; identify it as not evaluated/out of scope and base the verdict on configured rule-relevant evidence."] : []),
    "- Rationale must be short and evidence-grounded.",
    "- If you used WEB_EVIDENCE, mention the clause identifier or section briefly in the rationale.",
    "- If local ruleLibrary context is present, you may say that no external web evidence was fetched, but you must not say that no regulatory context was provided.",
    "- Use compact target metadata as starting context: active entity identity, view state, target metadata dimensions/legend, evidence requirements, and semantic/runtime warnings. Verify dimension semantics visually before using a bbox extent as rule evidence.",
    "- If door swing/opening metadata or annotations are present, treat opening direction as resolved for orientation purposes. The remaining question is whether the modeled swing, latch side, push/pull side clearances, swing path, and surrounding obstructions comply.",
    binaryMode
      ? "- Do not avoid a binary verdict merely because the rule does not state which way a door is supposed to open. Only require that if the source rule contains a directional requirement or exception that cannot be evaluated from local context."
      : "- Do not return UNCERTAIN merely because the rule does not state which way a door is supposed to open. Only require that if the source rule contains a directional requirement or exception that cannot be evaluated from local context.",
    "- If accessible-door clearance remains incomplete, ask for dimensioned surrounding/clearance evidence such as plan measurement readiness, local floor context, grid visibility, or obstruction context. Do not ask for generic regulatory/web evidence when local ruleLibrary thresholds already ground the rule.",
    binaryMode
      ? "- When clearance context is incomplete, still choose PASS or FAIL and report the precise missing evidenceRequirementsStatus fields."
      : "- A high-confidence UNCERTAIN is acceptable when the evidence clearly shows that clearance context is incomplete. Do not reduce confidence artificially; instead report the precise missing evidenceRequirementsStatus fields.",
    "- In debug fallback mode, legacy highlightAnnotations or HUD blocks may appear; use them only as reference evidence, not as a reason to discuss unrelated trace internals.",
    "- If the readiness signal says the highlighted door is measurableLikely, do not ask for another near-duplicate zoom or angle unless a specific missing evidence item still requires it.",
    "- Apply the same anti-repeat rule to every entity class: once focused zoom potential is exhausted, prefer another action or finish the entity as inconclusive rather than repeating ZOOM_IN.",
    "- After the initial ORBIT quota has been used for the active entity, prefer ORBIT_90 or ORBIT_180 over repeating generic ORBIT when a distinct side/opposite-side view is needed.",
    "- Prefer one focused evidence statement over repeated broad navigation language.",
    "- For occluders like slabs or ceilings, describe the obstruction context gap explicitly before suggesting an occlusion-removal action.",
    "- If you include followUp, it should be exactly one request that most efficiently resolves the missing evidence.",
    "- Missing evidence and evidenceRequirementsStatus are more important than followUp.",
    "evidenceViews:",
    evidenceViewsJson,
    "",
    ...(imageIndexJson ? ["imageIndex:", imageIndexJson, ""] : []),
    "TASK PROMPT:",
    taskPrompt,
  ].join("\n");
}

export function wrapPromptBase(input: WrapPromptInput): string {
  return buildPromptCore({ ...input, mode: "base" });
}

export function wrapPromptEnhanced(input: WrapPromptInput): string {
  return buildPromptCore({ ...input, mode: "enhanced" });
}

export function wrapPromptBaseBinary(input: WrapPromptInput): string {
  return buildPromptCore({ ...input, mode: "base", reasoningMode: "binary" });
}

export function wrapPromptEnhancedBinary(input: WrapPromptInput): string {
  return buildPromptCore({ ...input, mode: "enhanced", reasoningMode: "binary" });
}

function parsePromptLineValue(text: string, key: string): string | undefined {
  const match = String(text ?? "").match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

function extractSourcePromptText(taskPrompt: string): string {
  const marker = "SOURCE_PROMPT_TEXT:";
  const markerIndex = taskPrompt.indexOf(marker);
  if (markerIndex < 0) return taskPrompt.trim();
  return taskPrompt.slice(markerIndex + marker.length).trim();
}

function extractPromptSummaryText(sourceText: string): string | undefined {
  const description = parsePromptLineValue(sourceText, "DESCRIPTION");
  if (description) return description;

  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^[A-Z][A-Z _-]+:?$/.test(line) &&
        !line.startsWith("- ") &&
        !/^SOURCE RULE:?$/i.test(line)
    );

  return lines.find((line) => !line.startsWith("COMPLIANCE RULE:") && !line.startsWith("INSPECTION_INPUT_CONTEXT:"));
}

function inferConcernKeywordsFromPrompt(text: string): string[] {
  const normalized = text.toLowerCase();
  const mappings: Array<{ key: string; match: RegExp }> = [
    { key: "visibility", match: /\bvisible|visibility|focus(ed)?\b/ },
    { key: "clearance", match: /\bclearance|maneuver|turning\b/ },
    { key: "dimensions", match: /\bmeasure|dimension|width|height|depth|headroom\b/ },
    { key: "landing", match: /\blanding|approach\b/ },
    { key: "handrail", match: /\b(handrail|railing|guardrail)\b/ },
    { key: "fall_hazard", match: /\b(fall hazard|height difference|drop|elevated|lower level)\b/ },
    { key: "edge_guarding", match: /\b(open edge|exposed edge|edge protection|guarding|parapet|guardrail|railing)\b/ },
    { key: "slope", match: /\bslope|gradient|ramp\b/ },
    { key: "accessibility", match: /\baccessible|accessibility|wheelchair|ada\b/ },
    { key: "egress_width", match: /\begress\b/ },
    { key: "regulatory_context", match: /\bsection|clause|standard|ibc|icc|a117\b/ },
  ];

  return mappings.filter((item) => item.match.test(normalized)).map((item) => item.key);
}

function extractDimensionalThresholds(text: string): string[] {
  const matches = text.match(/\b\d+(?:\.\d+)?\s?(?:mm|cm|m|in|ft|%)\b/gi) ?? [];
  return Array.from(new Set(matches.map((item) => item.trim()))).slice(0, 6);
}

/**
 * Compact follow-up rule context builder.
 * Keeps full source prompt text in trace exports while shrinking repeated rule
 * text that gets sent back to the VLM on later steps.
 */
export function buildCompactFollowUpTaskPrompt(args: {
  fullTaskPrompt: string;
  activeTaskTitle?: string;
  activeEntityId?: string;
  activeEntityClass?: string;
  activeStoreyId?: string;
  activeConcerns?: string[];
}): string {
  const fullTaskPrompt = String(args.fullTaskPrompt ?? "").trim();
  if (!fullTaskPrompt) return fullTaskPrompt;

  const marker = "SOURCE_PROMPT_TEXT:";
  const markerIndex = fullTaskPrompt.indexOf(marker);
  const prefix =
    markerIndex >= 0
      ? fullTaskPrompt.slice(0, markerIndex + marker.length).trimEnd()
      : `${fullTaskPrompt}\n\n${marker}`;

  const sourceText = extractSourcePromptText(fullTaskPrompt);
  const ruleId = parsePromptLineValue(fullTaskPrompt, "RULE_ID");
  const ruleTitle =
    parsePromptLineValue(fullTaskPrompt, "RULE_TITLE") ??
    parsePromptLineValue(sourceText, "COMPLIANCE RULE") ??
    "Inspection follow-up";
  const summary = extractPromptSummaryText(sourceText);
  const concerns = (args.activeConcerns?.length ? args.activeConcerns : inferConcernKeywordsFromPrompt(sourceText)).slice(0, 6);
  const thresholds = extractDimensionalThresholds(sourceText);

  const compactLines = [
    "FOLLOW_UP_RULE_CONTEXT:",
    `- ruleTitle: ${ruleTitle}`,
    ...(ruleId ? [`- ruleId: ${ruleId}`] : []),
    ...(summary ? [`- ruleSummary: ${summary}`] : []),
    `- activeConcerns: ${concerns.join(", ") || "none"}`,
    `- dimensionalThresholds: ${thresholds.join(", ") || "none stated"}`,
    `- currentActiveTask: ${args.activeTaskTitle ?? "unspecified"}`,
    `- activeEntity: ${args.activeEntityId ?? "unspecified"}`,
    `- activeEntityClass: ${args.activeEntityClass ?? "unspecified"}`,
    `- activeStorey: ${args.activeStoreyId ?? "unspecified"}`,
    "- followUpRuleContextMode: compact_summary_after_step_1",
  ];

  return [prefix, ...compactLines].join("\n");
}

function formatList(items: string[] | undefined): string[] {
  return Array.isArray(items) ? items.filter(Boolean).map((item) => `- ${item}`) : [];
}

function collectRuleText(rule: ComplianceRule): string {
  return `${rule.title} ${rule.description} ${rule.tags.join(" ")} ${rule.navigationHints.recommendedViews.join(" ")} ${rule.navigationHints.tips.join(" ")}`
    .toLowerCase();
}

type RuleTargetProfile =
  | "door"
  | "stair"
  | "ramp"
  | "window"
  | "space"
  | "object"
  | "visibility"
  | "headroom"
  | "guard"
  | "egress"
  | "generic";

function inferRuleTargetProfile(rule: ComplianceRule): RuleTargetProfile {
  const id = String(rule.id ?? "").toLowerCase();
  const solibriId = String(rule.source?.solibriId ?? "").toLowerCase();
  const title = String(rule.title ?? "").toLowerCase();
  const tags = (rule.tags ?? []).map((tag) => String(tag).toLowerCase());

  if (
    id.includes("guard") ||
    solibriId === "sol-236" ||
    title.includes("guarding against falling") ||
    title.includes("horizontal structures must be guarded") ||
    tags.includes("fall protection") ||
    tags.includes("edge protection")
  ) {
    return "guard";
  }
  if (id.includes("headroom") || solibriId === "sol-252" || title.includes("headroom")) return "headroom";
  if (id.includes("ramp") || solibriId === "sol-207" || title.includes("ramp") || tags.includes("ramp")) return "ramp";
  if (id.includes("stair") || solibriId === "sol-210" || title.includes("stair") || tags.includes("stairs")) return "stair";
  if (id.includes("door") || solibriId === "sol-208" || title.includes("door") || tags.includes("door")) return "door";
  if (id.includes("window") || solibriId === "sol-211" || title.includes("window") || tags.includes("window")) return "window";
  if (solibriId === "sol-247" || title.includes("local accessible circulation") || tags.includes("corridor")) return "space";
  if (id.includes("floor") || solibriId === "sol-209" || title.includes("free floor space")) return "space";
  if (solibriId === "sol-226" || title.includes("free area in front of components")) return "object";
  if (id.includes("object") || solibriId === "sol-248" || title.includes("around objects")) return "object";
  if (id.includes("visibility") || solibriId === "sol-250" || title.includes("visibility")) return "visibility";
  if (title.includes("egress") || tags.includes("egress")) return "egress";
  return "generic";
}

function inferRuleTargetClasses(rule: ComplianceRule, profile = inferRuleTargetProfile(rule)): string[] {
  if (profile === "ramp") return ["IFCRAMPFLIGHT", "IFCRAMP"];
  if (profile === "stair") return ["IFCSTAIRFLIGHT", "IFCSTAIR"];
  if (profile === "door") return ["IFCDOOR"];
  if (profile === "window") return ["IFCWINDOW"];
  if (profile === "space") return ["IFCSPACE"];
  if (profile === "guard") return ["IFCSLAB", "IFCROOF"];
  if (profile === "object") {
    const excludedTargetClasses =
      String(rule.source?.solibriId ?? "").toLowerCase() === "sol-226"
        ? /IFCDOOR|IFCWINDOW|IFCWALL|IFCSLAB|IFCSPACE/i
        : /IFCWALL|IFCSLAB|IFCSPACE/i;
    return rule.navigationHints.isolateCategories?.filter((item) => !excludedTargetClasses.test(item)) ?? [];
  }
  return [];
}

function buildEvidenceRequirementList(keys: EvidenceRequirementKey[]): string[] {
  return Array.from(new Set(keys)).map((key) => `- ${key}`);
}

function inferEvidenceRequirements(rule: ComplianceRule): EvidenceRequirementKey[] {
  const text = collectRuleText(rule);
  const profile = inferRuleTargetProfile(rule);
  const requirements = new Set<EvidenceRequirementKey>(["targetVisible", "targetFocused"]);
  const regulatoryGrounding = assessRuleRegulatoryGrounding(rule);

  const mentionsPlan =
    text.includes("top view") ||
    text.includes("plan") ||
    text.includes("clearance") ||
    text.includes("layout") ||
    text.includes("swing") ||
    Boolean(rule.navigationHints.usePlanCut);
  const mentionsContext =
    text.includes("oblique") ||
    text.includes("side") ||
    text.includes("angle") ||
    text.includes("surround") ||
    text.includes("landing") ||
    text.includes("approach");
  const mentionsDimensions =
    text.includes("dimension") ||
    text.includes("measure") ||
    text.includes("width") ||
    text.includes("height") ||
    text.includes("depth") ||
    Boolean(rule.dimensionalRequirements?.length);
  const mentionsOcclusion =
    text.includes("occlusion") ||
    text.includes("obstruction") ||
    text.includes("hidden") ||
    text.includes("clutter") ||
    text.includes("surrounding elements");
  const mentionsRegulatory =
    text.includes("ada") ||
    text.includes("icc") ||
    text.includes("ibc") ||
    text.includes("a117") ||
    text.includes("clause") ||
    text.includes("section") ||
    text.includes("standard");
  const mentionsBothSides =
    text.includes("both sides") ||
    text.includes("surroundings") ||
    text.includes("clear floor space") ||
    text.includes("maneuvering");

  if (mentionsPlan) requirements.add("planMeasurementNeeded");
  if (mentionsContext) requirements.add("contextViewNeeded");
  if (mentionsDimensions) requirements.add("dimensionReferenceNeeded");
  if (mentionsOcclusion) requirements.add("obstructionContextNeeded");
  // Rule-library context already carries the default regulatory grounding for
  // predefined checks. Only pre-mark clause grounding as missing when the local
  // rule itself does not provide usable criteria or references.
  if (mentionsRegulatory && !regulatoryGrounding.hasUsableLocalGrounding) {
    requirements.add("regulatoryClauseNeeded");
  }
  if (mentionsBothSides) requirements.add("bothSidesOrSurroundingsNeeded");

  if (profile === "door") {
    requirements.add("planMeasurementNeeded");
    requirements.add("contextViewNeeded");
    requirements.add("obstructionContextNeeded");
    requirements.add("bothSidesOrSurroundingsNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (profile === "window") {
    requirements.add("planMeasurementNeeded");
    requirements.add("contextViewNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (profile === "stair") {
    requirements.add("contextViewNeeded");
    requirements.add("obstructionContextNeeded");
    requirements.add("bothSidesOrSurroundingsNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (profile === "ramp") {
    requirements.add("planMeasurementNeeded");
    requirements.add("contextViewNeeded");
    requirements.add("bothSidesOrSurroundingsNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (profile === "headroom") {
    requirements.add("contextViewNeeded");
    requirements.add("dimensionReferenceNeeded");
  }
  if (profile === "guard") {
    requirements.add("contextViewNeeded");
    requirements.add("obstructionContextNeeded");
    requirements.add("bothSidesOrSurroundingsNeeded");
    requirements.add("dimensionReferenceNeeded");
  }

  return Array.from(requirements);
}

function inferGeneralizedEvidencePriorities(rule: ComplianceRule): string[] {
  const profile = inferRuleTargetProfile(rule);
  const text = `${rule.title} ${rule.description} ${rule.tags.join(" ")}`.toLowerCase();

  if (profile === "door") {
    return [
      "Need the active door to be clearly visible and focused as one target at a time.",
      "Need a measurement-oriented floor-context view that makes both maneuvering sides around the door readable.",
      "Need a confirmation view for swing direction, hinge/latch side, and local intrusions only if the measurement-oriented evidence is still ambiguous.",
      "Need surrounding elements and possible obstructions around the door, not only the leaf itself.",
    ];
  }

  if (profile === "window") {
    return [
      "Need each checked window visible and focused as one target at a time.",
      "Need sill-height evidence with a readable vertical relationship to the adjacent floor or space.",
      "Need space or corridor context if the rule option for windows at corridor ends is being evaluated.",
      "Need property or classification context when space usage determines the configured sill-height requirement.",
    ];
  }

  if (profile === "stair") {
    return [
      "Need the stair run, landing, and immediate approach context together before judging accessibility.",
      "Need evidence that supports the active concern: geometry, handrails, landings, or headroom.",
      "Need an additional context view if the landing relationship or run continuity is still ambiguous.",
      "Need obstruction context if surrounding geometry hides the decisive stair relationships.",
    ];
  }

  if (profile === "ramp") {
    return [
      "Need the ramp run plus top and bottom landing context before deciding accessibility.",
      "Need evidence for slope, width, and landing relationships without losing the surrounding approach zones.",
      "Need obstruction context if slabs, walls, or nearby building elements hide the decisive ramp relationships.",
      "Need a focused local view only after the overall run and transition context are already readable.",
    ];
  }

  if (
    profile === "space" ||
    text.includes("free floor space") ||
    text.includes("clear floor space") ||
    text.includes("corridor width") ||
    text.includes("turning space")
  ) {
    return [
      "Need a readable floor-area relationship for the entire room, corridor segment, or maneuvering zone.",
      "Need surrounding obstructions such as walls, columns, furniture, sanitary fixtures, or doors to be visible together with the usable clear space.",
      "Need the narrowest pinch point or most obstructed turning zone to be readable enough for the decisive judgement.",
    ];
  }

  if (
    profile === "object" ||
    text.includes("around objects") ||
    text.includes("accessible area") ||
    text.includes("fixtures") ||
    text.includes("lavatory") ||
    text.includes("toilet")
  ) {
    return [
      "Need the checked object and its surrounding approach area as one combined evidence unit.",
      "Need front, side, or rear approach spaces to be readable enough to compare them reliably.",
      "Need surrounding fixtures or equipment that intrude into the required accessible area to stay visible in context.",
    ];
  }

  if (
    profile === "visibility" ||
    text.includes("component visibility") ||
    text.includes("visibility") ||
    text.includes("line of sight") ||
    text.includes("viewpoint")
  ) {
    return [
      "Need the target component and possible occluders visible together enough to judge actual inspectability.",
      "Need to distinguish true absence from occlusion-driven non-visibility.",
      "Need viewpoint/context evidence more than dimensional measurement evidence.",
    ];
  }

  if (profile === "headroom") {
    return [
      "Need the circulation path and the overhead obstruction visible together as a vertical relationship.",
      "Need the true clearance envelope rather than only a plan relationship.",
      "Need obstruction context if slabs, ducts, beams, or clutter hide the decisive vertical distance.",
    ];
  }

  if (profile === "guard") {
    return [
      "Need the elevated horizontal surface and its exposed perimeter visible as one evidence unit.",
      "Need a side or oblique context view that shows whether adjacent levels create a fall hazard.",
      "Need guardrails, railings, parapets, walls, or adjacent protective structures visible together with the slab edge.",
      "Need continuity evidence along the edge; a close-up is useful only after the exposed perimeter is already readable.",
    ];
  }

  return [
    "Use the recommended views first and keep the active target centered before making a pass/fail judgement.",
    "Prefer one focused target at a time when multiple similar entities are visible.",
    "Request a better view or targeted isolation if the current evidence does not clearly show the rule-relevant geometry.",
  ];
}

export function buildPromptFromRule(
  rule: ComplianceRule,
  options?: { reasoningMode?: ComplianceReasoningMode }
): string {
  const reasoningMode = normalizeComplianceReasoningMode(options?.reasoningMode);
  const binaryMode = reasoningMode === "binary";
  const evidenceRequirements = inferEvidenceRequirements(rule);
  const regulatoryGrounding = assessRuleRegulatoryGrounding(rule);
  const targetProfile = inferRuleTargetProfile(rule);
  const targetClasses = inferRuleTargetClasses(rule, targetProfile);
  if (import.meta.env.DEV && regulatoryGrounding.hasUsableLocalGrounding) {
    console.assert(
      !evidenceRequirements.includes("regulatoryClauseNeeded"),
      `[ruleLibrary] grounded predefined rule should not default to regulatoryClauseNeeded: ${rule.id}`
    );
  }
  return [
    `COMPLIANCE RULE: ${rule.title}`,
    ``,
    `DESCRIPTION: ${rule.description}`,
    ``,
    `SOURCE RULE:`,
    `- Solibri ID: ${rule.source.solibriId}`,
    `- Solibri title: ${rule.source.solibriTitle}`,
    `- Documentation: ${rule.source.documentationUrl}`,
    ...(rule.source.version ? [`- Version: ${rule.source.version}`] : []),
    ``,
    `CATEGORY: ${rule.category}`,
    `SEVERITY: ${rule.severity}`,
    `TARGET PROFILE: ${targetProfile}`,
    `TARGET IFC CLASSES: ${targetClasses.join(", ") || "not specified"}`,
    ``,
    `RULE INTENT:`,
    `- Assess only the active target(s) relevant to this rule.`,
    `- Use the rule-specific evidence cues and dimensional references below before suggesting any follow-up.`,
    `- Separate what evidence is needed from which navigation action might obtain it.`,
    `- Treat this predefined ruleLibrary entry as the authoritative local regulatory context unless it is explicitly insufficient.`,
    ``,
    `LOCAL REGULATORY CONTEXT:`,
    `- LOCAL_RULE_CONTEXT: ${
      regulatoryGrounding.hasUsableLocalGrounding
        ? "provided_from_rule_library"
        : "present_but_insufficient_for_complete_grounding"
    }`,
    `- WEB_FETCH_REQUIRED: ${
      regulatoryGrounding.hasUsableLocalGrounding
        ? "false unless local rule thresholds are insufficient"
        : "true if local rule thresholds, definitions, or exceptions remain insufficient"
    }`,
    `- REGULATORY_BASIS: ${
      regulatoryGrounding.hasUsableLocalGrounding
        ? "local interpreted ruleLibrary entry"
        : "ruleLibrary entry requires supplemental clause grounding"
    }`,
    ``,
    `WHAT TO LOOK FOR:`,
    ...formatList(rule.visualEvidence.lookFor),
    ``,
    `PASS INDICATORS:`,
    ...formatList(rule.visualEvidence.passIndicators),
    ``,
    `FAIL INDICATORS:`,
    ...formatList(rule.visualEvidence.failIndicators),
    ...(binaryMode
      ? []
      : [
          ``,
          `UNCERTAIN INDICATORS:`,
          ...formatList(rule.visualEvidence.uncertainIndicators),
        ]),
    ``,
    `EVALUATION CRITERIA:`,
    `PASS if: ${rule.evaluationCriteria.pass.join("; ")}`,
    `FAIL if: ${rule.evaluationCriteria.fail.join("; ")}`,
    ...(binaryMode ? [] : [`UNCERTAIN if: ${rule.evaluationCriteria.uncertain.join("; ")}`]),
    ``,
    `GENERALIZED EVIDENCE REQUIREMENTS:`,
    ...buildEvidenceRequirementList(evidenceRequirements),
    ``,
    `RULE-SPECIFIC EVIDENCE PRIORITIES:`,
    ...formatList(inferGeneralizedEvidencePriorities(rule)),
    ``,
    `LEGACY NAVIGATION HINTS (semantic cues only; runtime decides actions):`,
    `Recommended evidence orientations: ${rule.navigationHints.recommendedViews.join(", ")}`,
    `Suggested focus scale: ${rule.navigationHints.zoomLevel ?? "medium"}`,
    ...(rule.navigationHints.isolateCategories?.length
      ? [`Relevant categories for focus or de-cluttering: ${rule.navigationHints.isolateCategories.join(", ")}`]
      : []),
    ...(PLAN_CUT_FOLLOW_UPS_ENABLED && rule.navigationHints.usePlanCut
      ? [`Plan-based evidence may be required${rule.navigationHints.planCutHeight ? ` near ${rule.navigationHints.planCutHeight}` : ""}`]
      : [`Plan-based evidence: only if needed`]),
    ...formatList(rule.navigationHints.tips?.map((tip) => `Evidence cue: ${tip}`)),
    ...(rule.dimensionalRequirements?.length
      ? [
          ``,
          `DIMENSIONAL REFERENCES:`,
          ...rule.dimensionalRequirements.map((item) =>
            `- ${item.parameter}: ${item.typicalValue}${item.referenceStandard ? ` (${item.referenceStandard})` : ""}; visually measurable=${item.visuallyMeasurable ? "yes" : "no"}`
          ),
        ]
      : []),
    ...(rule.notes
      ? [
          ``,
          `NOTES:`,
          `- ${rule.notes}`,
        ]
      : []),
  ].join("\n");
}
