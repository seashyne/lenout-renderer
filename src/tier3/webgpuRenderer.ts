import { createBrushRefiner } from "../neural/webnnBrushRefiner.js";
import { resolveComposite } from "../compositor.js";
import { createCanvasDpiController } from "../dpi.js";
import type { LenoutDisplayMetrics } from "../dpi.js";
import { acquireLenoutGpuDevice, type LenoutGpuDeviceLease } from "../gpuDevice.js";
import type {
  LenoutCapabilities,
  LenoutRenderer,
  LenoutRendererOptions,
  LenoutRendererRuntimeStatus,
} from "../renderer.js";
import type { BlendMode, RenderCommand, RenderTile } from "../types.js";
import { createTextBitmapCache } from "./textBitmapCache.js";
import { appendBrushInstances, appendImageGeometry, appendSolidGeometry, transparentTileGeometry } from "./webgpuGeometry.js";
import { createWebGPUResources, type ImageResource, type WebGPUResources } from "./webgpuResources.js";

type DrawStep =
  | { kind: "solid"; vertexOffset: number; vertexCount: number; replace: boolean; blendMode: BlendMode }
  | { kind: "image"; vertexOffset: number; vertexCount: number; image: ImageResource; blendMode: BlendMode }
  | { kind: "brush"; firstInstance: number; instanceCount: number; blendMode: BlendMode };

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
  const steps: DrawStep[] = [{ kind: "solid", vertexOffset: 0, vertexCount: 6, replace: true, blendMode: "normal" }];

  for (const command of commands) {
    const composite = resolveComposite(command.composite);
    if (composite.opacity <= 0) continue;
    if (command.type === "image") {
      const image = resources.getImage(command.src);
      if (!image) continue;
      const geometry = appendImageGeometry(imageValues, command.dst, command.opacity * composite.opacity);
      steps.push({ kind: "image", ...geometry, image, blendMode: composite.blendMode });
      continue;
    }
    if (command.type === "text") {
      const text = textCache.get(command);
      if (!text) continue;
      const image = resources.getImage(text.source);
      if (!image) continue;
      const geometry = appendImageGeometry(imageValues, text.destination, composite.opacity);
      steps.push({ kind: "image", ...geometry, image, blendMode: composite.blendMode });
      continue;
    }
    if (command.type === "brushDabs") {
      const instances = appendBrushInstances(brushValues, command.dabs, composite.opacity);
      if (instances.instanceCount > 0) steps.push({ kind: "brush", ...instances, blendMode: composite.blendMode });
      continue;
    }
    const geometry = appendSolidGeometry(solidValues, command, tile);
    if (geometry && geometry.vertexCount > 0) steps.push({ kind: "solid", ...geometry, blendMode: composite.blendMode });
  }

  return { solidValues, imageValues, brushValues, steps };
};

