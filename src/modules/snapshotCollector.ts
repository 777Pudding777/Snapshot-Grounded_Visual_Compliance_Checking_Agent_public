// src/modules/snapshotCollector.ts
// Captures viewer snapshots with metadata used by navigation and reporting.

import type { CameraProjectionState, ViewerSnapshot } from "../viewer/api";
import { createSnapshotDb } from "../storage/snapshotDb";

/**
 * Snapshot capture modes supported by the prototype.
 * Overlay and external-controller captures are reserved for later pipelines.
 */
export type SnapshotMode =
  | "PURE_RENDER"
  | "RENDER_PLUS_OVERLAY_2D"
  | "RENDER_PLUS_JSON_METADATA"
  | "MULTI_VIEW_BUNDLE";

/**
 * Stable artifact schema consumed by the reporter and VLM checker.
 */
export type SnapshotArtifact = {
  id: string;
  mode: SnapshotMode;

  images: Array<{
    label: string; // "render", "wide", "close", ...
    imageBase64Png: string;
  }>;

  meta: {
    timestampIso: string;
    modelId: string | null;

    camera: ViewerSnapshot["pose"];
    cameraProjection?: CameraProjectionState;

    visibility?: {
      mode: "all" | "isolate" | "unknown";
      visibleElementCount?: number;
    };

    contextPath?: string[];
    note?: string;
    context?: Record<string, unknown>;
  };
};

export type SnapshotRun = {
  runId: string;
  startedIso: string;
  artifacts: SnapshotArtifact[];
};

export type SnapshotStore = {
  add: (artifact: SnapshotArtifact) => void;
  list: () => SnapshotArtifact[];
  clear: () => void;
};

/**
 * Lightweight in-memory cache for UI previews and recent-run access.
 * IndexedDB remains the persisted store when enabled.
 */
export function createInMemorySnapshotStore(): SnapshotStore {
  const artifacts: SnapshotArtifact[] = [];
  return {
    add: (a) => artifacts.push(a),
    list: () => [...artifacts],
    clear: () => {
      artifacts.length = 0;
    },
  };
}

type ToastFn = (msg: string, ms?: number) => void;

/**
 * Visibility state reported by viewerApi for snapshot metadata.
 */
type VisibilityState = {
  mode: "all" | "isolate";
  lastIsolateCount?: number;
};

