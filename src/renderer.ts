/**
 * Lenout Renderer (night) — zero-dependency WebGPU render engine.
 *
 * Codename "night" — the feeling of drawing on glass.
 * No jank, no lag, no compromise.
 *
 * @packageDocumentation
 */

export type LenoutTier = "cpu" | "webgl2" | "webgpu" | "webgpu+webnn";

import type { BlendMode, RenderCommand, RenderTile } from "./types.js";
import { probeWebNN } from "./neural/webnnBrushRefiner.js";
import type { NeuralBackend } from "./neural/webnnTypes.js";
import type { LenoutDisplayMetrics, LenoutDpiOptions, LenoutPixelRatio } from "./dpi.js";
import { acquireLenoutGpuDevice } from "./gpuDevice.js";

export type { LenoutDisplayMetrics, LenoutDpiOptions, LenoutPixelRatio } from "./dpi.js";

export interface LenoutRendererOptions extends LenoutDpiOptions {
  /** Strength of asynchronous neural dab smoothing. Zero disables refinement. */
  neuralBrushSmoothing?: number;
  powerPreference?: GPUPowerPreference;
  /** Automatically reacquire a WebGPU device after a browser/GPU reset. */
  recoverDeviceLoss?: boolean;
}

export type LenoutRendererRuntimeState = "ready" | "recovering" | "lost" | "destroyed";

/** Live renderer health. A resource revision change invalidates retained tiles. */
export interface LenoutRendererRuntimeStatus {
  state: LenoutRendererRuntimeState;
  resourceRevision: number;
  deviceLosses: number;
  lastDeviceLoss: { message: string; reason: GPUDeviceLostReason } | null;
  /** Live AI/WebNN command-preparation diagnostics. */
  ai: {
    backend: NeuralBackend;
    completedTasks: number;
    failedTasks: number;
    pendingTasks: number;
  };
}

export interface LenoutCapabilities {
  tier: LenoutTier;
  gpuCompute: boolean;
  /** WebNN graph execution is available. The browser chooses the physical accelerator. */
  webnnInference: boolean;
  /** @deprecated WebNN does not expose whether the selected accelerator is specifically an NPU. */
  npuInference: boolean;
  neuralBackend: NeuralBackend;
  maxBrushDabs: number;
  tileSize: number;
  supportsVectorPaths: boolean;
  supportsSvg: boolean;
  supportsTextLayout: boolean;
  blendModes: readonly BlendMode[];
  supports2_5D: boolean;
  supports3D: boolean;
  workerCount: number;
}

/**
 * Tile-aware renderer — the pipeline drives rendering per-tile.
 *
 * Frame lifecycle:
 *   1. beginFrame()  — prepare canvas / reset state
 *   2. renderTile()  — called once per dirty tile (skip for clean tiles)
 *   3. endFrame()    — finalize and present
 */
export interface LenoutRenderer {
  readonly capabilities: LenoutCapabilities;
  /** Runtime readiness and GPU-resource generation. */
  readonly runtime: LenoutRendererRuntimeStatus;
  /** Logical size and physical backing-store resolution currently in use. */
  readonly display: LenoutDisplayMetrics;
  /** Resize in logical CSS pixels. Returns true when the backing store changed. */
  resize(width: number, height: number, pixelRatio?: LenoutPixelRatio): boolean;
  /** One-time GPU resource allocation */
  initialize(): void;
  /** Optional asynchronous command preparation. Rendering continues with the unprepared commands meanwhile. */
  prepareCommands?(commands: readonly RenderCommand[]): Promise<RenderCommand[]>;
  /** Begin a new frame */
  beginFrame(): void;
  /** Render commands clipped to a single tile. isDirty=false skips (clean tile). */
  renderTile(tile: RenderTile, commands: RenderCommand[], isDirty: boolean): void;
  /** End the frame */
  endFrame(): void;
  /** Release all GPU resources */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

let cachedCapabilities: LenoutCapabilities | null = null;
const browser2DCapabilities = {
  supportsVectorPaths: true,
  supportsSvg: true,
  supportsTextLayout: true,
  blendModes: ["normal", "multiply", "screen", "add"] as const,
};

const checkWebGPU = async (): Promise<boolean> => {
  try {
    const lease = await acquireLenoutGpuDevice({ powerPreference: "high-performance" });
    lease.release();
    return true;
  } catch {
    return false;
  }
};
const checkWebGL2 = (): boolean => {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2"));
  } catch {
    return false;
  }
};

