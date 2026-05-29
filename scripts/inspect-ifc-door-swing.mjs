#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  IFCDOOR,
  IFCDOORSTANDARDCASE,
  IFCDOORSTYLE,
  IFCDOORTYPE,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELDEFINESBYTYPE,
  IfcAPI,
} from "web-ifc";

const require = createRequire(import.meta.url);
const filePath = process.argv[2];
const maxDoors = Number(process.argv[3] ?? 80);

if (!filePath) {
  console.error("Usage: node scripts/inspect-ifc-door-swing.mjs <model.ifc> [maxDoors]");
  process.exit(1);
}

const resolvedPath = path.resolve(filePath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`IFC file not found: ${resolvedPath}`);
  process.exit(1);
}

function vectorToArray(vector) {
  if (!vector || typeof vector.size !== "function" || typeof vector.get !== "function") return [];
  const out = [];
  for (let i = 0; i < vector.size(); i++) out.push(vector.get(i));
  return out;
}

function refId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  const record = value;
  return typeof record.value === "number" && Number.isFinite(record.value) ? record.value : null;
}

function refIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(refId).filter(Number.isFinite);
  const one = refId(value);
  return one == null ? [] : [one];
}

function scalarValue(value) {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const nested = value.map(scalarValue).filter(Boolean);
    return nested.length ? nested.join(", ") : undefined;
  }
  if (typeof value === "object") {
    const record = value;
    if (record.value != null && !(typeof record.value === "number" && record.type === 5)) {
      return scalarValue(record.value);
    }
    if (record.Name != null) return scalarValue(record.Name);
    if (record.name != null) return scalarValue(record.name);
  }
  return undefined;
}

function pickFields(line, keys) {
  const out = {};
  for (const key of keys) {
    const value = scalarValue(line?.[key]);
    if (value) out[key] = value;
  }
  return out;
}

function includesRef(refs, id) {
  return refs.some((candidate) => candidate === id);
}

function getLineSafe(api, modelID, expressID, flatten = false, inverse = false) {
  try {
    return api.GetLine(modelID, expressID, flatten, inverse);
  } catch {
    return null;
  }
}

function readPropertySet(api, modelID, propertySetId) {
  const pset = getLineSafe(api, modelID, propertySetId, false, false);
  if (!pset) return null;

  const name = scalarValue(pset.Name) ?? `#${propertySetId}`;
  const properties = {};
  for (const propertyId of refIds(pset.HasProperties)) {
    const prop = getLineSafe(api, modelID, propertyId, false, false);
    const propName = scalarValue(prop?.Name);
    if (!propName) continue;

    const nominal = scalarValue(prop?.NominalValue);
    const direct = pickFields(prop, [
      "OperationType",
      "UserDefinedOperationType",
      "PanelOperation",
      "PanelPosition",
      "PredefinedType",
    ]);
    const value = nominal ?? Object.values(direct).join(", ");
    if (value) properties[propName] = value;
  }

  const direct = pickFields(pset, [
    "OperationType",
    "UserDefinedOperationType",
    "PanelOperation",
    "PanelPosition",
    "PredefinedType",
  ]);
  Object.assign(properties, direct);

  return { id: propertySetId, name, properties };
}

function collectTypePsets(api, modelID, typeLine) {
  const out = [];
  for (const psetId of refIds(typeLine?.HasPropertySets)) {
    const pset = readPropertySet(api, modelID, psetId);
    if (pset) out.push(pset);
  }
  return out;
}

function collectDoorDiagnostics(api, modelID, doorIds) {
  const relationByType = vectorToArray(api.GetLineIDsWithType(modelID, IFCRELDEFINESBYTYPE, true))
    .map((id) => getLineSafe(api, modelID, id, false, false))
    .filter(Boolean);
  const relationByProperties = vectorToArray(api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES, true))
    .map((id) => getLineSafe(api, modelID, id, false, false))
    .filter(Boolean);

  return doorIds.slice(0, maxDoors).map((doorId) => {
    const door = getLineSafe(api, modelID, doorId, false, false);
    const direct = pickFields(door, [
      "GlobalId",
      "Name",
      "ObjectType",
      "Tag",
      "PredefinedType",
      "OperationType",
      "UserDefinedOperationType",
      "OverallOperationType",
    ]);

    const typeRefs = [];
    for (const rel of relationByType) {
      if (!includesRef(refIds(rel.RelatedObjects), doorId)) continue;
      const typeId = refId(rel.RelatingType);
      if (typeId != null) typeRefs.push(typeId);
    }

    const types = typeRefs.map((typeId) => {
      const typeLine = getLineSafe(api, modelID, typeId, false, false);
      return {
        id: typeId,
        entity: api.GetNameFromTypeCode(typeLine?.type ?? 0),
        fields: pickFields(typeLine, [
          "GlobalId",
          "Name",
          "ElementType",
          "PredefinedType",
          "OperationType",
          "UserDefinedOperationType",
          "OverallOperationType",
        ]),
        propertySets: collectTypePsets(api, modelID, typeLine),
      };
    });

    const propertySets = [];
    for (const rel of relationByProperties) {
      if (!includesRef(refIds(rel.RelatedObjects), doorId)) continue;
      const propertySetId = refId(rel.RelatingPropertyDefinition);
      if (propertySetId == null) continue;
      const pset = readPropertySet(api, modelID, propertySetId);
      if (pset) propertySets.push(pset);
    }

    return {
      id: doorId,
      entity: api.GetNameFromTypeCode(door?.type ?? 0),
      direct,
      types,
      propertySets,
    };
  });
}

