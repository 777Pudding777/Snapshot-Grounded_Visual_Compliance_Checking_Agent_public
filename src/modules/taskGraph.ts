import type { VlmDecision, VlmFollowUp } from "./vlmChecker";

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";
export type TaskGraphProfile =
  | "generic"
  | "door"
  | "stair"
  | "ramp"
  | "window"
  | "space"
  | "object"
  | "visibility"
  | "guard"
  | "egress";
export type ConcernKey =
  | "visibility"
  | "regulatory_context"
  | "opening_direction"
  | "hardware_side"
  | "clearance"
  | "dimensions"
  | "headroom"
  | "handrail"
  | "landing"
  | "slope"
  | "fire_rating"
  | "egress_width"
  | "accessibility"
  | "object_clearance"
  | "line_of_sight"
  | "fall_hazard"
  | "edge_guarding"
  | "sill_height"
  | "corridor_end_window";

export type ComplianceTask = {
  id: string;
  entityId?: string;
  entityClass?: string;
  title: string;
  description: string;
  status: TaskStatus;
  required: boolean;
  dependsOn?: string[];
  evidenceNotes: string[];
};

type EntityNode = {
  entityId: string;
  entityClass: string;
  clusterId: string;
  storeyId?: string;
  status: TaskStatus;
};

type EntityCluster = {
  id: string;
  label: string;
  storeyId?: string;
  entityIds: string[];
  status: TaskStatus;
};

export type TaskGraphState = {
  profile: TaskGraphProfile;
  intent: {
    source: "rule_library" | "custom_user_prompt" | "unknown";
    primaryClass?: string;
    repeatedEntityClass?: string;
    targetEntityClasses?: string[];
    storeyHint?: string;
    concerns: ConcernKey[];
  };
  tasks: ComplianceTask[];
  history: string[];
  entities: {
    trackedIds: string[];
    activeEntityId?: string;
    activeClusterId?: string;
    queue: string[];
    byId: Record<string, EntityNode>;
    clusters: EntityCluster[];
  };
};

export type CompactTaskGraphState = {
  profile: TaskGraphProfile;
  source: TaskGraphState["intent"]["source"];
  primaryClass?: string;
  targetEntityClasses?: string[];
  concerns: ConcernKey[];
  progress: {
    completedRequired: number;
    totalRequired: number;
    completedEntities: number;
    totalEntities: number;
    completionRatio: number;
  };
  activeTask?: {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    entityId?: string;
    entityClass?: string;
  };
  activeEntity?: {
    id: string;
    class?: string;
    storeyId?: string;
    clusterId?: string;
  };
  activeStoreyId?: string;
  clusterProgress?: {
    id: string;
    label: string;
    pendingCount: number;
    totalCount: number;
    status: TaskStatus;
  };
  nextEntityIds: string[];
};

type SyncEntityOptions = {
  storeyId?: string;
  entityClass?: string;
};

