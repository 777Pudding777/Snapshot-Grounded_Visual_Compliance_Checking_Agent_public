// src/viewer/upload.ts
/**
 * IFC Upload helper (viewer-side).
 *
 * Why this exists:
 * - Keeps file input + IFC loading logic out of UI components.
 * - UI should only trigger "open dialog" and show messages.
 *
 * Keeps the file input hidden, loads IFC data from an ArrayBuffer, and relies
 * on a user-triggered click handler for browser file-picker access.
 */

import {
  _setActiveIfcAggregateIndex,
  _setActiveIfcDoorOperationTypes,
  _setActiveIfcDoorPlacementAxes,
  _setActiveIfcTypeIndex,
  type IfcAggregateIndex,
  type IfcDoorPlacementAxes,
} from "./state";


export type ToastFn = (msg: string, ms?: number) => void;

export function createIfcUpload(params: {
  ifcLoader: any;
  viewerApi: { clearModel: () => Promise<void>; hasModelLoaded: () => boolean };
  toast?: ToastFn;
  onLoadingChange?: (isLoading: boolean) => void;

  // Notifies the app shell after a model is loaded.
  onModelLoaded?: (p: { model: any; modelId: string; ifcModelId: number | null }) => void;
}) {

  const { ifcLoader, viewerApi, toast, onLoadingChange } = params;

  let isLoading = false;

  function setLoading(v: boolean) {
    isLoading = v;
    onLoadingChange?.(v);
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".ifc";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  // Deterministic IFC model ID resolution helper.
function resolveIfcModelIdDeterministic(ifcLoader: any, model: any): number | null {
  const asNum = (v: any) => (typeof v === "number" && isFinite(v) ? v : null);

  // Common fields on returned model objects, including alternate casing.
  const direct =
    asNum(model?.modelID) ??
    asNum(model?.modelId) ??
    asNum(model?.ifcModelId) ??
    asNum(model?.ifcID) ??
    asNum(model?.id) ??
    asNum(model?._id) ??
    asNum(model?.ifcMetadata?.modelID) ??
    asNum(model?.ifcMetadata?.modelId) ??
    null;
  if (direct != null) return direct;

  // Manager/API object fields; prototype methods are not always enumerable.
  const mgr: any = ifcLoader?.ifcManager;
  if (!mgr) return null;

  const mgrDirect =
    asNum(mgr.modelID) ??
    asNum(mgr.modelId) ??
    asNum(mgr.currentModelID) ??
    asNum(mgr.currentModelId) ??
    null;
  if (mgrDirect != null) return mgrDirect;

  // State access through "in" also covers getters and non-enumerable fields.
  const state = ("state" in mgr) ? mgr.state : null;
  if (state) {
    const stateDirect =
      asNum(state.modelID) ??
      asNum(state.modelId) ??
      asNum(state.currentModelID) ??
      asNum(state.currentModelId) ??
      null;
    if (stateDirect != null) return stateDirect;

    const models = (state as any).models;

    // Array-shaped model store.
    if (Array.isArray(models)) {
      for (let i = models.length - 1; i >= 0; i--) {
        const mid = asNum(models[i]?.modelID) ?? asNum(models[i]?.modelId) ?? asNum(models[i]?.id);
        if (mid != null) return mid;
      }
    }

    // Map/object-shaped model store.
    if (models && typeof models === "object") {
      const values = Object.values(models);
      for (const v of values) {
        const mid = asNum((v as any)?.modelID) ?? asNum((v as any)?.modelId) ?? asNum((v as any)?.id);
        if (mid != null) return mid;
      }
    }
  }

  return null;
}


// Build a lightweight IFC type index: type name to EXPRESS IDs.
async function buildIfcTypeIndexBestEffort(model: any): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};

  // Strategy A: model exposes a list of element IDs.
  let ids: number[] =
    typeof model?.getAllExpressIds === "function"
      ? await model.getAllExpressIds()
      : Array.isArray(model?.expressIDs)
        ? model.expressIDs
        : [];

  // Strategy B: infer IDs from model.properties.
  if (!ids.length) {
    const propsStore: any = model?.properties;
    if (propsStore instanceof Map) {
      ids = Array.from(propsStore.keys()).filter((x) => typeof x === "number" && isFinite(x));
    } else if (propsStore && typeof propsStore === "object") {
      ids = Object.keys(propsStore).map((k) => Number(k)).filter((x) => Number.isFinite(x));
    }
  }
  if (!ids.length) throw new Error("No way to enumerate express IDs.");

  // Deterministic iteration order.
  ids.sort((a, b) => a - b);

  const readProps = async (id: number): Promise<any> => {
    if (typeof model?.getProperties === "function") {
      return await model.getProperties(id);
    }
    const propsStore: any = model?.properties;
    if (propsStore instanceof Map) return propsStore.get(id) ?? null;
    if (propsStore && typeof propsStore === "object") return propsStore[id] ?? propsStore[String(id)] ?? null;
    return null;
  };

  for (const id of ids) {
    const props = await readProps(id);
    const t =
      props?.type ??
      props?.ifcType ??
      props?.entity ??
      props?.Entity ??
      null;

    if (typeof t !== "string" || !t) continue;

    if (!out[t]) out[t] = [];
    out[t].push(id);
  }

  return out;
}