function collectSwingSignals(door) {
  const signals = [];
  const addFields = (source, fields) => {
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (/operation|swing|hand|flip|mirror|facing/i.test(`${key} ${value}`)) {
        signals.push(`${source}.${key}=${value}`);
      }
    }
  };

  addFields("door", door.direct);
  for (const type of door.types) {
    addFields(`type#${type.id}`, type.fields);
    for (const pset of type.propertySets) addFields(`type#${type.id}.${pset.name}`, pset.properties);
  }
  for (const pset of door.propertySets) addFields(pset.name, pset.properties);

  return signals;
}

const text = fs.readFileSync(resolvedPath, "utf8");
const rawKeywordMatches = Array.from(
  new Set((text.match(/\b(?:SINGLE_SWING_[A-Z_]+|DOUBLE_DOOR_[A-Z_]+|OperationType|UserDefinedOperationType|OverallOperationType|HandFlipped|FacingFlipped|Swing|LEFT|RIGHT|REVERS|MIRROR)\b/gi) ?? [])
    .map((item) => item.toUpperCase()))
).sort();

const api = new IfcAPI();
api.SetWasmPath(path.dirname(require.resolve("web-ifc/web-ifc-node.wasm")) + path.sep, true);
await api.Init(undefined, true);

const modelID = api.OpenModel(new Uint8Array(fs.readFileSync(resolvedPath)));
if (modelID < 0) {
  console.error(`Failed to open IFC: ${resolvedPath}`);
  process.exit(1);
}

try {
  const schema = api.GetModelSchema(modelID);
  const doorIds = [
    ...vectorToArray(api.GetLineIDsWithType(modelID, IFCDOOR, false)),
    ...vectorToArray(api.GetLineIDsWithType(modelID, IFCDOORSTANDARDCASE, false)),
  ].filter((id, index, arr) => arr.indexOf(id) === index);

  const doorTypeCount = vectorToArray(api.GetLineIDsWithType(modelID, IFCDOORTYPE, true)).length;
  const doorStyleCount = vectorToArray(api.GetLineIDsWithType(modelID, IFCDOORSTYLE, true)).length;
  const diagnostics = collectDoorDiagnostics(api, modelID, doorIds);
  const diagnosticsWithSignals = diagnostics.map((door) => ({
    ...door,
    swingSignals: collectSwingSignals(door),
  }));

  const distinctSignals = Array.from(new Set(diagnosticsWithSignals.flatMap((door) => door.swingSignals))).sort();
  const doorsWithSignals = diagnosticsWithSignals.filter((door) => door.swingSignals.length).length;

  console.log(JSON.stringify({
    file: resolvedPath,
    schema,
    counts: {
      doors: doorIds.length,
      inspectedDoors: diagnosticsWithSignals.length,
      doorTypes: doorTypeCount,
      doorStyles: doorStyleCount,
      doorsWithSwingSignals: doorsWithSignals,
    },
    rawKeywordMatches,
    conclusion:
      doorsWithSignals === 0
        ? "No explicit door swing/operation/handing fields were found in inspected door data."
        : distinctSignals.length <= 2
          ? "Door data contains swing-like fields, but they appear uniform or sparse; per-instance swing may still require placement/geometry analysis."
          : "Door data contains multiple swing-like field values; the app should use these and/or geometry per door.",
    distinctSwingSignals: distinctSignals,
    doors: diagnosticsWithSignals,
  }, null, 2));
} finally {
  api.CloseModel(modelID);
}
