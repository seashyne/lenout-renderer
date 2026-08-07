import type { MellowCapabilities, MellowRenderer } from "../mellowRenderer.js";

/**
 * Tier 2 — WebGL 2 renderer.
 *
 * Uses WebGL 2 for GPU-accelerated 2D rendering.
 * Compute tasks (brush, blur) fall back to CPU Workers.
 */

export const createWebGL2Renderer = (
  canvas: HTMLCanvasElement,
  capabilities: MellowCapabilities
): MellowRenderer => {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: true,
  });
  if (!gl) throw new Error("Mellow: WebGL 2 context not available");

  let running = false;
  let frameId: number | null = null;

  const stop = (): void => {
    running = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
  };

  const render = (): void => {
    if (!running) return;
    gl.clearColor(0.03, 0.04, 0.08, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
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
      gl.viewport(0, 0, width, height);
    },

    destroy(): void {
      stop();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
};