export function createSnapshotCollector(params: {
  viewerApi: {
    onModelLoaded: (cb: (p: { modelId: string; model: any }) => void) => () => void;
    
    getSnapshot: (opts?: { note?: string }) => Promise<ViewerSnapshot>;
    setCameraPose: (pose: ViewerSnapshot["pose"], smooth?: boolean) => Promise<void>;

    /**
     * Provides current visibility context, since isolation changes the visual evidence.
     */
    getVisibilityState?: () => VisibilityState;
  };

  /**
   * In-memory store for quick local access.
   * Persistence is handled separately by IndexedDB.
   */
  store?: SnapshotStore;

  toast?: ToastFn;

  defaultMode?: SnapshotMode;
  autoCaptureOnModelLoad?: boolean;

  /**
   * Persist snapshots to IndexedDB when available.
   * Capture should still work even if persistence fails.
   */
  persistToIndexedDb?: boolean;
}) {
  const {
    viewerApi,
    toast,
    store = createInMemorySnapshotStore(),
    defaultMode = "RENDER_PLUS_JSON_METADATA",
    autoCaptureOnModelLoad = true,
    persistToIndexedDb = true,
  } = params;

  // IndexedDB adapter, used only when persistence is enabled.
  const snapshotDb = createSnapshotDb();

let run: SnapshotRun = {
  runId: crypto.randomUUID(),
  startedIso: new Date().toISOString(),
  artifacts: [],
};


  // Register each run only once in IndexedDB.
  let runEnsured = false;

  function getVisibilityMeta(): SnapshotArtifact["meta"]["visibility"] {
    const vis = viewerApi.getVisibilityState?.();
    if (!vis) return { mode: "unknown" };

    if (vis.mode === "all") return { mode: "all" };
    return { mode: "isolate", visibleElementCount: vis.lastIsolateCount };
  }

  function makeId() {
    return `snap_${run.artifacts.length + 1}_${Date.now()}`;
  }

  /**
   * Persist asynchronously so large image writes do not block the viewer.
   */
  function persistArtifactAsync(artifact: SnapshotArtifact) {
    if (!persistToIndexedDb) return;

    // Ensure the run exists before writing artifacts.
    if (!runEnsured) {
      runEnsured = true;
      snapshotDb
        .ensureRun({ runId: run.runId, startedIso: run.startedIso })
        .catch((err) => {
          console.error("[SnapshotCollector] ensureRun failed", err);
          toast?.("Snapshot DB init failed (see console).");
        });
    }

    snapshotDb.saveArtifact(run.runId, artifact).catch((err) => {
      console.error("[SnapshotCollector] saveArtifact failed", err);
      toast?.("Snapshot persist failed (see console).");
    });
  }

  function addArtifact(a: SnapshotArtifact) {
    run.artifacts.push(a);
    store.add(a);
    persistArtifactAsync(a);
  }

  /**
   * Multi-view bundle with the current view and a simple closer view.
   * This is viewpoint-based rather than target-aware.
   */
  async function captureMultiView(note?: string): Promise<SnapshotArtifact> {
    const nowIso = new Date().toISOString();
    const visibility = getVisibilityMeta();

    const wide = await viewerApi.getSnapshot({ note: note ? `${note} (wide)` : "wide" });

    const eye = wide.pose.eye;
    const target = wide.pose.target;

    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;

    const closePose = {
      eye: { x: eye.x + dx * 0.15, y: eye.y + dy * 0.15, z: eye.z + dz * 0.15 },
      target: { ...target },
    };

    await viewerApi.setCameraPose(closePose, true);

    const close = await viewerApi.getSnapshot({ note: note ? `${note} (close)` : "close" });

    return {
      id: makeId(),
      mode: "MULTI_VIEW_BUNDLE",
      images: [
        { label: "wide", imageBase64Png: wide.imageBase64Png },
        { label: "close", imageBase64Png: close.imageBase64Png },
      ],
      meta: {
        timestampIso: nowIso,
        modelId: wide.meta.modelId,
        camera: wide.pose, // wide pose is the primary replay pose
        cameraProjection: (wide.meta.context?.cameraProjection as CameraProjectionState | undefined),
        visibility,
        contextPath: [],
        note,
        context: wide.meta.context,
      },
    };
  }

  async function capture(note?: string, mode: SnapshotMode = defaultMode): Promise<SnapshotArtifact> {
    if (mode === "MULTI_VIEW_BUNDLE") {
      const a = await captureMultiView(note);
      addArtifact(a);
      toast?.(`Snapshot bundle captured (${run.artifacts.length})`);
      return a;
    }

    const nowIso = new Date().toISOString();
    const visibility = getVisibilityMeta();

    const snap = await viewerApi.getSnapshot({ note });

    const artifact: SnapshotArtifact = {
      id: makeId(),
      mode,
      images: [{ label: "render", imageBase64Png: snap.imageBase64Png }],
      meta: {
        timestampIso: nowIso,
        modelId: snap.meta.modelId,
        camera: snap.pose,
        cameraProjection: (snap.meta.context?.cameraProjection as CameraProjectionState | undefined),
        visibility,
        contextPath: [],
        note,
        context: snap.meta.context,
      },
    };

    addArtifact(artifact);
    toast?.(`Snapshot captured (${run.artifacts.length})`);
    return artifact;
  }

  let unsub: (() => void) | null = null;

  function start() {
    if (unsub) return;

    // Create the run early so the DB has a stable bucket.
    if (persistToIndexedDb && !runEnsured) {
      runEnsured = true;
      snapshotDb
        .ensureRun({ runId: run.runId, startedIso: run.startedIso })
        .catch((err) => {
          console.error("[SnapshotCollector] ensureRun failed", err);
          toast?.("Snapshot DB init failed (see console).");
        });
    }

    unsub = viewerApi.onModelLoaded(async () => {
      if (!autoCaptureOnModelLoad) return;

      try {
        // Wait a couple frames so the model is visible before capture.
await new Promise<void>((r) => requestAnimationFrame(() => r()));
await new Promise<void>((r) => requestAnimationFrame(() => r()));

await capture("modelLoaded", "RENDER_PLUS_JSON_METADATA");

      } catch (err) {
        console.error("[SnapshotCollector] auto capture failed", err);
        toast?.("Snapshot auto-capture failed (see console).");
      }
    });
  }

  function stop() {
    unsub?.();
    unsub = null;
  }

  function getRun(): SnapshotRun {
    return { ...run, artifacts: [...run.artifacts] };
  }

async function reset(): Promise<void> {
  // Start a fresh run object.
  run = {
    runId: crypto.randomUUID(),
    startedIso: new Date().toISOString(),
    artifacts: [],
  };

  // Clear the in-memory cache.
  store.clear();

  // Recreate the DB run entry on the next write.
  runEnsured = false;

  if (persistToIndexedDb) {
    runEnsured = true;
    await snapshotDb.ensureRun({ runId: run.runId, startedIso: run.startedIso });
  }
}



  return {
    start,
    stop,
    capture,
    getRun,
    store,

    /**
     * Expose the DB adapter for debugging and report workflows.
     */
    db: persistToIndexedDb ? snapshotDb : null,
    reset,
  };
}
