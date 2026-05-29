// src/utils/geometry.ts
// Geometry helper functions: getUnionBox and getCenterY.
// Space-to-level mapping currently uses the closest Y center.
// This is a reasonable heuristic for the prototype.

import * as THREE from "three";

/**
 * Geometry helpers use model.getBoxes() which is convenient but can be slow on huge models.
 * For a bachelor PoC this is acceptable.
 *
 * Later optimization options:
 * - cache boxes per id
 * - use fragments bounding volumes if available
 * - compute storey elevations from IFC metadata instead of geometry
 */

export async function getUnionBox(model: any, localIds: number[]) {
  const boxes: THREE.Box3[] = await model.getBoxes(localIds);
  const out = new THREE.Box3();
  for (const b of boxes) out.union(b);
  return out;
}

export async function getCenterY(model: any, localId: number) {
  const [box] = await model.getBoxes([localId]);
  const c = new THREE.Vector3();
  box.getCenter(c);
  return c.y;
}
