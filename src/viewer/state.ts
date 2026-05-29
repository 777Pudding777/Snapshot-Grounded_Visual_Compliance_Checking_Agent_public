// src/viewer/state.ts
// Active model state, IFC handles, accessors, and internal setters.

let activeModel: any | null = null;

// App-level model key, currently the IFC file name.
let activeModelId: string | null = null;

// Numeric handle used by ifcManager.getAllItemsOfType(...).
let activeIfcModelId: number | null = null;

// IFC type index for the active model: type name to EXPRESS IDs.
let activeIfcTypeIndex: Record<string, number[]> | null = null;
let activeIfcDoorOperationTypes: Record<number, string> | null = null;
export type IfcAggregateIndex = {
  parentToChildren: Record<number, number[]>;
  childToParents: Record<number, number[]>;
};
let activeIfcAggregateIndex: IfcAggregateIndex | null = null;
export type IfcDoorPlacementAxes = {
  location: [number, number, number];
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
};
let activeIfcDoorPlacementAxes: Record<number, IfcDoorPlacementAxes> | null = null;

export function getActiveIfcTypeIndex() {
  return activeIfcTypeIndex;
}

export function _setActiveIfcTypeIndex(index: Record<string, number[]> | null) {
  activeIfcTypeIndex = index;
}

export function getActiveIfcDoorOperationTypes() {
  return activeIfcDoorOperationTypes;
}

export function _setActiveIfcDoorOperationTypes(index: Record<number, string> | null) {
  activeIfcDoorOperationTypes = index;
}

export function getActiveIfcAggregateIndex() {
  return activeIfcAggregateIndex;
}

export function _setActiveIfcAggregateIndex(index: IfcAggregateIndex | null) {
  activeIfcAggregateIndex = index;
}

export function getActiveIfcDoorPlacementAxes() {
  return activeIfcDoorPlacementAxes;
}

export function _setActiveIfcDoorPlacementAxes(index: Record<number, IfcDoorPlacementAxes> | null) {
  activeIfcDoorPlacementAxes = index;
}


export function getActiveModel() {
  return activeModel;
}

export function getActiveModelId() {
  return activeModelId;
}

export function getActiveIfcModelId() {
  return activeIfcModelId;
}

export function hasActiveModel() {
  return Boolean(activeModel && activeModelId);
}

/**
 * Internal setter (only viewer/init/upload should call this).
 * Keep string modelId stable for DB/UI; store numeric IFC model id for IFC queries.
 */
export function _setActiveModel(model: any, modelId: string, ifcModelId?: number | null) {
  const isSameModelObject = activeModel === model;
  activeModel = model;
  activeModelId = modelId;

  if (ifcModelId !== undefined) {
    activeIfcModelId = ifcModelId ?? null;
  } else if (!isSameModelObject) {
    activeIfcModelId = null;
  }
}


/** Convenience helper for clearing state when a model is unloaded. */
export function _clearActiveModel() {
  activeModel = null;
  activeModelId = null;
  activeIfcModelId = null;
  activeIfcTypeIndex = null;
  activeIfcDoorOperationTypes = null;
  activeIfcAggregateIndex = null;
  activeIfcDoorPlacementAxes = null;
}