function refId(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  return typeof value.value === "number" && Number.isFinite(value.value) ? value.value : null;
}

function refIds(value: any): number[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(refId).filter((id): id is number => id != null);
  const one = refId(value);
  return one == null ? [] : [one];
}

function scalarIfcValue(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const nested = value.map(scalarIfcValue).filter((v): v is string => Boolean(v));
    return nested.length ? nested.join(", ") : undefined;
  }
  if (typeof value === "object") {
    if (value.value != null && !(typeof value.value === "number" && value.type === 5)) {
      return scalarIfcValue(value.value);
    }
    return scalarIfcValue(value.Name ?? value.name);
  }
  return undefined;
}

async function buildIfcDoorOperationTypeIndexBestEffort(model: any): Promise<Record<number, string>> {
  const propsStore: any = model?.properties;
  const propsById =
    propsStore instanceof Map
      ? propsStore
      : propsStore && typeof propsStore === "object"
        ? new Map(Object.entries(propsStore).map(([key, value]) => [Number(key), value]))
        : new Map<number, any>();

  const ids = Array.from(propsById.keys()).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ids.length) return {};

  const readProps = async (id: number): Promise<any> => {
    if (propsById.has(id)) return propsById.get(id);
    return typeof model?.getProperties === "function" ? await model.getProperties(id) : null;
  };

  const out: Record<number, string> = {};
  for (const id of ids) {
    const rel = await readProps(id);
    if (!rel?.RelatingType || !rel?.RelatedObjects) continue;

    const typeId = refId(rel?.RelatingType);
    if (typeId == null) continue;

    const typeProps = await readProps(typeId);
    const operationType =
      scalarIfcValue(typeProps?.OperationType) ??
      scalarIfcValue(typeProps?.OverallOperationType) ??
      scalarIfcValue(typeProps?.UserDefinedOperationType);
    if (!operationType) continue;

    for (const doorId of refIds(rel?.RelatedObjects)) {
      out[doorId] = operationType;
    }
  }

  return out;
}

function normalizeStepToken(value: string): string | undefined {
  const cleaned = value.trim();
  if (!cleaned || cleaned === "$" || cleaned === "*") return undefined;
  return cleaned.replace(/^\./, "").replace(/\.$/, "").replace(/^'|'$/g, "");
}

function splitStepArguments(args: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    const next = args[i + 1];

    if (char === "'") {
      current += char;
      if (inString && next === "'") {
        current += next;
        i++;
      } else {
        inString = !inString;
      }
      continue;
    }

    if (!inString) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) {
        out.push(current.trim());
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) out.push(current.trim());
  return out;
}

function parseStepEntityRecords(text: string, entityName: string): Array<{ id: number; args: string[] }> {
  const records: Array<{ id: number; args: string[] }> = [];
  const pattern = new RegExp(`#(\\d+)\\s*=\\s*${entityName}\\s*\\(`, "gi");

  for (const match of text.matchAll(pattern)) {
    const id = Number(match[1]);
    if (!Number.isFinite(id)) continue;

    let depth = 1;
    let inString = false;
    let end = -1;
    const start = (match.index ?? 0) + match[0].length;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];
      if (char === "'") {
        if (inString && next === "'") {
          i++;
        } else {
          inString = !inString;
        }
        continue;
      }
      if (inString) continue;
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }

    if (end > start) records.push({ id, args: splitStepArguments(text.slice(start, end)) });
  }

  return records;
}

