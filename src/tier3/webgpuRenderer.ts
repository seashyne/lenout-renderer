import type { MellowCapabilities, MellowRenderer } from "../mellowRenderer.js";

/**
 * Tier 3 — WebGPU renderer with optional NPU acceleration.
 *
 * Uses native WebGPU API for rendering and compute shaders.
 * Supports tile-based rendering, GPU brush compute, and 3D.
 */

export const createWebGPURenderer = async (
  canvas: HTMLCanvasElement,
  capabilities: MellowCapabilities
): Promise<MellowRenderer> => {
  const adapter = await navigator.gpu!.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("Mellow: WebGPU adapter not available");

  const device = await adapter.requestDevice({
    requiredFeatures: [
      "float32-filterable" as GPUFeatureName,
      "texture-compression-bc" as GPUFeatureName,
    ],
  });

  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
  });

  let running = false;
  let frameId: number | null = null;

  const stop = (): void => {
    running = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
  };

  const render = (): void => {
    if (!running) return;

    const texture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder();

    // Clear pass — will be replaced by tile composition
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: { r: 0.03, g: 0.04, b: 0.08, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();

    device.queue.submit([encoder.finish()]);
    frameId = requestAnimationFrame(render);
  };

  return {
    capabilities,

    start(): void {
      running = true;
      frameId = requestAnimationFrame(render);
    },

    stop(): void {
      stop();
    },

    resize(width: number, height: number): void {
      canvas.width = width;
      canvas.height = height;
    },

    destroy(): void {
      stop();
      device.destroy();
    },
  };
};
