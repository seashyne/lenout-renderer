/**
 * Mellow — zero-dependency WebGPU render engine for Lenout.
 *
 * "Mellow" — the feeling of drawing on glass.
 * No jank, no lag, no compromise.
 *
 * @packageDocumentation
 */

export type MellowTier = "cpu" | "webgl2" | "webgpu" | "webgpu+npu";

export interface MellowCapabilities {
  tier: MellowTier;
  gpuCompute: boolean;
  npuInference: boolean;
  maxBrushDabs: number;
  tileSize: number;
  supports3D: boolean;
  workerCount: number;
}

export interface MellowRenderer {
  readonly capabilities: MellowCapabilities;
  start(): void;
  stop(): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

let cachedCapabilities: MellowCapabilities | null = null;

const checkWebGPU = async (): Promise<GPUAdapter | null> => {
  if (!("gpu" in navigator)) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    return adapter ?? null;
  } catch {
    return null;
  }
};

const checkNPU = async (): Promise<boolean> => {
  if (!("ml" in navigator)) return false;
  try {
    const ml = (navigator as any).ml;
    const context = await ml.createContext({ deviceType: "npu" });
    return context !== null;
  } catch {
    return false;
  }
};

const checkWebGL2 = (): boolean => {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2"));
  } catch {
    return false;
  }
};

export const detectMellowCapabilities = async (): Promise<MellowCapabilities> => {
  if (cachedCapabilities) return cachedCapabilities;

  const workers = navigator.hardwareConcurrency || 4;
  const gpuAdapter = await checkWebGPU();

  if (gpuAdapter) {
    const npu = await checkNPU();
    cachedCapabilities = {
      tier: npu ? "webgpu+npu" : "webgpu",
      gpuCompute: true,
      npuInference: npu,
      maxBrushDabs: Number.POSITIVE_INFINITY,
      tileSize: 256,
      supports3D: true,
      workerCount: 1,
    };
    return cachedCapabilities;
  }

  if (checkWebGL2()) {
    cachedCapabilities = {
      tier: "webgl2",
      gpuCompute: false,
      npuInference: false,
      maxBrushDabs: 500,
      tileSize: 256,
      supports3D: false,
      workerCount: workers,
    };
    return cachedCapabilities;
  }

  cachedCapabilities = {
    tier: "cpu",
    gpuCompute: false,
    npuInference: false,
    maxBrushDabs: 200,
    tileSize: 128,
    supports3D: false,
    workerCount: workers,
  };
  return cachedCapabilities;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createMellowRenderer = async (
  canvas: HTMLCanvasElement
): Promise<MellowRenderer> => {
  const caps = await detectMellowCapabilities();

  switch (caps.tier) {
    case "webgpu":
    case "webgpu+npu": {
      const { createWebGPURenderer } = await import("./tier3/webgpuRenderer.js");
      return createWebGPURenderer(canvas, caps);
    }
    case "webgl2": {
      const { createWebGL2Renderer } = await import("./tier2/webgl2Renderer.js");
      return createWebGL2Renderer(canvas, caps);
    }
    default: {
      const { createCanvas2DRenderer } = await import("./tier1/canvas2dRenderer.js");
      return createCanvas2DRenderer(canvas, caps);
    }
  }
};
