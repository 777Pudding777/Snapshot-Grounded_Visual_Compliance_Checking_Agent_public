// src/viewer/initViewer.ts
// initializes the viewer, returns context (components, world, loaders, etc.)

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { viewerEvents } from "./events";
import { _setActiveModel } from "./state";
import { VIEWER_GRID_REFERENCE } from "./gridConfig";
import { VIEWER_EDGE_OUTLINE_DEFAULTS } from "../config/prototypeSettings";

export type ViewerContext = {
  components: OBC.Components;
  world: OBC.World<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
  >;
  ifcLoader: any;
  fragments: any;
  hider: any;
  classifier: any;
    ifcApi?: {
    /** Return EXPRESS IDs for a given IFC type. */
    getAllItemsOfType: (modelId: number, ifcType: number, verbose?: boolean) => Promise<number[]>;

    /**
     * Convert a string like "IfcDoor" into the IFC type constant used by the manager.
     * Return null if unknown in this build.
     */
    ifcTypeMap: (ifcTypeName: string) => number | null;
  };
};


// Compute an ISO start pose given an object and its bounding sphere
async function waitForNonEmptyBounds(obj: THREE.Object3D, maxFrames = 30) {
  const box = new THREE.Box3();

  for (let i = 0; i < maxFrames; i++) {
    box.setFromObject(obj);

    if (!box.isEmpty()) return box.clone();

    // wait one frame and try again
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  return null;
}

function renderImportedIfcDoubleSided(obj: THREE.Object3D) {
  obj.traverse((child: any) => {
    const material = child?.material;
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    for (const mat of materials) {
      if (!mat || mat.side === THREE.DoubleSide) continue;
      mat.side = THREE.DoubleSide;
      mat.needsUpdate = true;
    }
  });
}

type EdgeOutlineRefreshable = THREE.Object3D & {
  userData: Record<string, any> & {
    refreshViewerEdgeOutlines?: () => void;
    rebuildViewerEdgeOutlines?: () => Promise<void>;
    setViewerEdgeOutlineVisibility?: (
      includeIds?: Iterable<number> | null,
      excludeIds?: Iterable<number> | null
    ) => void;
    disposeViewerEdgeOutlines?: () => void;
  };
};

function disposeViewerEdgeOutlineOverlay(overlay: THREE.Object3D) {
  overlay.removeFromParent();
  overlay.traverse((child: any) => {
    child.geometry?.dispose?.();
    const material = child.material;
    if (Array.isArray(material)) material.forEach((mat: any) => mat?.dispose?.());
    else material?.dispose?.();
  });
}

function sweepViewerEdgeOutlineOverlays(scene: THREE.Scene) {
  const overlays: THREE.Object3D[] = [];
  scene.traverse((child: any) => {
    if (child.userData?.viewerEdgeOutlineOverlay === true) overlays.push(child);
  });
  for (const overlay of overlays) disposeViewerEdgeOutlineOverlay(overlay);
}

function installImportedIfcEdgeOutlines(model: any, scene: THREE.Scene, camera: THREE.Camera) {
  if (!VIEWER_EDGE_OUTLINE_DEFAULTS.enabled || !model?.object) return;

  const root = model.object as EdgeOutlineRefreshable;
  const overlayGroup = new THREE.Group();
  overlayGroup.name = "viewer-edge-outline-overlay";
  overlayGroup.userData.viewerEdgeOutline = true;
  overlayGroup.userData.viewerEdgeOutlineOverlay = true;
  overlayGroup.renderOrder = VIEWER_EDGE_OUTLINE_DEFAULTS.renderOrder;
  scene.add(overlayGroup);
  const outlineSources = new Set<THREE.Object3D>([root]);
  let outlinedMeshes = new WeakSet<THREE.Mesh>();
  let refreshScheduled = false;
  let rebuildToken = 0;
  let modelDataOverlayBuilt = false;
  let disposed = false;
  let outlineIncludeIds: Set<number> | null = null;
  let outlineExcludeIds = new Set<number>();

  const outlineMaterial = new THREE.LineBasicMaterial({
    color: VIEWER_EDGE_OUTLINE_DEFAULTS.color,
    transparent: true,
    opacity: VIEWER_EDGE_OUTLINE_DEFAULTS.opacity,
    depthTest: true,
    depthWrite: false,
  });
  const isOutline = (obj: THREE.Object3D) => obj.userData?.viewerEdgeOutline === true;

  function removeExistingOutlines() {
    if (disposed) return;
    for (const child of [...overlayGroup.children]) {
      child.removeFromParent();
      const line = child as THREE.LineSegments;
      line.geometry?.dispose();
    }
    outlinedMeshes = new WeakSet<THREE.Mesh>();
  }

  function addOutlineToMesh(mesh: THREE.Mesh) {
    if (disposed) return;
    if (isOutline(mesh) || outlinedMeshes.has(mesh) || !mesh.visible || !mesh.geometry) return;

    const edgeGeometry = createSafeEdgesGeometry(mesh);
    if (!edgeGeometry) return;

    const position = edgeGeometry.getAttribute("position");
    if (!position || position.count < 2) {
      edgeGeometry.dispose();
      return;
    }

    const outline = new THREE.LineSegments(edgeGeometry, outlineMaterial);
    outline.name = "viewer-edge-outline";
    outline.userData.viewerEdgeOutline = true;
    outline.renderOrder = VIEWER_EDGE_OUTLINE_DEFAULTS.renderOrder;
    outline.frustumCulled = false;
    overlayGroup.add(outline);
    outlinedMeshes.add(mesh);
  }

  function createSafeEdgesGeometry(mesh: THREE.Mesh) {
    const sanitized = createSanitizedTriangleGeometry(mesh);
    if (!sanitized) return null;

    try {
      const edgeGeometry = new THREE.EdgesGeometry(
        sanitized,
        VIEWER_EDGE_OUTLINE_DEFAULTS.thresholdAngle
      );
      mesh.updateWorldMatrix(true, false);
      edgeGeometry.applyMatrix4(mesh.matrixWorld);
      applyCameraDepthBias(edgeGeometry);
      return edgeGeometry;
    } catch {
      return null;
    } finally {
      sanitized.dispose();
    }
  }

  function createSanitizedTriangleGeometry(mesh: THREE.Mesh): THREE.BufferGeometry | null {
    const geometry = mesh.geometry as THREE.BufferGeometry & { isLODGeometry?: boolean };
    if (geometry.isLODGeometry || geometry instanceof THREE.InstancedBufferGeometry) return null;
    if (looksLikeIfcSpaceMaterial(mesh.material)) return null;

    const position = geometry.getAttribute?.("position");
    const positionArray = copyPositionAttribute(position);
    if (!positionArray) return null;

    const index = geometry.getIndex?.();
    const vertexCount = positionArray.length / 3;
    const indexArray = index ? copyIndexAttribute(index, vertexCount) : null;
    const triangleCount = indexArray ? indexArray.length : vertexCount;
    if (triangleCount < 3 || triangleCount % 3 !== 0) return null;

    const sanitized = new THREE.BufferGeometry();
    sanitized.setAttribute("position", new THREE.BufferAttribute(positionArray, 3));
    if (indexArray) {
      sanitized.setIndex(new THREE.BufferAttribute(indexArray, 1));
    }
    return sanitized;
  }

  function copyPositionAttribute(attribute: any): Float32Array | null {
    if (!attribute || attribute.itemSize < 3 || attribute.count < 3) return null;

    const source = ArrayBuffer.isView(attribute.array)
      ? attribute.array
      : ArrayBuffer.isView(attribute.data?.array)
        ? attribute.data.array
        : null;
    if (!source) return null;

    const stride = typeof attribute.data?.stride === "number" ? attribute.data.stride : attribute.itemSize;
    const offset = typeof attribute.offset === "number" ? attribute.offset : 0;
    const out = new Float32Array(attribute.count * 3);

    for (let i = 0; i < attribute.count; i++) {
      const base = offset + i * stride;
      const x = Number(source[base]);
      const y = Number(source[base + 1]);
      const z = Number(source[base + 2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }

    return out;
  }

  function copyIndexAttribute(attribute: any, vertexCount: number): Uint16Array | Uint32Array | null {
    if (!attribute || attribute.count < 3 || attribute.count % 3 !== 0) return null;

    const source = ArrayBuffer.isView(attribute.array)
      ? attribute.array
      : ArrayBuffer.isView(attribute.data?.array)
        ? attribute.data.array
        : null;
    if (!source) return null;

    const out = vertexCount > 65535 ? new Uint32Array(attribute.count) : new Uint16Array(attribute.count);
    for (let i = 0; i < attribute.count; i++) {
      const value = Number(source[i]);
      if (!Number.isInteger(value) || value < 0 || value >= vertexCount) return null;
      out[i] = value;
    }

    return out;
  }

  function looksLikeIfcSpaceMaterial(material: THREE.Material | THREE.Material[]) {
    const materials = Array.isArray(material) ? material : [material];
    return materials.some((mat: any) => {
      const opacity = typeof mat?.opacity === "number" ? mat.opacity : 1;
      return mat?.transparent === true && opacity <= 0.25;
    });
  }

  function addOutlines(container: THREE.Object3D) {
    if (disposed) return;
    container.traverse((child: any) => {
      const mesh = child as THREE.Mesh;
      if (!(mesh as any).isMesh) return;
      try {
        addOutlineToMesh(mesh);
      } catch {
        // Some fragment tile geometries expose partial custom attributes.
        // They are safe to skip; the base mesh still renders normally.
      }
    });
  }

  function setsEqual(left: Set<number> | null, right: Set<number> | null) {
    if (left === right) return true;
    if (!left || !right || left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  function toNumberSet(values?: Iterable<number> | null) {
    if (!values) return null;
    const out = new Set<number>();
    for (const value of values) {
      const id = Number(value);
      if (Number.isInteger(id)) out.add(id);
    }
    return out;
  }

  root.userData.refreshViewerEdgeOutlines = () => {
    if (disposed) return;
    if (modelDataOverlayBuilt) return;
    removeExistingOutlines();
    for (const source of outlineSources) {
      addOutlines(source);
    }
  };

  root.userData.setViewerEdgeOutlineVisibility = (
    includeIds?: Iterable<number> | null,
    excludeIds?: Iterable<number> | null
  ) => {
    if (disposed) return;
    const nextIncludeIds = toNumberSet(includeIds);
    const nextExcludeIds = toNumberSet(excludeIds) ?? new Set<number>();
    if (
      modelDataOverlayBuilt &&
      setsEqual(outlineIncludeIds, nextIncludeIds) &&
      setsEqual(outlineExcludeIds, nextExcludeIds)
    ) {
      return;
    }
    outlineIncludeIds = nextIncludeIds;
    outlineExcludeIds = nextExcludeIds;
    scheduleRefresh();
  };

  root.userData.rebuildViewerEdgeOutlines = async () => {
    if (disposed) return;
    const token = ++rebuildToken;
    modelDataOverlayBuilt = false;
    removeExistingOutlines();
    const built = await addModelDataOutlines(token);
    if (disposed || token !== rebuildToken) return;
    modelDataOverlayBuilt = built;
    if (!built) {
      for (const source of outlineSources) {
        addOutlines(source);
      }
    }
  };

  function scheduleRefresh() {
    if (disposed) return;
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      if (disposed) return;
      void root.userData.rebuildViewerEdgeOutlines?.();
    });
  }

  root.userData.disposeViewerEdgeOutlines = () => {
    disposed = true;
    rebuildToken++;
    refreshScheduled = false;
    removeExistingOutlines();
    disposeViewerEdgeOutlineOverlay(overlayGroup);
    outlineMaterial.dispose();
    delete root.userData.refreshViewerEdgeOutlines;
    delete root.userData.rebuildViewerEdgeOutlines;
    delete root.userData.setViewerEdgeOutlineVisibility;
    delete root.userData.disposeViewerEdgeOutlines;
  };

  void root.userData.rebuildViewerEdgeOutlines();
  model.tiles?.onItemSet?.add?.(({ value }: { value: THREE.Object3D }) => {
    if (value) outlineSources.add(value);
    scheduleRefresh();
  });

  for (const [, tile] of model.tiles ?? []) {
    if (tile) outlineSources.add(tile);
  }

  async function addModelDataOutlines(token: number) {
    if (disposed) return false;
    if (
      typeof model.getItemsIdsWithGeometry !== "function" ||
      typeof model.getItemsGeometry !== "function"
    ) {
      return false;
    }

    try {
      const ids = await model.getItemsIdsWithGeometry();
      if (disposed || token !== rebuildToken || !Array.isArray(ids) || ids.length === 0) return false;

      const spaceIds = await getSpatialOutlineExcludedIds();
      const outlineIds = ids.filter((id: unknown) => {
        const localId = Number(id);
        return (
          Number.isInteger(localId) &&
          !spaceIds.has(localId) &&
          !outlineExcludeIds.has(localId) &&
          (!outlineIncludeIds || outlineIncludeIds.has(localId))
        );
      });
      if (outlineIds.length === 0) return false;

      const batchSize = 250;
      for (let i = 0; i < outlineIds.length; i += batchSize) {
        if (token !== rebuildToken) return true;
        if (disposed) return false;
        const batch = outlineIds.slice(i, i + batchSize);
        const geometries = await model.getItemsGeometry(batch, 0);
        if (disposed || token !== rebuildToken) return true;
        addMeshDataOutlines(geometries);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      console.debug("[Viewer] Edge outlines built", {
        items: outlineIds.length,
        outlines: overlayGroup.children.length,
      });
      return overlayGroup.children.length > 0;
    } catch (err) {
      if (!disposed) console.warn("[Viewer] Edge outline model-data build failed", err);
      return false;
    }
  }

  async function getSpatialOutlineExcludedIds() {
    const ids = new Set<number>();
    if (typeof model.getItemsOfCategories !== "function") return ids;

    try {
      const out = await model.getItemsOfCategories([
        /^IFCSPACE$/i,
        /^IFCSPATIALZONE$/i,
        /^IFCSPATIALELEMENT$/i,
        /^IFCEXTERNALSPATIALELEMENT$/i,
      ]);
      for (const values of Object.values(out ?? {})) {
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          const id = Number(value);
          if (Number.isInteger(id)) ids.add(id);
        }
      }
    } catch {
      // Rooms/spatial elements are intentionally skipped when available; if
      // the query fails, the outline layer still remains useful for geometry.
    }

    return ids;
  }

  function addMeshDataOutlines(itemsGeometry: any) {
    if (disposed) return;
    if (!Array.isArray(itemsGeometry)) return;
    for (const itemGeometry of itemsGeometry) {
      if (!Array.isArray(itemGeometry)) continue;
      for (const meshData of itemGeometry) {
        addMeshDataOutline(meshData);
      }
    }
  }

  function addMeshDataOutline(meshData: any) {
    if (disposed) return;
    const positions = meshData?.positions as
      | (ArrayBufferView & ArrayLike<number> & { length: number })
      | undefined;
    if (!positions || !ArrayBuffer.isView(positions as any) || positions.length < 9) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(
        positions instanceof Float32Array ? positions : new Float32Array(positions as ArrayLike<number>),
        3
      )
    );

    const indices = meshData?.indices as
      | (ArrayBufferView & ArrayLike<number> & { length: number })
      | undefined;
    if (indices && ArrayBuffer.isView(indices as any) && indices.length >= 3) {
      const indexArray =
        indices instanceof Uint16Array || indices instanceof Uint32Array
          ? indices
          : new Uint32Array(indices as ArrayLike<number>);
      geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
    }

    try {
      const edgeGeometry = new THREE.EdgesGeometry(
        geometry,
        VIEWER_EDGE_OUTLINE_DEFAULTS.thresholdAngle
      );
      applyMeshDataTransform(edgeGeometry, meshData?.transform);
      applyCameraDepthBias(edgeGeometry);

      const position = edgeGeometry.getAttribute("position");
      if (!position || position.count < 2) {
        edgeGeometry.dispose();
        return;
      }

      const outline = new THREE.LineSegments(edgeGeometry, outlineMaterial);
      outline.name = "viewer-edge-outline";
      outline.userData.viewerEdgeOutline = true;
      outline.renderOrder = VIEWER_EDGE_OUTLINE_DEFAULTS.renderOrder;
      outline.frustumCulled = false;
      overlayGroup.add(outline);
    } catch {
      // Ignore individual malformed representations.
    } finally {
      geometry.dispose();
    }
  }

  function applyMeshDataTransform(geometry: THREE.BufferGeometry, transform: any) {
    if (disposed) return;
    if (!transform) return;
    if (transform instanceof THREE.Matrix4) {
      geometry.applyMatrix4(transform);
      return;
    }
    if (Array.isArray(transform) && transform.length === 16) {
      geometry.applyMatrix4(new THREE.Matrix4().fromArray(transform));
      return;
    }
    if (Array.isArray(transform?.elements) && transform.elements.length === 16) {
      geometry.applyMatrix4(new THREE.Matrix4().fromArray(transform.elements));
    }
  }

  function applyCameraDepthBias(geometry: THREE.BufferGeometry) {
    const bias = VIEWER_EDGE_OUTLINE_DEFAULTS.depthBias;
    if (!Number.isFinite(bias) || bias <= 0) return;

    camera.updateWorldMatrix(true, false);
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    if (direction.lengthSq() === 0) return;

    direction.normalize().multiplyScalar(-bias);
    geometry.translate(direction.x, direction.y, direction.z);
  }
}




export async function initViewer(viewerDiv: HTMLDivElement): Promise<ViewerContext> {
  const components = new OBC.Components();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
  >();

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = new THREE.Color("#202932");

  world.renderer = new OBC.SimpleRenderer(components, viewerDiv);
  world.camera = new OBC.OrthoPerspectiveCamera(components);

  // Ensure snapshots include rendered image data.
(world.renderer.three as any).preserveDrawingBuffer = true;


  // Initial camera pose.
  await world.camera.controls.setLookAt(78, 20, -2.2, 26, -4, 25);

  components.init();
  const grid = components.get(OBC.Grids).create(world);
  grid.setup({
    primarySize: VIEWER_GRID_REFERENCE.primaryCellSize,
    secondarySize: VIEWER_GRID_REFERENCE.secondaryCellSize,
  });

  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: { path: "/", absolute: true },
    webIfc: { CIRCLE_SEGMENTS: 36 },
  });

  const fragments = components.get(OBC.FragmentsManager);
  fragments.init("/thatopen/worker.mjs");

  function refreshLoadedEdgeOutlines() {
    for (const [, model] of fragments.list) {
      void model?.object?.userData?.rebuildViewerEdgeOutlines?.();
    }
  }

  world.camera.controls.addEventListener("rest", () => {
    fragments.core.update(true);
    refreshLoadedEdgeOutlines();
  });

  const hider = components.get(OBC.Hider);
  const classifier = components.get(OBC.Classifier);

  // React when a model is added to the fragments list.
  fragments.list.onItemSet.add(async ({ value: model }: any) => {
    let modelId: string | null = null;
    for (const [id, m] of fragments.list) {
      if (m === model) { modelId = id; break; }
    }
    if (!modelId) return;

    model.useCamera(world.camera.three);
    sweepViewerEdgeOutlineOverlays(world.scene.three);
    world.scene.three.add(model.object);
    renderImportedIfcDoubleSided(model.object);
    installImportedIfcEdgeOutlines(model, world.scene.three, world.camera.three);
    fragments.core.update(true);




    // Fit the camera to the loaded model.
// Robust baseline fit.
// Ensure fragments update before reading bounds.
fragments.core.update(true);

// Wait until geometry exists so Box3 is not empty.
const box = await waitForNonEmptyBounds(model.object, 40);

if (!box) {
  console.warn("[Viewer] Model bounds still empty after waiting; keeping current camera pose");
} else {
  const sphere = box.getBoundingSphere(new THREE.Sphere());

  // Baseline fit (good fallback)
  world.camera.controls.fitToSphere(sphere, true);

  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  try {
    // Deterministic ISO view from the model bounds.
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() * 0.5;

    const dir = new THREE.Vector3(1, 0.8, 1).normalize();
    const dist = Math.max(radius * 2.2, 15);

    const eye = center.clone().add(dir.clone().multiplyScalar(dist));
    const target = center.clone().add(dir.clone().multiplyScalar(-radius * 0.6));

    // Clipping planes.
    world.camera.three.near = Math.max(radius / 2000, 0.02);
    world.camera.three.far = Math.max(radius * 80, 8000);
    world.camera.three.updateProjectionMatrix();

    await world.camera.controls.setLookAt(
      eye.x, eye.y, eye.z,
      target.x, target.y, target.z,
      true
    );
  } catch (e) {
    console.warn("[Viewer] ISO start view failed; keeping fitToSphere pose", e);
  }

  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}




    _setActiveModel(model, modelId);
    viewerEvents.emit("modelLoaded", { modelId, model });
  });

  return { components, 
    world, 
    ifcLoader, 
    fragments, 
    hider, 
    classifier,
    ifcApi: {
  getAllItemsOfType: async (modelId: number, ifcType: number, verbose?: boolean) => {
    // OpenBIM / ThatOpen loaders typically expose ifcManager under ifcLoader.ifcManager
    const mgr: any = (ifcLoader as any)?.ifcManager;
    if (!mgr?.getAllItemsOfType) {
      throw new Error("ifcApi.getAllItemsOfType: ifcManager.getAllItemsOfType not available");
    }
    // Deterministic: verbose defaults false
    return await mgr.getAllItemsOfType(modelId, ifcType, verbose ?? false);
  },

  ifcTypeMap: (ifcTypeName: string) => {
    const mgr: any = (ifcLoader as any)?.ifcManager;
    if (!mgr) return null;

    // Common patterns across builds:
    // 1) mgr.types.IfcDoor
    const t1 = mgr.types?.[ifcTypeName];
    if (typeof t1 === "number") return t1;

    // 2) global IFC constants (web-ifc): window[ifcTypeName]
    const t2 = (globalThis as any)[ifcTypeName];
    if (typeof t2 === "number") return t2;

    // 3) manager.IFC.* (rare)
    const t3 = mgr.IFC?.[ifcTypeName];
    if (typeof t3 === "number") return t3;

    return null;
  },
},

   };
}
