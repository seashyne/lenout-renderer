import type { MellowCapabilities, MellowRenderer } from "../mellowRenderer.js";

/**
 * Tier 1 — Canvas 2D renderer (CPU only).
 *
 * Pure software rendering using OffscreenCanvas + Web Workers.
 * Works on every device, including those without any GPU.
 */

export const createCanvas2DRenderer = (
  canvas: HTMLCanvasElement,
  capabilities: MellowCapabilities
): MellowRenderer => {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Mellow: Canvas 2D context not available");

  let running = false;
  let frameId: number | null = null;

  const stop = (): void => {
    running = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
  };

  const render = (): void => {
    if (!running) return;
    ctx.fillStyle = "#080b10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    },
  };
};
