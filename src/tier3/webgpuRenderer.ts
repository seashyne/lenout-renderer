import { createBrushRefiner } from "../neural/webnnBrushRefiner.js";
import type { LenoutCapabilities, LenoutRenderer, LenoutRendererOptions } from "../renderer.js";
import type { RenderCommand, RenderTile } from "../types.js";
import { createTextBitmapCache } from "./textBitmapCache.js";
import { appendBrushInstances, appendImageGeometry, appendSolidGeometry, transparentTileGeometry } from "./webgpuGeometry.js";
import { createWebGPUResources, type ImageResource, type WebGPUResources } from "./webgpuResources.js";

type DrawStep =
  | { kind: "solid"; vertexOffset: number; vertexCount: number; replace: boolean }
  | { kind: "image"; vertexOffset: number; vertexCount: number; image: ImageResource }
  | { kind: "brush"; firstInstance: number; instanceCount: number };

interface TileDrawPlan {
  solidValues: number[];
  imageValues: number[];
  brushValues: number[];
  steps: DrawStep[];
}

const buildTileDrawPlan = (
  commands: readonly RenderCommand[],
  tile: RenderTile,
  resources: WebGPUResources,
  textCache: ReturnType<typeof createTextBitmapCache>,
): TileDrawPlan => {
  const solidValues = transparentTileGeometry(tile);
  const imageValues: number[] = [];
  const brushValues: number[] = [];
  const steps: DrawStep[] = [{ kind: "solid", vertexOffset: 0, vertexCount: 6, replace: true }];

  for (const command of commands) {
    if (command.type === "image") {
      const image = resources.getImage(command.src);
      if (!image) continue;
      const geometry = appendImageGeometry(imageValues, command.dst, command.opacity);
      steps.push({ kind: "image", ...geometry, image });
      continue;
    }
    if (command.type === "text") {
      const text = textCache.get(command.text, command.font, command.x, command.y, command.color);
      if (!text) continue;
      const image = resources.getImage(text.source);
      if (!image) continue;
      const geometry = appendImageGeometry(imageValues, text.destination, 1);
      steps.push({ kind: "image", ...geometry, image });
      continue;
    }
    if (command.type === "brushDabs") {
      const instances = appendBrushInstances(brushValues, command.dabs);
      if (instances.instanceCount > 0) steps.push({ kind: "brush", ...instances });
      continue;
    }
    const geometry = appendSolidGeometry(solidValues, command, tile);
    if (geometry && geometry.vertexCount > 0) steps.push({ kind: "solid", ...geometry });
  }

  return { solidValues, imageValues, brushValues, steps };
};

const encodeTile = (
  encoder: GPUCommandEncoder,
  target: GPUTexture,
  plan: TileDrawPlan,
  tile: RenderTile,
  canvas: HTMLCanvasElement,
  resources: WebGPUResources,
): void => {
  const left = Math.max(0, Math.floor(tile.worldX));
  const top = Math.max(0, Math.floor(tile.worldY));
  const right = Math.min(canvas.width, Math.ceil(tile.worldX + tile.size));
  const bottom = Math.min(canvas.height, Math.ceil(tile.worldY + tile.size));
  if (right <= left || bottom <= top) return;

  const solidBuffer = resources.solidBuffer.upload(plan.solidValues);
  const imageBuffer = plan.imageValues.length > 0 ? resources.imageBuffer.upload(plan.imageValues) : null;
  const brushBuffer = plan.brushValues.length > 0 ? resources.brushBuffer.upload(plan.brushValues) : null;
  const pass = encoder.beginRenderPass({
    label: `Lenout tile ${tile.id}`,
    colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }],
  });
  pass.setScissorRect(left, top, right - left, bottom - top);
  pass.setBindGroup(0, resources.canvasBindGroup);

  for (const step of plan.steps) {
    if (step.kind === "solid") {
      pass.setPipeline(step.replace ? resources.solidReplacePipeline : resources.solidBlendPipeline);
      pass.setVertexBuffer(0, solidBuffer);
      pass.draw(step.vertexCount, 1, step.vertexOffset);
      continue;
    }
    if (step.kind === "image" && imageBuffer) {
      pass.setPipeline(resources.imagePipeline);
      pass.setBindGroup(1, step.image.bindGroup);
      pass.setVertexBuffer(0, imageBuffer);
      pass.draw(step.vertexCount, 1, step.vertexOffset);
      continue;
    }
    if (step.kind === "brush" && brushBuffer) {
      pass.setPipeline(resources.brushPipeline);
      pass.setVertexBuffer(0, resources.quadBuffer);
      pass.setVertexBuffer(1, brushBuffer);
      pass.draw(6, step.instanceCount, 0, step.firstInstance);
    }
  }
  pass.end();
};