export const detectLenoutCapabilities = async (): Promise<LenoutCapabilities> => {
  if (cachedCapabilities) return cachedCapabilities;

  const workers = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4;
  const [webgpu, webnn] = await Promise.all([checkWebGPU(), probeWebNN()]);

  if (webgpu) {
    cachedCapabilities = {
      tier: webnn.available ? "webgpu+webnn" : "webgpu",
      gpuCompute: true,
      webnnInference: webnn.available,
      npuInference: false,
      neuralBackend: webnn.available ? (webnn.accelerated ? "webnn-accelerated" : "webnn") : "none",
      maxBrushDabs: Number.POSITIVE_INFINITY,
      tileSize: 256,
      ...browser2DCapabilities,
      supports2_5D: true,
      supports3D: false,
      workerCount: 1,
    };
    return cachedCapabilities;
  }

  if (checkWebGL2()) {
    cachedCapabilities = {
      tier: "webgl2",
      gpuCompute: false,
      webnnInference: false,
      npuInference: false,
      neuralBackend: "none",
      maxBrushDabs: 500,
      tileSize: 256,
      ...browser2DCapabilities,
      supports2_5D: true,
      supports3D: false,
      workerCount: workers,
    };
    return cachedCapabilities;
  }

  cachedCapabilities = {
    tier: "cpu",
    gpuCompute: false,
    webnnInference: false,
    npuInference: false,
    neuralBackend: "none",
    maxBrushDabs: 200,
    tileSize: 128,
    ...browser2DCapabilities,
    supports2_5D: true,
    supports3D: false,
    workerCount: workers,
  };
  return cachedCapabilities;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createLenoutRenderer = async (
  canvas: HTMLCanvasElement,
  options: LenoutRendererOptions = {},
): Promise<LenoutRenderer> => {
  const caps = await detectLenoutCapabilities();

  switch (caps.tier) {
    case "webgpu":
    case "webgpu+webnn": {
      try {
        const { createWebGPURenderer } = await import("./tier3/webgpuRenderer.js");
        return await createWebGPURenderer(canvas, caps, options);
      } catch {
        if (checkWebGL2()) {
          const { createWebGL2Renderer } = await import("./tier2/webgl2Renderer.js");
          return createWebGL2Renderer(canvas, {
            ...caps,
            tier: "webgl2",
            gpuCompute: false,
            webnnInference: false,
            neuralBackend: "none",
            maxBrushDabs: 500,
            supports2_5D: true,
            supports3D: false,
            workerCount: typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4,
          }, options);
        }
        const { createCanvas2DRenderer } = await import("./tier1/canvas2dRenderer.js");
        return createCanvas2DRenderer(canvas, {
          ...caps,
          tier: "cpu",
          gpuCompute: false,
          webnnInference: false,
          neuralBackend: "none",
          maxBrushDabs: 200,
          tileSize: 128,
          supports2_5D: true,
          supports3D: false,
        }, options);
      }
    }
    case "webgl2": {
      const { createWebGL2Renderer } = await import("./tier2/webgl2Renderer.js");
      return createWebGL2Renderer(canvas, caps, options);
    }
    default: {
      const { createCanvas2DRenderer } = await import("./tier1/canvas2dRenderer.js");
      return createCanvas2DRenderer(canvas, caps, options);
    }
  }
};