function hasKeywords(input: string, keywords: string[]): boolean {
  const normalized = input.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function canonicalIfcClassName(raw: string): string {
  const upper = String(raw ?? "").trim().toUpperCase();
  const known: Record<string, string> = {
    IFCDOOR: "IfcDoor",
    IFCWINDOW: "IfcWindow",
    IFCSTAIR: "IfcStair",
    IFCSTAIRFLIGHT: "IfcStairFlight",
    IFCRAMP: "IfcRamp",
    IFCRAMPFLIGHT: "IfcRampFlight",
    IFCSPACE: "IfcSpace",
    IFCSLAB: "IfcSlab",
    IFCROOF: "IfcRoof",
    IFCRAILING: "IfcRailing",
    IFCWALL: "IfcWall",
    IFCFURNISHINGELEMENT: "IfcFurnishingElement",
    IFCSANITARYTERMINAL: "IfcSanitaryTerminal",
    IFCFLOWTERMINAL: "IfcFlowTerminal",
    IFCELECTRICDISTRIBUTIONBOARD: "IfcElectricDistributionBoard",
  };
  return known[upper] ?? raw;
}

function uniqueClasses(classes: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const item of classes) {
    if (!item) continue;
    const canonical = canonicalIfcClassName(item);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function inferPromptSource(prompt: string): "rule_library" | "custom_user_prompt" | "unknown" {
  const text = String(prompt ?? "");
  if (/SOURCE:\s*RULE_LIBRARY/i.test(text)) return "rule_library";
  if (/SOURCE:\s*CUSTOM_USER_PROMPT/i.test(text)) return "custom_user_prompt";
  return "unknown";
}

function extractTaskSourceText(prompt: string): string {
  const text = String(prompt ?? "");
  const sourceBlock = text.match(/SOURCE_PROMPT_TEXT:\s*([\s\S]*)$/i)?.[1]?.trim();
  return sourceBlock || text;
}

function detectRuleProfileHint(text: string): { profile: TaskGraphProfile; primaryClass?: string } | undefined {
  const normalized = String(text ?? "").toLowerCase();
  if (
    /\bvlm-safe-guard-\d+\b/.test(normalized) ||
    /\bsol-236\b/.test(normalized) ||
    /\btarget profile:\s*guard\b/.test(normalized) ||
    /\bguarding against falling\b/.test(normalized) ||
    /\bhorizontal structures must be guarded against falling\b/.test(normalized)
  ) {
    return { profile: "guard", primaryClass: "IfcSlab" };
  }
  if (/\bvlm-safe-headroom-\d+\b/.test(normalized) || /\bsol-252\b/.test(normalized) || /\btarget profile:\s*headroom\b/.test(normalized)) {
    return { profile: "generic", primaryClass: undefined };
  }
  if (/\bvlm-acc-ramp-\d+\b/.test(normalized) || /\bsol-207\b/.test(normalized) || /\baccessible ramp rule\b/.test(normalized)) {
    return { profile: "ramp", primaryClass: "IfcRamp" };
  }
  if (/\bvlm-acc-stair-\d+\b/.test(normalized) || /\bsol-210\b/.test(normalized) || /\baccessible stair rule\b/.test(normalized)) {
    return { profile: "stair", primaryClass: "IfcStairFlight" };
  }
  if (/\bvlm-acc-door-\d+\b/.test(normalized) || /\bsol-208\b/.test(normalized) || /\baccessible door rule\b/.test(normalized)) {
    return { profile: "door", primaryClass: "IfcDoor" };
  }
  if (/\bvlm-acc-window-\d+\b/.test(normalized) || /\bsol-211\b/.test(normalized) || /\baccessible window rule\b/.test(normalized)) {
    return { profile: "window", primaryClass: "IfcWindow" };
  }
  if (/\bsol-247\b/.test(normalized) || /\blocal accessible circulation rule\b/.test(normalized)) {
    return { profile: "space", primaryClass: "IfcSpace" };
  }
  if (/\bvlm-acc-floor-\d+\b/.test(normalized) || /\bsol-209\b/.test(normalized)) {
    return { profile: "space", primaryClass: "IfcSpace" };
  }
  if (/\bvlm-maint-front-\d+\b/.test(normalized) || /\bsol-226\b/.test(normalized) || /\bfree area in front of components\b/.test(normalized)) {
    return { profile: "object", primaryClass: undefined };
  }
  return undefined;
}

function detectIfcClassHint(text: string): string | undefined {
  const matches = text.match(/\b(?:Ifc[A-Z][A-Za-z0-9_]+|IFC[A-Z0-9_]+)\b/g) ?? [];
  const preferred = matches
    .map(canonicalIfcClassName)
    .find((candidate) =>
      ["IfcDoor", "IfcWindow", "IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight", "IfcSpace", "IfcSlab", "IfcRoof"].includes(candidate)
    );
  return preferred;
}

function detectPrimaryClass(text: string): { profile: TaskGraphProfile; primaryClass?: string } {
  const normalized = ` ${text.toLowerCase()} `;
  const ruleProfile = detectRuleProfileHint(text);
  if (ruleProfile) return ruleProfile;

  const explicitIfcClass = detectIfcClassHint(text);
  if (explicitIfcClass) {
    if (explicitIfcClass === "IfcDoor") return { profile: "door", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcWindow") return { profile: "window", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcStair" || explicitIfcClass === "IfcStairFlight") return { profile: "stair", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcRamp" || explicitIfcClass === "IfcRampFlight") return { profile: "ramp", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcSpace") return { profile: "space", primaryClass: explicitIfcClass };
    if (explicitIfcClass === "IfcSlab" || explicitIfcClass === "IfcRoof") return { profile: "guard", primaryClass: explicitIfcClass };
    return { profile: "generic", primaryClass: explicitIfcClass };
  }
  if (hasKeywords(normalized, ["ifcdoor", " door ", "doors", "latch", "hinge", "swing"])) {
    return { profile: "door", primaryClass: "IfcDoor" };
  }
  if (hasKeywords(normalized, ["ifcwindow", " window ", "windows", "sill"])) {
    return { profile: "window", primaryClass: "IfcWindow" };
  }
  if (hasKeywords(normalized, ["ifcstair", " stair ", "stairs", "staircase", "riser", "tread"])) {
    return { profile: "stair", primaryClass: "IfcStairFlight" };
  }
  if (hasKeywords(normalized, ["ifcramp", " ramp ", "ramps", "ramp flight", "rampflight"])) {
    return { profile: "ramp", primaryClass: "IfcRamp" };
  }
  if (hasKeywords(normalized, ["visibility", "visible", "occluded", "line of sight", "viewpoint"])) {
    return { profile: "visibility", primaryClass: undefined };
  }
  if (hasKeywords(normalized, ["object", "objects", "fixture", "fixtures", "equipment", "toilet", "sink", "lavatory"])) {
    return { profile: "object", primaryClass: undefined };
  }
  if (hasKeywords(normalized, ["ifcspace", " room ", " space ", "spaces"])) {
    return { profile: "space", primaryClass: "IfcSpace" };
  }
  if (hasKeywords(normalized, ["ifcslab", "ifcroof", " slab ", "slabs", "roof", "roofs", "balcony", "balconies", "mezzanine", "platform"])) {
    return { profile: "guard", primaryClass: "IfcSlab" };
  }
  if (hasKeywords(normalized, ["egress", "exit", "corridor", "path of travel"])) {
    return { profile: "egress", primaryClass: undefined };
  }
  return { profile: "generic", primaryClass: undefined };
}

function detectTargetEntityClasses(text: string, profile: TaskGraphProfile, primaryClass?: string): string[] {
  const normalized = String(text ?? "").toLowerCase();
  const targetLine = String(text ?? "").match(/^TARGET IFC CLASSES:\s*(.+)$/im)?.[1];
  if (targetLine && !/not specified/i.test(targetLine)) {
    const parsed = targetLine
      .split(/[,|]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const classes = uniqueClasses(parsed);
    if (classes.length) return classes;
  }

  if (profile === "ramp") return uniqueClasses(["IfcRampFlight", "IfcRamp", primaryClass]);
  if (profile === "stair") return uniqueClasses(["IfcStairFlight", "IfcStair", primaryClass]);
  if (profile === "window") return uniqueClasses(["IfcWindow", primaryClass]);
  if (profile === "guard") return uniqueClasses([primaryClass, "IfcSlab", "IfcRoof"]);
  if (profile === "object" && (/\bsol-226\b/.test(normalized) || /\bfree area in front of components\b/.test(normalized))) {
    return uniqueClasses(["IfcSanitaryTerminal", "IfcFlowTerminal", "IfcFurnishingElement", "IfcElectricDistributionBoard", primaryClass]);
  }
  if (profile === "object" && hasKeywords(normalized, ["toilet", "water closet", "wc", "sink", "lavatory", "sanitary"])) {
    return uniqueClasses(["IfcSanitaryTerminal", "IfcFlowTerminal", primaryClass]);
  }
  if (primaryClass) return uniqueClasses([primaryClass]);
  return [];
}

function detectStoreyHint(text: string): string | undefined {
  const normalized = text.toLowerCase();
  const knownHints = ["ground floor", "first floor", "second floor", "third floor", "roof", "basement", "level 1", "level 2"];
  return knownHints.find((hint) => normalized.includes(hint));
}

function detectConcerns(text: string, profile: TaskGraphProfile): ConcernKey[] {
  const normalized = text.toLowerCase();
  const concerns = new Set<ConcernKey>();
  concerns.add("visibility");

  if (hasKeywords(normalized, ["icc", "ibc", "ada", "a117", "code", "section", "clause", "standard"])) {
    concerns.add("regulatory_context");
  }
  if (hasKeywords(normalized, ["opening direction", "swing", "push", "pull", "opening"])) {
    concerns.add("opening_direction");
  }
  if (hasKeywords(normalized, ["latch", "hinge", "hardware side"])) {
    concerns.add("hardware_side");
  }
  if (hasKeywords(normalized, ["clearance", "maneuver", "approach", "turning space", "obstruction"])) {
    concerns.add("clearance");
  }
  if (hasKeywords(normalized, ["free floor space", "clear floor space", "accessible area", "around objects", "approach space"])) {
    concerns.add("object_clearance");
  }
  if (hasKeywords(normalized, ["width", "height", "depth", "dimension", "measure", "measurement"])) {
    concerns.add("dimensions");
  }
  if (hasKeywords(normalized, ["headroom"])) {
    concerns.add("headroom");
  }
  if (hasKeywords(normalized, ["handrail", "railing"])) {
    concerns.add("handrail");
  }
  if (hasKeywords(normalized, ["guarding against falling", "fall protection", "fall hazard", "height difference", "drop", "lower level"])) {
    concerns.add("fall_hazard");
  }
  if (hasKeywords(normalized, ["guardrail", "guardrails", "railing", "railings", "parapet", "wall at edge", "edge protection", "open edge", "exposed edge"])) {
    concerns.add("edge_guarding");
  }
  if (hasKeywords(normalized, ["landing"])) {
    concerns.add("landing");
  }
  if (hasKeywords(normalized, ["slope", "gradient"])) {
    concerns.add("slope");
  }
  if (hasKeywords(normalized, ["fire rating", "fire-resistance", "smoke", "self-closing", "closing device"])) {
    concerns.add("fire_rating");
  }
  if (hasKeywords(normalized, ["egress width", "means of egress", "clear width", "travel width", "corridor width", "accessible circulation"])) {
    concerns.add("egress_width");
  }
  if (hasKeywords(normalized, ["visibility", "visible", "occluded", "occlusion", "line of sight", "viewpoint"])) {
    concerns.add("line_of_sight");
  }
  if (hasKeywords(normalized, ["sill", "sill height", "maximum sill height", "too high sill"])) {
    concerns.add("sill_height");
  }
  if (hasKeywords(normalized, ["end of corridor", "ends of corridors", "corridor end", "corridor ends"])) {
    concerns.add("corridor_end_window");
  }
  if (hasKeywords(normalized, ["accessible", "accessibility", "wheelchair", "ada", "a117"])) {
    concerns.add("accessibility");
  }

  if (profile === "door") {
    concerns.add("clearance");
    concerns.add("dimensions");
  } else if (profile === "window") {
    concerns.delete("opening_direction");
    concerns.delete("hardware_side");
    concerns.add("dimensions");
    concerns.add("sill_height");
    concerns.add("accessibility");
  } else if (profile === "stair") {
    concerns.delete("slope");
    concerns.add("dimensions");
    concerns.add("handrail");
    concerns.add("landing");
    concerns.add("headroom");
  } else if (profile === "ramp") {
    concerns.add("slope");
    concerns.add("dimensions");
    concerns.add("handrail");
    concerns.add("landing");
  } else if (profile === "space") {
    concerns.delete("opening_direction");
    concerns.delete("hardware_side");
    if (hasKeywords(normalized, ["local accessible circulation", "sol-247", "corridor", "circulation"])) {
      concerns.delete("handrail");
    }
    concerns.add("clearance");
    concerns.add("dimensions");
    concerns.add("accessibility");
    concerns.add("object_clearance");
    if (hasKeywords(normalized, ["corridor", "circulation", "clear width", "accessible route"])) {
      concerns.add("egress_width");
    }
  } else if (profile === "object") {
    concerns.delete("opening_direction");
    concerns.delete("hardware_side");
    concerns.add("clearance");
    concerns.add("object_clearance");
    concerns.add("accessibility");
  } else if (profile === "visibility") {
    concerns.add("visibility");
    concerns.add("line_of_sight");
  } else if (profile === "guard") {
    concerns.delete("opening_direction");
    concerns.delete("hardware_side");
    concerns.delete("landing");
    concerns.delete("slope");
    return Array.from(
      new Set<ConcernKey>([
        "visibility",
        ...(concerns.has("regulatory_context") ? ["regulatory_context" as ConcernKey] : []),
        "fall_hazard",
        "edge_guarding",
        "handrail",
        "dimensions",
        ...(concerns.has("line_of_sight") ? ["line_of_sight" as ConcernKey] : []),
      ])
    );
  }

  return Array.from(concerns);
}

function extractPromptIntent(prompt: string): TaskGraphState["intent"] & { profile: TaskGraphProfile } {
  const source = inferPromptSource(prompt);
  const sourceText = extractTaskSourceText(prompt);
  const { profile, primaryClass } = detectPrimaryClass(sourceText);
  const targetEntityClasses = detectTargetEntityClasses(sourceText, profile, primaryClass);
  return {
    source,
    profile,
    primaryClass,
    repeatedEntityClass: primaryClass,
    targetEntityClasses,
    storeyHint: detectStoreyHint(sourceText),
    concerns: detectConcerns(sourceText, profile),
  };
}

function mergeUniqueConcerns(current: ConcernKey[], incoming: ConcernKey[]) {
  return Array.from(new Set([...current, ...incoming]));
}

function createTask(
  id: string,
  title: string,
  description: string,
  required = true,
  dependsOn?: string[],
  entity?: { entityId?: string; entityClass?: string }
): ComplianceTask {
  return {
    id,
    entityId: entity?.entityId,
    entityClass: entity?.entityClass,
    title,
    description,
    status: "pending",
    required,
    dependsOn,
    evidenceNotes: [],
  };
}

function canStartTask(task: ComplianceTask, state: TaskGraphState): boolean {
  if (!task.dependsOn?.length) return true;
  const completed = new Set(state.tasks.filter((x) => x.status === "done").map((x) => x.id));
  return task.dependsOn.every((dep) => completed.has(dep));
}

function setTaskStatus(state: TaskGraphState, taskId: string, status: TaskStatus, note?: string) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = status;
  if (note) task.evidenceNotes.push(note);
}

function setScopedEntityTaskStatus(
  state: TaskGraphState,
  taskKey: string,
  entityId: string | undefined,
  status: TaskStatus,
  note?: string
) {
  if (!entityId) return;
  const task = state.tasks.find((t) => t.id === `${taskKey}:${entityId}`);
  if (!task) return;
  task.status = status;
  if (note) task.evidenceNotes.push(note);
}

function getTaskKey(taskId: string): string {
  const suffixIndex = taskId.indexOf(":");
  return suffixIndex >= 0 ? taskId.slice(0, suffixIndex) : taskId;
}

function getDecisionEvidenceText(decision: VlmDecision): string {
  return [
    decision.rationale,
    ...(decision.missingEvidence ?? []),
    ...(decision.visibility?.missingEvidence ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasUnresolvedCueForTask(taskKey: string, decision: VlmDecision): boolean {
  const text = getDecisionEvidenceText(decision);
  const status = decision.evidenceRequirementsStatus ?? {};

  switch (taskKey) {
    case "entity.opening_direction":
      return (
        status.contextViewReady === false ||
        (/\b(opening direction|swing|push|pull|operation type)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not evident|ambiguous|need)\b/.test(text))
      );
    case "entity.hardware_side":
      return (
        status.contextViewReady === false ||
        (/\b(latch|hinge|hardware side|handle)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not evident|ambiguous|need)\b/.test(text))
      );
    case "entity.clearance":
    case "entity.object_clearance":
      return (
        status.planMeasurementReady === false ||
        status.obstructionContextNeeded === true ||
        status.occlusionProblem === true ||
        status.bothSidesOrSurroundingsNeeded === true ||
        (/\b(clearance|clear floor|free floor|maneuver|obstruct|blocked|surrounding)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not visible|ambiguous|need|insufficient evidence)\b/.test(text))
      );
    case "entity.dimensions":
      return (
        status.planMeasurementReady === false ||
        status.dimensionReferenceNeeded === true ||
        (/\b(width|height|depth|dimension|measure|measurement|reference)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not visible|ambiguous|need)\b/.test(text))
      );
    case "entity.sill_height":
      return (
        status.planMeasurementReady === false ||
        status.dimensionReferenceNeeded === true ||
        (/\b(sill|sill height|window height|too high)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not visible|ambiguous|need)\b/.test(text))
      );
    case "entity.corridor_end_window":
      return (
        status.planMeasurementReady === false ||
        status.contextViewReady === false ||
        (/\b(corridor end|end of corridor|corridor termination|window at the end)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not visible|ambiguous|need)\b/.test(text))
      );
    case "entity.fall_hazard":
      return (
        status.contextViewReady === false ||
        status.dimensionReferenceNeeded === true ||
        (/\b(fall hazard|height difference|drop|lower level|elevated|edge)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not visible|ambiguous|need)\b/.test(text))
      );
    case "entity.edge_guarding":
      return (
        status.obstructionContextNeeded === true ||
        status.occlusionProblem === true ||
        status.bothSidesOrSurroundingsNeeded === true ||
        (/\b(guard|guardrail|railing|parapet|wall|open edge|exposed edge|edge protection)\b/.test(text) &&
          /\b(unclear|unknown|cannot|can't|missing|not visible|ambiguous|need|occluded)\b/.test(text))
      );
    case "entity.handrail":
      return (
        status.contextViewReady === false ||
        status.dimensionReferenceNeeded === true ||
        (/\b(handrail|railing|guardrail|guard|parapet)\b/.test(text) &&
          /\b(height|too low|insufficient|unclear|unknown|cannot|can't|missing|not visible|ambiguous|need|measure|measurement)\b/.test(text))
      );
    default:
      return false;
  }
}

function hasResolvedCueForTask(taskKey: string, decision: VlmDecision): boolean {
  const text = getDecisionEvidenceText(decision);
  const status = decision.evidenceRequirementsStatus ?? {};

  switch (taskKey) {
    case "entity.opening_direction":
      return (
        status.contextViewReady === true ||
        /\b(opening direction|swing|swing arc|push side|pull side|opens?|operation type|single swing|left|right)\b/.test(text)
      );
    case "entity.hardware_side":
      return /\b(latch|hinge|hardware side|handle|handing)\b/.test(text);
    case "entity.clearance":
      return (
        status.planMeasurementReady === true ||
        /\b(clearance|clear floor|free floor|maneuver|wheelchair|swing path|unobstructed|obstruction|blocked|required zone)\b/.test(text)
      );
    case "entity.object_clearance":
      return (
        status.obstructionContextNeeded === false ||
        /\b(obstruction|unobstructed|blocked|surrounding|nearby walls?|columns?|furniture|clear floor|accessible area)\b/.test(text)
      );
    case "entity.dimensions":
      return (
        status.dimensionReferenceNeeded === false ||
        /\b(width|height|depth|dimension|measure|measurement|32|815|48|60|18|door width|clear width|sill)\b/.test(text)
      );
    case "entity.sill_height":
      return /\b(sill|sill height|window height|maximum sill|too high sill|above|below|within (the )?(allowed|required) range)\b/.test(text);
    case "entity.corridor_end_window":
      return /\b(corridor end|end of corridor|corridor termination|window at the end|not at the end|located at the corridor end)\b/.test(text);
    case "entity.accessibility":
      return /\b(accessible|accessibility|wheelchair|ada|a117|compliant|non[- ]?compliant|maneuvering clearance)\b/.test(text);
    case "entity.line_of_sight":
      return /\b(line of sight|visible|visibility|unoccluded|occlusion)\b/.test(text);
    case "entity.headroom":
      return /\b(headroom|overhead|vertical clearance|beam|duct)\b/.test(text);
    case "entity.handrail":
      return (
        /\b(handrail|railing|guardrail|guard|parapet)\b/.test(text) &&
        /\b(height|tall|low|adequate|sufficient|appropriate|compliant|42|1065|1\.065|waist|above (the )?(slab|floor|walking surface|nosing))\b/.test(text)
      );
    case "entity.fall_hazard":
      return /\b(fall hazard|height difference|drop|lower level|elevated|balcony|mezzanine|platform|roof|slab edge)\b/.test(text);
    case "entity.edge_guarding":
      return /\b(guarding|guardrail|railing|parapet|wall|edge protection|open edge|exposed edge|protected edge|unprotected edge)\b/.test(text);
    case "entity.landing":
      return /\b(landing|top landing|bottom landing)\b/.test(text);
    case "entity.slope":
      return /\b(slope|gradient|rise|run)\b/.test(text);
    case "entity.egress_width":
      return /\b(egress width|clear width|corridor width|travel width)\b/.test(text);
    case "entity.fire_rating":
      return /\b(fire rating|fire-resistance|smoke|self-closing|closer)\b/.test(text);
    default:
      return false;
  }
}

function resolveDoorOrientationTasksFromEvidence(state: TaskGraphState, entityId: string | undefined, note: string) {
  if (state.profile !== "door" || !entityId) return;
  setScopedEntityTaskStatus(state, "entity.opening_direction", entityId, "done", note);
  setScopedEntityTaskStatus(state, "entity.hardware_side", entityId, "done", note);
}

function hasExplicitDoorOrientationCue(decision: VlmDecision): boolean {
  const text = getDecisionEvidenceText(decision);
  return /\b(hinge|latch|swing arc|door swing|push side|pull side|opening orientation|modeled swing)\b/.test(text);
}

function decisionResolvesActiveTask(taskKey: string, decision: VlmDecision): boolean {
  if (decision.verdict !== "PASS" && decision.verdict !== "FAIL") return false;
  if (decision.confidence < 0.7) return false;
  return !hasUnresolvedCueForTask(taskKey, decision);
}

function decisionResolvesAnyCoveredTask(taskKey: string, decision: VlmDecision): boolean {
  if (decision.verdict !== "PASS" && decision.verdict !== "FAIL") return false;
  if (decision.confidence < 0.7) return false;
  return hasResolvedCueForTask(taskKey, decision) && !hasUnresolvedCueForTask(taskKey, decision);
}

function hasOpenEntityTasksBeforeFinal(state: TaskGraphState, entityId: string | undefined): boolean {
  if (!entityId) return false;
  return state.tasks.some(
    (task) =>
      task.entityId === entityId &&
      task.required &&
      getTaskKey(task.id) !== "entity.final_decision" &&
      task.status !== "done" &&
      task.status !== "blocked"
  );
}

function markNextRunnableEntityTaskInProgress(
  state: TaskGraphState,
  entityId: string | undefined,
  note?: string
) {
  if (!entityId) return;
  const entityTasks = state.tasks.filter((task) => task.entityId === entityId);
  const active = entityTasks.find((task) => task.status === "in_progress");
  if (active) {
    if (note) active.evidenceNotes.push(note);
    return;
  }

  const next = entityTasks.find((task) => task.status === "pending" && canStartTask(task, state));
  if (!next) return;
  next.status = "in_progress";
  if (note) next.evidenceNotes.push(note);
}

function resolveCoveredEntityTasksFromDecision(
  state: TaskGraphState,
  entityId: string | undefined,
  decision: VlmDecision,
  activeTaskKey?: string
) {
  if (!entityId) return;

  for (const task of state.tasks) {
    if (task.entityId !== entityId) continue;
    if (task.status === "done" || task.status === "blocked") continue;

    const taskKey = getTaskKey(task.id);
    if (taskKey === "entity.final_decision") continue;
    if (taskKey === "entity.target_identification") continue;

    const resolved =
      taskKey === activeTaskKey
        ? decisionResolvesActiveTask(taskKey, decision)
        : decisionResolvesAnyCoveredTask(taskKey, decision);

    if (!resolved) continue;
    task.status = "done";
    task.evidenceNotes.push(`${decision.verdict} @ ${decision.confidence.toFixed(2)} resolved covered subtask.`);
  }
}

function concernTaskSpec(concern: ConcernKey, profile: TaskGraphProfile): { key: string; title: string; description: string } | null {
  switch (concern) {
    case "opening_direction":
      if (profile !== "door") return null;
      return {
        key: "entity.opening_direction",
        title: "Resolve opening direction",
        description:
          "Resolve modeled swing or push/pull orientation for clearance zoning; this is not a pass/fail target unless the rule explicitly requires a direction.",
      };
    case "hardware_side":
      if (profile !== "door") return null;
      return {
        key: "entity.hardware_side",
        title: "Resolve hinge or latch side",
        description:
          "Determine hinge/latch orientation for clearance zones, not hardware-type compliance unless configured by the rule.",
      };
    case "clearance":
      return { key: "entity.clearance", title: "Measure clearances", description: "Evaluate required clearances or free-space conditions for this entity." };
    case "dimensions":
      return { key: "entity.dimensions", title: "Verify dimensions", description: "Measure or verify rule-relevant dimensions for this entity." };
    case "sill_height":
      return { key: "entity.sill_height", title: "Check sill height", description: "Verify whether the window sill height appears within the configured accessible range." };
    case "corridor_end_window":
      return { key: "entity.corridor_end_window", title: "Check corridor-end condition", description: "Verify whether the window is located at the end of a corridor when that rule option applies." };
    case "headroom":
      return { key: "entity.headroom", title: "Check headroom", description: "Verify headroom or overhead clearance for this entity." };
    case "handrail":
      if (profile === "guard") {
        return { key: "entity.handrail", title: "Check guard height", description: "Verify that guardrail, railing, wall, or parapet height appears sufficient where guarding is required." };
      }
      if (profile === "stair") {
        return { key: "entity.handrail", title: "Check stair handrails", description: "Verify stair handrail or railing presence, height, continuity, and extensions for this stair." };
      }
      if (profile === "ramp") {
        return { key: "entity.handrail", title: "Check ramp handrails", description: "Verify ramp handrail presence, continuity, side coverage, and extensions for this ramp." };
      }
      return { key: "entity.handrail", title: "Check handrails", description: "Verify handrail or railing presence and continuity for this entity." };
    case "landing":
      if (profile === "stair") {
        return { key: "entity.landing", title: "Check stair landings", description: "Verify stair landing presence, size, and relationship to the stair flight." };
      }
      if (profile === "ramp") {
        return { key: "entity.landing", title: "Check ramp landings", description: "Verify top, bottom, and intermediate ramp landings and transition clearances." };
      }
      return { key: "entity.landing", title: "Check landings", description: "Verify landings or landing-related geometry around this entity." };
    case "slope":
      return { key: "entity.slope", title: "Check slope", description: "Verify slope or gradient requirements for this entity." };
    case "fire_rating":
      return { key: "entity.fire_rating", title: "Check fire or smoke requirements", description: "Verify fire-rating, smoke-control, or self-closing requirements for this entity." };
    case "egress_width":
      if (profile === "space") {
        return {
          key: "entity.egress_width",
          title: "Check corridor clear width",
          description: "Verify the usable clear width through this corridor or circulation space, including pinch points and obstructions.",
        };
      }
      return { key: "entity.egress_width", title: "Check egress width", description: "Verify clear width or required means-of-egress width for this entity." };
    case "accessibility":
      return { key: "entity.accessibility", title: "Check accessibility criteria", description: "Verify accessibility-specific requirements that apply to this entity." };
    case "object_clearance":
      return { key: "entity.object_clearance", title: "Check accessible area", description: "Verify clear floor or accessible area around the active object or space." };
    case "line_of_sight":
      return { key: "entity.line_of_sight", title: "Check visibility path", description: "Verify line-of-sight and occlusion conditions for the active target." };
    case "fall_hazard":
      return { key: "entity.fall_hazard", title: "Confirm fall hazard", description: "Verify that this horizontal surface has an exposed edge or height difference that makes fall protection applicable." };
    case "edge_guarding":
      return { key: "entity.edge_guarding", title: "Check edge guarding", description: "Verify that exposed edges are protected by continuous railings, guardrails, parapets, walls, or adjacent structures." };
    default:
      return null;
  }
}

function buildProfileTasks(intent: TaskGraphState["intent"] & { profile: TaskGraphProfile }): ComplianceTask[] {
  const profileLabel =
    intent.profile === "door" ? "door" :
    intent.profile === "stair" ? "stair" :
    intent.profile === "ramp" ? "ramp" :
    intent.profile === "window" ? "window" :
    intent.profile === "space" ? "space" :
    intent.profile === "object" ? "object" :
    intent.profile === "visibility" ? "visibility target" :
    intent.profile === "guard" ? "elevated horizontal surface" :
    intent.profile === "egress" ? "egress target" :
    "target";

  const tasks = [
    createTask("target_identification", `Identify ${profileLabel} candidates`, `Find ${profileLabel} instances that should be checked.`),
    createTask("scope_preparation", "Prepare scope", "Prepare storey, category, or spatial scope so the active entity can be checked efficiently.", true, ["target_identification"]),
    createTask("visibility_validation", "Validate visible target batch", "Confirm the active cluster or target set is visible enough for targeted review.", true, ["scope_preparation"]),
    createTask("measurement_readiness", "Prepare active target context", "Switch to the best view/context so per-entity verification becomes reliable.", true, ["visibility_validation"]),
  ];

  if (intent.concerns.includes("regulatory_context")) {
    tasks.push(
      createTask("regulatory_context", "Resolve regulatory context", "Resolve clause text, threshold values, or exception context needed for this rule.", true, ["target_identification"])
    );
  }

  tasks.push(
    createTask("final_decision", "Issue aggregate verdict", "Return a run-level verdict after active entity subtasks are resolved.", true, ["measurement_readiness"])
  );

  return tasks;
}

function ensureCluster(state: TaskGraphState, storeyId?: string) {
  const normalized = storeyId?.trim() || "unscoped";
  const existing = state.entities.clusters.find((cluster) => cluster.id === normalized);
  if (existing) return existing;

  const cluster: EntityCluster = {
    id: normalized,
    label: normalized === "unscoped" ? "Unscoped entities" : `Storey ${normalized}`,
    storeyId: normalized === "unscoped" ? undefined : normalized,
    entityIds: [],
    status: "pending",
  };
  state.entities.clusters.push(cluster);
  state.entities.clusters.sort((a, b) => a.label.localeCompare(b.label));
  return cluster;
}

function updateEntityQueue(state: TaskGraphState) {
  const pending = state.entities.trackedIds.filter((entityId) => {
    const finalTask = state.tasks.find((task) => task.id === `entity.final_decision:${entityId}`);
    return finalTask?.status !== "done";
  });

  pending.sort((a, b) => {
    const ea = state.entities.byId[a];
    const eb = state.entities.byId[b];
    const clusterCmp = (ea?.clusterId ?? "").localeCompare(eb?.clusterId ?? "");
    if (clusterCmp !== 0) return clusterCmp;
    return a.localeCompare(b);
  });

  state.entities.queue = pending;
  state.entities.activeEntityId = pending[0];
  state.entities.activeClusterId = pending[0] ? state.entities.byId[pending[0]]?.clusterId : undefined;

  for (const cluster of state.entities.clusters) {
    const clusterPending = cluster.entityIds.filter((entityId) => pending.includes(entityId));
    cluster.status = clusterPending.length === 0 ? "done" : clusterPending[0] === state.entities.activeEntityId ? "in_progress" : "pending";
  }
}

function ensureEntityTask(
  state: TaskGraphState,
  entityId: string,
  taskKey: string,
  title: string,
  description: string,
  dependsOn?: string[],
  entityClass = "IfcElement"
) {
  const id = `${taskKey}:${entityId}`;
  if (state.tasks.some((t) => t.id === id)) return;
  state.tasks.push(createTask(id, title, description, true, dependsOn, { entityId, entityClass }));
}

function getActiveEntityId(state: TaskGraphState): string | undefined {
  updateEntityQueue(state);
  return state.entities.activeEntityId;
}

function getActiveEntityTasks(state: TaskGraphState) {
  const activeEntityId = getActiveEntityId(state);
  if (!activeEntityId) return [];
  return state.tasks.filter((task) => task.entityId === activeEntityId);
}

function getCurrentTask(state: TaskGraphState): ComplianceTask | undefined {
  const activeEntityTasks = getActiveEntityTasks(state);
  return (
    activeEntityTasks.find((task) => task.status === "in_progress") ??
    activeEntityTasks.find((task) => task.status === "pending") ??
    state.tasks.find((task) => !task.entityId && task.status === "in_progress") ??
    state.tasks.find((task) => !task.entityId && task.status === "pending")
  );
}

function getRequiredProgress(state: TaskGraphState) {
  const required = state.tasks.filter((task) => task.required);
  const completedRequired = required.filter((task) => task.status === "done").length;
  const totalEntities = state.entities.trackedIds.length;
  const completedEntities = state.entities.trackedIds.filter((entityId) => {
    const finalTask = state.tasks.find((task) => task.id === `entity.final_decision:${entityId}`);
    return finalTask?.status === "done";
  }).length;
  return {
    completedRequired,
    totalRequired: required.length,
    completedEntities,
    totalEntities,
    completionRatio: required.length ? completedRequired / required.length : 0,
  };
}

function buildCompactTaskGraphState(state: TaskGraphState): CompactTaskGraphState {
  updateEntityQueue(state);
  const activeEntityId = state.entities.activeEntityId;
  const activeEntity = activeEntityId ? state.entities.byId[activeEntityId] : undefined;
  const activeCluster = state.entities.clusters.find((cluster) => cluster.id === state.entities.activeClusterId);
  const currentTask = getCurrentTask(state);
  const progress = getRequiredProgress(state);

  return {
    profile: state.profile,
    source: state.intent.source,
    primaryClass: state.intent.primaryClass,
    targetEntityClasses: state.intent.targetEntityClasses ? [...state.intent.targetEntityClasses] : undefined,
    concerns: [...state.intent.concerns],
    progress,
    activeTask: currentTask
      ? {
          id: currentTask.id,
          title: currentTask.title,
          description: currentTask.description,
          status: currentTask.status,
          entityId: currentTask.entityId,
          entityClass: currentTask.entityClass,
        }
      : undefined,
    activeEntity: activeEntity
      ? {
          id: activeEntity.entityId,
          class: activeEntity.entityClass,
          storeyId: activeEntity.storeyId,
          clusterId: activeEntity.clusterId,
        }
      : undefined,
    activeStoreyId: activeEntity?.storeyId ?? activeCluster?.storeyId,
    clusterProgress: activeCluster
      ? {
          id: activeCluster.id,
          label: activeCluster.label,
          pendingCount: activeCluster.entityIds.filter((entityId) => state.entities.queue.includes(entityId)).length,
          totalCount: activeCluster.entityIds.length,
          status: activeCluster.status,
        }
      : undefined,
    nextEntityIds: state.entities.queue.slice(0, 3),
  };
}

function rebuildEntityTasksForState(state: TaskGraphState, entityId: string, entityClass: string) {
  ensureEntityTask(state, entityId, "entity.target_identification", `Identify this ${entityClass}`, "Confirm this specific entity instance in context.", undefined, entityClass);
  let previousTaskId = `entity.target_identification:${entityId}`;
  for (const concern of state.intent.concerns) {
    const spec = concernTaskSpec(concern, state.profile);
    if (!spec) continue;
    ensureEntityTask(state, entityId, spec.key, spec.title, spec.description, [previousTaskId], entityClass);
    previousTaskId = `${spec.key}:${entityId}`;
  }
  ensureEntityTask(state, entityId, "entity.final_decision", "Per-entity verdict", "Store pass/fail/uncertain result for this entity.", [previousTaskId], entityClass);
}

export function createTaskGraph(rulePrompt: string): TaskGraphState {
  const intent = extractPromptIntent(rulePrompt);
  const state: TaskGraphState = {
    profile: intent.profile,
    intent: {
      source: intent.source,
      primaryClass: intent.primaryClass,
      repeatedEntityClass: intent.repeatedEntityClass,
      targetEntityClasses: intent.targetEntityClasses,
      storeyHint: intent.storeyHint,
      concerns: [...intent.concerns],
    },
    tasks: buildProfileTasks(intent),
    history: [],
    entities: { trackedIds: [], queue: [], byId: {}, clusters: [] },
  };

  markFirstRunnableInProgress(state);
  return state;
}

function markFirstRunnableInProgress(state: TaskGraphState) {
  const active = state.tasks.some((task) => task.status === "in_progress" && !task.entityId);
  if (!active) {
    const next = state.tasks.find((task) => !task.entityId && task.status === "pending" && canStartTask(task, state));
    if (next) next.status = "in_progress";
  }

  const activeEntityId = getActiveEntityId(state);
  if (!activeEntityId) return;
  const entityTasks = state.tasks.filter((task) => task.entityId === activeEntityId);
  if (entityTasks.some((task) => task.status === "in_progress")) return;
  const nextEntityTask = entityTasks.find((task) => task.status === "pending" && canStartTask(task, state));
  if (nextEntityTask) nextEntityTask.status = "in_progress";
}

export function syncTaskGraphEntities(state: TaskGraphState, entityIds: string[], options?: SyncEntityOptions) {
  const fallbackEntityClass =
    options?.entityClass ??
    state.intent.repeatedEntityClass ??
    state.intent.primaryClass ??
    state.intent.targetEntityClasses?.[0] ??
    "IfcElement";

  const normalized = Array.from(new Set((entityIds ?? []).map((x) => String(x).trim()).filter(Boolean))).sort();
  if (!normalized.length) return state;

  const cluster = ensureCluster(state, options?.storeyId);
  for (const entityId of normalized) {
    if (state.entities.trackedIds.includes(entityId)) {
      const existing = state.entities.byId[entityId];
      if (existing && options?.storeyId && !existing.storeyId) existing.storeyId = options.storeyId;
      continue;
    }

    const entityClass = fallbackEntityClass;
    state.entities.trackedIds.push(entityId);
    state.entities.byId[entityId] = {
      entityId,
      entityClass,
      clusterId: cluster.id,
      storeyId: options?.storeyId,
      status: "pending",
    };
    if (!cluster.entityIds.includes(entityId)) cluster.entityIds.push(entityId);

    rebuildEntityTasksForState(state, entityId, entityClass);
  }

  updateEntityQueue(state);
  state.history.push(`Entity sync: ${normalized.length} candidate(s) -> cluster=${cluster.label}.`);
  markFirstRunnableInProgress(state);
  return state;
}

export function getTaskGraphFocus(state: TaskGraphState): {
  activeEntityId?: string;
  activeClusterId?: string;
  activeStoreyId?: string;
  suggestedHighlightIds: string[];
  queue: string[];
  activeClusterQueue: string[];
} {
  updateEntityQueue(state);
  const queue = state.entities.queue.slice(0, 5);
  const activeClusterId = state.entities.activeClusterId;
  const activeClusterQueue = activeClusterId
    ? state.entities.queue.filter((entityId) => state.entities.byId[entityId]?.clusterId === activeClusterId).slice(0, 5)
    : [];
  return {
    activeEntityId: state.entities.activeEntityId,
    activeClusterId,
    activeStoreyId: state.entities.activeEntityId
      ? state.entities.byId[state.entities.activeEntityId]?.storeyId
      : undefined,
    suggestedHighlightIds: state.entities.activeEntityId ? [state.entities.activeEntityId] : queue.slice(0, 3),
    queue,
    activeClusterQueue,
  };
}

export function updateTaskGraphFromDecision(state: TaskGraphState, decision: VlmDecision): TaskGraphState {
  const activeEntityId = getActiveEntityId(state);
  const activeTaskBeforeDecision = getCurrentTask(state);
  const activeTaskKey = activeTaskBeforeDecision ? getTaskKey(activeTaskBeforeDecision.id) : undefined;
  const activeTaskIsIntermediateEntityTask =
    Boolean(
      activeTaskBeforeDecision?.entityId &&
        activeTaskBeforeDecision.entityId === activeEntityId &&
        activeTaskKey &&
        activeTaskKey !== "entity.final_decision"
    );

  if (decision.visibility.isRuleTargetVisible) {
    setTaskStatus(state, "target_identification", "done", "Target appears visible in evidence.");
    setTaskStatus(state, "visibility_validation", "done", `Occlusion=${decision.visibility.occlusionAssessment}.`);
    setScopedEntityTaskStatus(state, "entity.target_identification", activeEntityId, "done", "Active entity is visible.");
  } else {
    setTaskStatus(state, "visibility_validation", "blocked", "Rule target not visible yet.");
  }

  if (decision.followUp?.request === "WEB_FETCH") {
    setTaskStatus(state, "regulatory_context", "in_progress", "Requested regulatory grounding.");
  }

  if (
    decision.followUp?.request === "SET_PLAN_CUT" ||
    decision.followUp?.request === "SET_STOREY_PLAN_CUT" ||
    decision.followUp?.request === "ISOLATE_STOREY" ||
    decision.followUp?.request === "TOP_VIEW" ||
    decision.followUp?.request === "ORBIT" ||
    decision.followUp?.request === "ORBIT_90" ||
    decision.followUp?.request === "ORBIT_180" ||
    decision.followUp?.request === "HIDE_CATEGORY"
  ) {
    setTaskStatus(state, "measurement_readiness", "in_progress", `Requested ${decision.followUp.request} to improve evidence.`);
    markNextRunnableEntityTaskInProgress(state, activeEntityId, `Requested ${decision.followUp.request} for active entity.`);
  }

  if (activeTaskBeforeDecision && activeTaskIsIntermediateEntityTask) {
    resolveCoveredEntityTasksFromDecision(state, activeEntityId, decision, activeTaskKey);
  }

  if (
    state.profile === "door" &&
    hasExplicitDoorOrientationCue(decision)
  ) {
    resolveDoorOrientationTasksFromEvidence(
      state,
      activeEntityId,
      "Modeled hinge/latch/swing orientation was resolved and will be used only to define clearance zones."
    );
  }

  if ((decision.verdict === "PASS" || decision.verdict === "FAIL") && decision.confidence >= 0.7) {
    const shouldFinalizeEntity =
      !activeEntityId ||
      activeTaskKey === "entity.final_decision" ||
      !hasOpenEntityTasksBeforeFinal(state, activeEntityId);

    if (shouldFinalizeEntity) {
      setTaskStatus(state, "final_decision", "done", `${decision.verdict} @ ${decision.confidence.toFixed(2)} confidence.`);
      setScopedEntityTaskStatus(state, "entity.final_decision", activeEntityId, "done", `${decision.verdict} @ ${decision.confidence.toFixed(2)}.`);
      if (activeEntityId && state.entities.byId[activeEntityId]) state.entities.byId[activeEntityId].status = "done";
    }
  }

  updateEntityQueue(state);
  state.history.push(`Decision ${decision.verdict} (${decision.confidence.toFixed(2)})`);
  markFirstRunnableInProgress(state);
  return state;
}

export function updateTaskGraphFromFollowUpResult(
  state: TaskGraphState,
  followUp: VlmFollowUp | undefined,
  didSomething: boolean,
  reason: string
): TaskGraphState {
  if (!followUp) return state;
  const activeEntityId = getActiveEntityId(state);

  if (!didSomething) {
    state.history.push(`Follow-up ${followUp.request} failed: ${reason}`);
    return state;
  }

  switch (followUp.request) {
    case "PICK_CENTER":
    case "PICK_OBJECT":
    case "HIGHLIGHT_IDS":
      setTaskStatus(state, "target_identification", "done", `Selection succeeded (${reason}).`);
      setScopedEntityTaskStatus(state, "entity.target_identification", activeEntityId, "done", `Entity selected (${reason}).`);
      markNextRunnableEntityTaskInProgress(state, activeEntityId, "Active entity ready for targeted review.");
      break;
    case "SET_PLAN_CUT":
    case "SET_STOREY_PLAN_CUT":
    case "TOP_VIEW":
    case "ORBIT":
    case "ORBIT_90":
    case "ORBIT_180":
    case "ISOLATE_STOREY":
    case "HIDE_CATEGORY":
      setTaskStatus(state, "scope_preparation", "done", `Prepared with ${followUp.request}.`);
      setTaskStatus(state, "measurement_readiness", "done", `Prepared with ${followUp.request}.`);
      markNextRunnableEntityTaskInProgress(state, activeEntityId, `Prepared with ${followUp.request}.`);
      break;
    case "GET_PROPERTIES":
      if (state.profile === "door") {
        setScopedEntityTaskStatus(state, "entity.opening_direction", activeEntityId, "in_progress", "Properties fetched for entity-specific inference.");
        setScopedEntityTaskStatus(state, "entity.hardware_side", activeEntityId, "in_progress", "Properties available for hardware-side inference.");
      }
      break;
    case "WEB_FETCH":
      setTaskStatus(state, "regulatory_context", "done", "Regulatory context fetched.");
      break;
    default:
      break;
  }

  updateEntityQueue(state);
  state.history.push(`Follow-up ${followUp.request}: ${reason}`);
  markFirstRunnableInProgress(state);
  return state;
}

export function markActiveEntityInconclusive(state: TaskGraphState, note: string): TaskGraphState {
  const activeEntityId = getActiveEntityId(state);
  if (!activeEntityId) return state;

  for (const task of state.tasks) {
    if (task.entityId !== activeEntityId) continue;
    if (task.id === `entity.final_decision:${activeEntityId}`) {
      task.status = "done";
      task.evidenceNotes.push(note);
      continue;
    }
    if (task.status !== "done") {
      task.status = "blocked";
      task.evidenceNotes.push(note);
    }
  }

  if (state.entities.byId[activeEntityId]) {
    state.entities.byId[activeEntityId].status = "blocked";
  }
  state.history.push(`Entity ${activeEntityId} marked inconclusive: ${note}`);
  updateEntityQueue(state);
  markFirstRunnableInProgress(state);
  return state;
}

export function buildTaskGraphPromptSection(state: TaskGraphState): string {
  const compact = buildCompactTaskGraphState(state);
  return [
    "DYNAMIC_CHECKLIST:",
    `source=${state.intent.source}`,
    `profile=${compact.profile}`,
    `primaryClass=${state.intent.primaryClass ?? "none"}`,
    `targetClasses=${state.intent.targetEntityClasses?.join(",") || state.intent.primaryClass || "none"}`,
    `concerns=${state.intent.concerns.join(",") || "none"}`,
    `progress=${compact.progress.completedRequired}/${compact.progress.totalRequired}`,
    `entityProgress=${compact.progress.completedEntities}/${compact.progress.totalEntities}`,
    `activeStorey=${compact.activeStoreyId ?? "none"}`,
    `activeEntity=${compact.activeEntity?.id ?? "none"}`,
    `activeEntityClass=${compact.activeEntity?.class ?? state.intent.primaryClass ?? "none"}`,
    `activeTask=${compact.activeTask ? `${compact.activeTask.id}|${compact.activeTask.status}` : "none"}`,
    `clusterProgress=${compact.clusterProgress ? `${compact.clusterProgress.pendingCount}/${compact.clusterProgress.totalCount}|${compact.clusterProgress.status}` : "none"}`,
    `nextEntities=${compact.nextEntityIds.join(",") || "none"}`,
    "Instruction: use this checklist only as the current task brief. Ignore completed or unrelated subtasks.",
    "Instruction: stay focused on the activeTask and activeEntity first. Prefer per-entity navigation, measurement, and highlighting over bulk verdicts.",
    "Instruction: if repeated targets exist on the same storey, reuse the current storey and view setup before moving to the next entity.",
  ].join("\n");
}

export function summarizeTaskGraph(state: TaskGraphState): CompactTaskGraphState {
  return buildCompactTaskGraphState(state);
}

export function enrichTaskGraphFromText(state: TaskGraphState, text: string): TaskGraphState {
  const sourceText = extractTaskSourceText(text);
  const { profile, primaryClass } = detectPrimaryClass(sourceText);
  if (state.profile === "generic" && profile !== "generic") {
    state.profile = profile;
  }
  if (!state.intent.primaryClass && primaryClass) {
    state.intent.primaryClass = primaryClass;
    state.intent.repeatedEntityClass = primaryClass;
  }
  const targetEntityClasses = detectTargetEntityClasses(sourceText, state.profile, state.intent.primaryClass);
  if (targetEntityClasses.length) {
    state.intent.targetEntityClasses = uniqueClasses([...(state.intent.targetEntityClasses ?? []), ...targetEntityClasses]);
  }
  if (!state.intent.storeyHint) {
    state.intent.storeyHint = detectStoreyHint(sourceText);
  }
  if (state.intent.source === "unknown") {
    state.intent.source = inferPromptSource(text);
  }
  state.intent.concerns = mergeUniqueConcerns(state.intent.concerns, detectConcerns(sourceText, state.profile));

  for (const entityId of state.entities.trackedIds) {
    const entityClass = state.entities.byId[entityId]?.entityClass ?? state.intent.repeatedEntityClass ?? "IfcElement";
    rebuildEntityTasksForState(state, entityId, entityClass);
  }

  state.history.push(`Prompt enrichment: profile=${state.profile}, class=${state.intent.primaryClass ?? "none"}, concerns=${state.intent.concerns.join("|") || "none"}.`);
  markFirstRunnableInProgress(state);
  return state;
}