export const createWebGPURenderer = async (
  canvas: HTMLCanvasElement,
  detectedCapabilities: LenoutCapabilities,
  options: LenoutRendererOptions = {},
): Promise<LenoutRenderer> => {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    throw new Error("Lenout Renderer: WebGPU is not available");
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference ?? "high-performance",
  });
  if (!adapter) throw new Error("Lenout Renderer: WebGPU adapter not available");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    throw new Error("Lenout Renderer: WebGPU canvas context not available");
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });
  const resources = createWebGPUResources(device, format);
  const textCache = createTextBitmapCache(128, resources.releaseImage);
  const neuralStrength = Math.max(0, Math.min(1, options.neuralBrushSmoothing ?? 0.18));
  const brushRefiner = await createBrushRefiner(neuralStrength > 0);
  const usesWebNN = brushRefiner.backend === "webnn" || brushRefiner.backend === "webnn-accelerated";
  const capabilities: LenoutCapabilities = {
    ...detectedCapabilities,
    tier: usesWebNN ? "webgpu+webnn" : "webgpu",
    webnnInference: usesWebNN,
    npuInference: false,
    neuralBackend: brushRefiner.backend,
    supports3D: false,
  };

  let accumulation: GPUTexture | undefined;
  let accumulationWidth = 0;
  let accumulationHeight = 0;
  let destroyed = false;

  const ensureAccumulation = (): void => {
    const width = canvas.width;
    const height = canvas.height;
    if (width < 1 || height < 1 || (width === accumulationWidth && height === accumulationHeight)) return;
    accumulation?.destroy();
    accumulation = device.createTexture({
      label: "Lenout accumulation surface",
      size: [width, height, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    accumulationWidth = width;
    accumulationHeight = height;
    resources.updateCanvasSize(width, height);
    const encoder = device.createCommandEncoder({ label: "Lenout accumulation reset" });
    encoder.beginRenderPass({
      colorAttachments: [{
        view: accumulation.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    }).end();
    device.queue.submit([encoder.finish()]);
  };

  return {
    capabilities,
    initialize() {
      ensureAccumulation();
    },
    async prepareCommands(commands) {
      if (neuralStrength === 0) return [...commands];
      const prepared: RenderCommand[] = [];
      for (const command of commands) {
        prepared.push(command.type === "brushDabs"
          ? { ...command, dabs: await brushRefiner.refine(command.dabs, neuralStrength) }
          : command);
      }
      return prepared;
    },
    beginFrame() {
      if (!destroyed) ensureAccumulation();
    },
    renderTile(tile, commands, isDirty) {
      if (destroyed || !isDirty || !accumulation) return;
      const plan = buildTileDrawPlan(commands, tile, resources, textCache);
      const encoder = device.createCommandEncoder({ label: `Lenout tile encoder ${tile.id}` });
      encodeTile(encoder, accumulation, plan, tile, canvas, resources);
      device.queue.submit([encoder.finish()]);
    },
    endFrame() {
      if (destroyed || !accumulation || canvas.width < 1 || canvas.height < 1) return;
      const encoder = device.createCommandEncoder({ label: "Lenout present" });
      encoder.copyTextureToTexture(
        { texture: accumulation },
        { texture: context.getCurrentTexture() },
        [canvas.width, canvas.height, 1],
      );
      device.queue.submit([encoder.finish()]);
      textCache.sweep();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      brushRefiner.destroy();
      textCache.destroy();
      resources.destroy();
      accumulation?.destroy();
      context.unconfigure();
      device.destroy();
    },
  };
};