function parseStepRefIds(value: string | undefined): number[] {
  if (!value) return [];
  return Array.from(value.matchAll(/#(\d+)/g))
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

function buildIfcDoorOperationTypeIndexFromStepText(text: string): Record<number, string> {
  const operationByTypeId: Record<number, string> = {};
  for (const record of parseStepEntityRecords(text, "IFCDOORTYPE")) {
    const operation = normalizeStepToken(record.args[10] ?? "");
    if (operation && /SWING|DOOR|USERDEFINED/i.test(operation)) {
      operationByTypeId[record.id] = operation;
    }
  }

  const out: Record<number, string> = {};
  for (const record of parseStepEntityRecords(text, "IFCRELDEFINESBYTYPE")) {
    const typeId = parseStepRefIds(record.args[5])?.[0];
    const operation = typeId == null ? undefined : operationByTypeId[typeId];
    if (!operation) continue;
    for (const doorId of parseStepRefIds(record.args[4])) {
      out[doorId] = operation;
    }
  }

  return out;
}

function addUniqueRelation(map: Record<number, number[]>, from: number, to: number) {
  (map[from] ??= []);
  if (!map[from].includes(to)) map[from].push(to);
}

function buildIfcAggregateIndexFromStepText(text: string): IfcAggregateIndex {
  const parentToChildren: Record<number, number[]> = {};
  const childToParents: Record<number, number[]> = {};

  for (const record of parseStepEntityRecords(text, "IFCRELAGGREGATES")) {
    const parentId = parseStepRefIds(record.args[4])?.[0];
    const childIds = parseStepRefIds(record.args[5]);
    if (parentId == null || !childIds.length) continue;

    for (const childId of childIds) {
      addUniqueRelation(parentToChildren, parentId, childId);
      addUniqueRelation(childToParents, childId, parentId);
    }
  }

  for (const ids of Object.values(parentToChildren)) ids.sort((a, b) => a - b);
  for (const ids of Object.values(childToParents)) ids.sort((a, b) => a - b);
  return { parentToChildren, childToParents };
}

type Vec3Tuple = [number, number, number];
type PlacementTransform = {
  location: Vec3Tuple;
  x: Vec3Tuple;
  y: Vec3Tuple;
  z: Vec3Tuple;
};

const IDENTITY_PLACEMENT: PlacementTransform = {
  location: [0, 0, 0],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

function parseStepNumberTuple(value: string | undefined): number[] {
  if (!value) return [];
  const match = value.match(/\((.*)\)/);
  const body = match?.[1] ?? value;
  return body
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(Number.isFinite);
}

function toVec3(values: number[], fallback: Vec3Tuple): Vec3Tuple {
  return [
    values[0] ?? fallback[0],
    values[1] ?? fallback[1],
    values[2] ?? fallback[2],
  ];
}

function vecCross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vecNormalize(v: Vec3Tuple, fallback: Vec3Tuple): Vec3Tuple {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-9 ? [v[0] / len, v[1] / len, v[2] / len] : fallback;
}

function vecTransformDirection(parent: PlacementTransform, local: Vec3Tuple): Vec3Tuple {
  return [
    parent.x[0] * local[0] + parent.y[0] * local[1] + parent.z[0] * local[2],
    parent.x[1] * local[0] + parent.y[1] * local[1] + parent.z[1] * local[2],
    parent.x[2] * local[0] + parent.y[2] * local[1] + parent.z[2] * local[2],
  ];
}

function vecTransformPoint(parent: PlacementTransform, local: Vec3Tuple): Vec3Tuple {
  const dir = vecTransformDirection(parent, local);
  return [
    parent.location[0] + dir[0],
    parent.location[1] + dir[1],
    parent.location[2] + dir[2],
  ];
}

function buildIfcDoorPlacementAxesFromStepText(text: string): Record<number, IfcDoorPlacementAxes> {
  const points: Record<number, Vec3Tuple> = {};
  for (const record of parseStepEntityRecords(text, "IFCCARTESIANPOINT")) {
    points[record.id] = toVec3(parseStepNumberTuple(record.args[0]), [0, 0, 0]);
  }

  const directions: Record<number, Vec3Tuple> = {};
  for (const record of parseStepEntityRecords(text, "IFCDIRECTION")) {
    directions[record.id] = vecNormalize(toVec3(parseStepNumberTuple(record.args[0]), [1, 0, 0]), [1, 0, 0]);
  }

  const axisPlacements: Record<number, PlacementTransform> = {};
  for (const record of parseStepEntityRecords(text, "IFCAXIS2PLACEMENT3D")) {
    const locationId = parseStepRefIds(record.args[0])?.[0];
    const axisId = parseStepRefIds(record.args[1])?.[0];
    const refDirectionId = parseStepRefIds(record.args[2])?.[0];
    const location = locationId == null ? [0, 0, 0] as Vec3Tuple : points[locationId] ?? [0, 0, 0];
    const z = vecNormalize(axisId == null ? [0, 0, 1] : directions[axisId] ?? [0, 0, 1], [0, 0, 1]);
    const rawX = vecNormalize(
      refDirectionId == null ? [1, 0, 0] : directions[refDirectionId] ?? [1, 0, 0],
      [1, 0, 0]
    );
    const y = vecNormalize(vecCross(z, rawX), [0, 1, 0]);
    const x = vecNormalize(vecCross(y, z), rawX);
    axisPlacements[record.id] = { location, x, y, z };
  }

  const localPlacements: Record<number, { parentId: number | null; axisId: number | null }> = {};
  for (const record of parseStepEntityRecords(text, "IFCLOCALPLACEMENT")) {
    localPlacements[record.id] = {
      parentId: parseStepRefIds(record.args[0])?.[0] ?? null,
      axisId: parseStepRefIds(record.args[1])?.[0] ?? null,
    };
  }

  const resolved = new Map<number, PlacementTransform>();
  const resolving = new Set<number>();
  const resolvePlacement = (placementId: number | null): PlacementTransform => {
    if (placementId == null) return IDENTITY_PLACEMENT;
    const cached = resolved.get(placementId);
    if (cached) return cached;
    if (resolving.has(placementId)) return IDENTITY_PLACEMENT;
    resolving.add(placementId);

    const placement = localPlacements[placementId];
    if (!placement) {
      resolving.delete(placementId);
      return IDENTITY_PLACEMENT;
    }

    const parent = resolvePlacement(placement.parentId);
    const local = placement.axisId == null ? IDENTITY_PLACEMENT : axisPlacements[placement.axisId] ?? IDENTITY_PLACEMENT;
    const worldPlacement: PlacementTransform = {
      location: vecTransformPoint(parent, local.location),
      x: vecNormalize(vecTransformDirection(parent, local.x), [1, 0, 0]),
      y: vecNormalize(vecTransformDirection(parent, local.y), [0, 1, 0]),
      z: vecNormalize(vecTransformDirection(parent, local.z), [0, 0, 1]),
    };
    resolved.set(placementId, worldPlacement);
    resolving.delete(placementId);
    return worldPlacement;
  };

  const out: Record<number, IfcDoorPlacementAxes> = {};
  for (const record of parseStepEntityRecords(text, "IFCDOOR")) {
    const placementId = parseStepRefIds(record.args[5])?.[0];
    if (placementId == null) continue;
    const placement = resolvePlacement(placementId);
    out[record.id] = placement;
  }
  return out;
}


// Load IFC from a File object.
  async function loadIfcFromFile(file: File) {
    setLoading(true);
    toast?.(`Loading IFC: ${file.name}`);

    try {
      if (viewerApi.hasModelLoaded()) {
        await viewerApi.clearModel();
      }

      const data = await file.arrayBuffer();
      const buffer = new Uint8Array(data);
      const ifcText = new TextDecoder("utf-8").decode(buffer);

      console.log("[IFC] starting load:", file.name, file.size);
const model = await ifcLoader.load(buffer, false, file.name);
// Loader shape debug output.
const loaderProto = Object.getPrototypeOf(ifcLoader);
console.log("[IFC] ifcLoader debug", {
  loaderOwnKeys: Object.getOwnPropertyNames(ifcLoader).slice(0, 120),
  loaderProtoKeys: loaderProto ? Object.getOwnPropertyNames(loaderProto).slice(0, 200) : [],
});

const ifcModelId = resolveIfcModelIdDeterministic(ifcLoader, model);

try {
  const doorOperationTypes = buildIfcDoorOperationTypeIndexFromStepText(ifcText);
  _setActiveIfcDoorOperationTypes(doorOperationTypes);
  console.log("[IFC] early door operation type index built", {
    count: Object.keys(doorOperationTypes).length,
    sample: Object.entries(doorOperationTypes).slice(0, 5),
  });
} catch (e) {
  console.info("[IFC] early door operation type index not available in this build.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcDoorOperationTypes(null);
}

try {
  const aggregateIndex = buildIfcAggregateIndexFromStepText(ifcText);
  _setActiveIfcAggregateIndex(aggregateIndex);
  console.log("[IFC] aggregate index built", {
    parents: Object.keys(aggregateIndex.parentToChildren).length,
    children: Object.keys(aggregateIndex.childToParents).length,
    sample: Object.entries(aggregateIndex.parentToChildren).slice(0, 5),
  });
} catch (e) {
  console.info("[IFC] aggregate index not available in this build.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcAggregateIndex(null);
}

try {
  const doorPlacementAxes = buildIfcDoorPlacementAxesFromStepText(ifcText);
  _setActiveIfcDoorPlacementAxes(doorPlacementAxes);
  console.log("[IFC] early door placement axes index built", {
    count: Object.keys(doorPlacementAxes).length,
    sample: Object.entries(doorPlacementAxes).slice(0, 3),
  });
} catch (e) {
  console.info("[IFC] early door placement axes index not available in this build.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcDoorPlacementAxes(null);
}

params.onModelLoaded?.({
  model,
  modelId: file.name,
  ifcModelId,
});

// Build a tiny deterministic IFC type index.
// If indexing fails, category isolation remains unavailable.
try {
  const index = await buildIfcTypeIndexBestEffort(model);
  _setActiveIfcTypeIndex(index);
  console.log("[IFC] type index built", Object.keys(index).slice(0, 10), "…");
} catch (e) {
  console.info("[IFC] type index not available in this build; category isolation may be limited.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcTypeIndex(null);
}

try {
  const doorOperationTypes = {
    ...(await buildIfcDoorOperationTypeIndexBestEffort(model)),
    ...buildIfcDoorOperationTypeIndexFromStepText(ifcText),
  };
  _setActiveIfcDoorOperationTypes(doorOperationTypes);
  console.log("[IFC] door operation type index built", {
    count: Object.keys(doorOperationTypes).length,
    sample: Object.entries(doorOperationTypes).slice(0, 5),
  });
} catch (e) {
  console.info("[IFC] door operation type index not available in this build.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcDoorOperationTypes(null);
}

try {
  const aggregateIndex = buildIfcAggregateIndexFromStepText(ifcText);
  _setActiveIfcAggregateIndex(aggregateIndex);
  console.log("[IFC] aggregate index rebuilt", {
    parents: Object.keys(aggregateIndex.parentToChildren).length,
    children: Object.keys(aggregateIndex.childToParents).length,
    sample: Object.entries(aggregateIndex.parentToChildren).slice(0, 5),
  });
} catch (e) {
  console.info("[IFC] aggregate index not available in this build.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcAggregateIndex(null);
}

try {
  const doorPlacementAxes = buildIfcDoorPlacementAxesFromStepText(ifcText);
  _setActiveIfcDoorPlacementAxes(doorPlacementAxes);
  console.log("[IFC] door placement axes index built", {
    count: Object.keys(doorPlacementAxes).length,
    sample: Object.entries(doorPlacementAxes).slice(0, 3),
  });
} catch (e) {
  console.info("[IFC] door placement axes index not available in this build.", {
    reason: e instanceof Error ? e.message : String(e),
  });
  _setActiveIfcDoorPlacementAxes(null);
}


console.log("[IFC] loaded model ids", { modelId: file.name, ifcModelId });

// If still null, log only lightweight structural info.
if (ifcModelId == null) {
  const mgr: any = (ifcLoader as any)?.ifcManager;

  const mgrProto = mgr ? Object.getPrototypeOf(mgr) : null;
  const mgrProtoKeys = mgrProto ? Object.getOwnPropertyNames(mgrProto) : [];

  // Access state via "in" so getters and non-enumerable fields are covered.
  const hasState = mgr ? ("state" in mgr) : false;
  const stateVal = hasState ? (mgr as any).state : undefined;
  const stateProto = stateVal ? Object.getPrototypeOf(stateVal) : null;

  console.info("[IFC] numeric ifcModelId unavailable in this loader build (continuing). Debug:", {
    modelKeys: Object.getOwnPropertyNames(model ?? {}).slice(0, 80),
    modelProtoKeys: model ? Object.getOwnPropertyNames(Object.getPrototypeOf(model)).slice(0, 80) : [],
    ifcManagerType: mgr ? typeof mgr : "missing",
    ifcManagerProtoKeys: mgrProtoKeys.slice(0, 120),
    hasState,
    stateType: typeof stateVal,
    stateOwnKeys: stateVal ? Object.getOwnPropertyNames(stateVal).slice(0, 120) : [],
    stateProtoKeys: stateProto ? Object.getOwnPropertyNames(stateProto).slice(0, 120) : [],
    modelsType: stateVal ? typeof (stateVal as any).models : "no-state",
  });
}


// IFC load complete.

      console.log("[IFC] finished load:", file.name);

      toast?.(`Loaded IFC: ${file.name}`);
    } catch (err) {
      console.error("[IFC] load failed", err);
      toast?.("IFC load failed. Check console for details.");
    } finally {
      fileInput.value = "";
      setLoading(false); // setLoading already notifies onLoadingChange
    }
  }



// Open the hidden file picker.
  function openFileDialog() {
    if (isLoading) return;
    fileInput.click();
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await loadIfcFromFile(file);
  });

  return {
    openFileDialog,
    loadIfcFromFile,
    isLoading: () => isLoading,
  };
}