const encodeTile = (
  encoder: GPUCommandEncoder,
  target: GPUTexture,
  plan: TileDrawPlan,
  tile: RenderTile,
  display: LenoutDisplayMetrics,
  resources: WebGPUResources,
): void => {
  const ratio = display.pixelRatio;
  const left = Math.max(0, Math.floor(tile.worldX * ratio));
  const top = Math.max(0, Math.floor(tile.worldY * ratio));
  const right = Math.min(display.physicalWidth, Math.ceil((tile.worldX + tile.size) * ratio));
  const bottom = Math.min(display.physicalHeight, Math.ceil((tile.worldY + tile.size) * ratio));
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
      pass.setPipeline(step.replace ? resources.solidReplacePipeline : resources.solidPipeline(step.blendMode));
      pass.setVertexBuffer(0, solidBuffer.buffer, solidBuffer.byteOffset);
      pass.draw(step.vertexCount, 1, step.vertexOffset);
      continue;
    }
    if (step.kind === "image" && imageBuffer) {
      pass.setPipeline(resources.imagePipeline(step.blendMode));
      pass.setBindGroup(1, step.image.bindGroup);
      pass.setVertexBuffer(0, imageBuffer.buffer, imageBuffer.byteOffset);
      pass.draw(step.vertexCount, 1, step.vertexOffset);
      continue;
    }
    if (step.kind === "brush" && brushBuffer) {
      pass.setPipeline(resources.brushPipeline(step.blendMode));
      pass.setVertexBuffer(0, resources.quadBuffer);
      pass.setVertexBuffer(1, brushBuffer.buffer, brushBuffer.byteOffset);
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
  const display = createCanvasDpiController(canvas, options);
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Lenout Renderer: WebGPU canvas context not available");
  const format = navigator.gpu.getPreferredCanvasFormat();
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
  const runtime: LenoutRendererRuntimeStatus = {
    state: "ready",
    resourceRevision: 0,
    deviceLosses: 0,
    lastDeviceLoss: null,
    ai: {
      backend: brushRefiner.backend,
      completedTasks: 0,
      failedTasks: 0,
      pendingTasks: 0,
    },
  };

  interface ActiveDeviceSession {
    accumulation?: GPUTexture;
    accumulationHeight: number;
    accumulationWidth: number;
    device: GPUDevice;
    frameEncoder?: GPUCommandEncoder;
    lease: LenoutGpuDeviceLease;
    resources: WebGPUResources;
    textCache: ReturnType<typeof createTextBitmapCache>;
  }

  const createDeviceSession = async (): Promise<ActiveDeviceSession> => {
    const lease = await acquireLenoutGpuDevice({
      powerPreference: options.powerPreference ?? "high-performance",
    });
    try {
      context.configure({
        device: lease.device,
        format,
        alphaMode: "premultiplied",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      });
      const resources = createWebGPUResources(lease.device, format);
      return {
        accumulationHeight: 0,
        accumulationWidth: 0,
        device: lease.device,
        lease,
        resources,
        textCache: createTextBitmapCache(128, resources.releaseImage, () => display.metrics.pixelRatio),
      };
    } catch (cause) {
      context.unconfigure();
      lease.release();
      throw cause;
    }
  };

  let destroyed = false;
  let recovery: Promise<void> | null = null;
  let recoveryFailures = 0;
  let nextRecoveryAt = 0;
  let active: ActiveDeviceSession | null;

  try {
    active = await createDeviceSession();
  } catch (cause) {
    brushRefiner.destroy();
    throw cause;
  }

  const disposeSession = (session: ActiveDeviceSession, unconfigure: boolean): void => {
    session.frameEncoder = undefined;
    session.textCache.destroy();
    session.resources.destroy();
    session.accumulation?.destroy();
    session.lease.release();
    if (unconfigure) context.unconfigure();
  };

  const ensureAccumulation = (session: ActiveDeviceSession): void => {
    const width = display.metrics.physicalWidth;
    const height = display.metrics.physicalHeight;
    if (width < 1 || height < 1) {
      session.accumulation?.destroy();
      session.accumulation = undefined;
      session.accumulationWidth = 0;
      session.accumulationHeight = 0;
      return;
    }
    if (width === session.accumulationWidth && height === session.accumulationHeight) return;
    session.accumulation?.destroy();
    session.accumulation = session.device.createTexture({
      label: "Lenout accumulation surface",
      size: [width, height, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    session.accumulationWidth = width;
    session.accumulationHeight = height;
    session.resources.updateCanvasSize(display.metrics.logicalWidth, display.metrics.logicalHeight);
    const encoder = session.device.createCommandEncoder({ label: "Lenout accumulation reset" });
    encoder.beginRenderPass({
      colorAttachments: [{
        view: session.accumulation.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    }).end();
    session.device.queue.submit([encoder.finish()]);
  };

  const scheduleRecovery = (): void => {
    if (destroyed || options.recoverDeviceLoss === false || recovery || performance.now() < nextRecoveryAt) return;
    runtime.state = "recovering";
    const pending = (async (): Promise<void> => {
      try {
        const recovered = await createDeviceSession();
        if (destroyed) {
          disposeSession(recovered, true);
          return;
        }
        active = recovered;
        recoveryFailures = 0;
        runtime.resourceRevision++;
        runtime.state = "ready";
        watchDevice(recovered);
      } catch {
        recoveryFailures++;
        nextRecoveryAt = performance.now() + Math.min(4_000, 250 * 2 ** (recoveryFailures - 1));
      }
    })();
    recovery = pending;
    void pending.finally(() => {
      if (recovery === pending) recovery = null;
    });
  };

  const handleDeviceLoss = (session: ActiveDeviceSession, info: GPUDeviceLostInfo): void => {
    if (destroyed || active !== session) return;
    active = null;
    runtime.deviceLosses++;
    runtime.lastDeviceLoss = { message: info.message, reason: info.reason };
    runtime.state = options.recoverDeviceLoss === false ? "lost" : "recovering";
    disposeSession(session, true);
    scheduleRecovery();
  };

  function watchDevice(session: ActiveDeviceSession): void {
    void session.lease.lost.then(
      (info) => handleDeviceLoss(session, info),
      () => handleDeviceLoss(session, { message: "WebGPU device lost", reason: "unknown" } as GPUDeviceLostInfo),
    );
  }

  watchDevice(active);

  return {
    capabilities,
    runtime,
    get display() {
      return display.metrics;
    },
    resize(width, height, pixelRatio) {
      return display.resize(width, height, pixelRatio);
    },
    initialize() {
      if (active) ensureAccumulation(active);
    },
    async prepareCommands(commands) {
      if (neuralStrength === 0) return [...commands];
      runtime.ai.pendingTasks++;
      try {
        const prepared: RenderCommand[] = [];
        for (const command of commands) {
          prepared.push(command.type === "brushDabs"
            ? { ...command, dabs: await brushRefiner.refine(command.dabs, neuralStrength) }
            : command);
        }
        runtime.ai.completedTasks++;
        return prepared;
      } catch (cause) {
        runtime.ai.failedTasks++;
        throw cause;
      } finally {
        runtime.ai.pendingTasks = Math.max(0, runtime.ai.pendingTasks - 1);
      }
    },
    beginFrame() {
      if (destroyed) return;
      if (!active) {
        scheduleRecovery();
        return;
      }
      ensureAccumulation(active);
      active.resources.beginFrame();
      active.frameEncoder = active.device.createCommandEncoder({ label: "Lenout frame" });
    },
    renderTile(tile, commands, isDirty) {
      const session = active;
      if (destroyed || !session || !isDirty || !session.accumulation || !session.frameEncoder) return;
      const plan = buildTileDrawPlan(commands, tile, session.resources, session.textCache);
      encodeTile(session.frameEncoder, session.accumulation, plan, tile, display.metrics, session.resources);
    },
    endFrame() {
      const session = active;
      if (destroyed || !session?.frameEncoder) return;
      const encoder = session.frameEncoder;
      session.frameEncoder = undefined;
      if (!session.accumulation || display.metrics.physicalWidth < 1 || display.metrics.physicalHeight < 1) {
        session.resources.endFrame();
        return;
      }
      encoder.copyTextureToTexture(
        { texture: session.accumulation },
        { texture: context.getCurrentTexture() },
        [display.metrics.physicalWidth, display.metrics.physicalHeight, 1],
      );
      session.device.queue.submit([encoder.finish()]);
      session.resources.endFrame();
      session.textCache.sweep();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      runtime.state = "destroyed";
      brushRefiner.destroy();
      if (active) {
        const session = active;
        active = null;
        disposeSession(session, true);
      } else {
        context.unconfigure();
      }
    },
  };
};
