import { BRUSH_SHADER, IMAGE_SHADER, SOLID_SHADER } from "./webgpuShaders.js";
import type { BlendMode } from "../types.js";

export interface ImageResource {
  bindGroup: GPUBindGroup;
}

export interface DynamicGPUBuffer {
  beginFrame(): void;
  upload(values: readonly number[]): { buffer: GPUBuffer; byteOffset: number };
  endFrame(): void;
  destroy(): void;
}

export interface WebGPUResources {
  canvasBindGroup: GPUBindGroup;
  solidReplacePipeline: GPURenderPipeline;
  solidPipeline(mode: BlendMode): GPURenderPipeline;
  imagePipeline(mode: BlendMode): GPURenderPipeline;
  brushPipeline(mode: BlendMode): GPURenderPipeline;
  solidBuffer: DynamicGPUBuffer;
  imageBuffer: DynamicGPUBuffer;
  brushBuffer: DynamicGPUBuffer;
  quadBuffer: GPUBuffer;
  getImage(source: ImageBitmap): ImageResource | null;
  releaseImage(source: ImageBitmap): void;
  beginFrame(): void;
  endFrame(): void;
  updateCanvasSize(width: number, height: number): void;
  destroy(): void;
}

const premultipliedBlend: GPUBlendState = {
  color: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

const blendState = (mode: BlendMode): GPUBlendState => {
  if (mode === "add") {
    return {
      color: { operation: "add", srcFactor: "one", dstFactor: "one" },
      alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
    };
  }
  if (mode === "multiply") {
    return {
      color: { operation: "add", srcFactor: "dst", dstFactor: "one-minus-src-alpha" },
      alpha: premultipliedBlend.alpha,
    };
  }
  if (mode === "screen") {
    return {
      color: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src" },
      alpha: premultipliedBlend.alpha,
    };
  }
  return premultipliedBlend;
};

const createDynamicBuffer = (
  device: GPUDevice,
  label: string,
  usage: GPUBufferUsageFlags,
): DynamicGPUBuffer => {
  let capacity = 0;
  let buffer: GPUBuffer | undefined;
  let cursor = 0;
  const retired = new Set<GPUBuffer>();
  return {
    beginFrame() {
      cursor = 0;
    },
    upload(values) {
      const byteLength = Math.max(4, values.length * Float32Array.BYTES_PER_ELEMENT);
      if (!buffer || cursor + byteLength > capacity) {
        if (buffer) retired.add(buffer);
        capacity = 2 ** Math.ceil(Math.log2(Math.max(byteLength, capacity * 2, 4)));
        buffer = device.createBuffer({ label, size: capacity, usage: usage | GPUBufferUsage.COPY_DST });
        cursor = 0;
      }
      const byteOffset = cursor;
      device.queue.writeBuffer(buffer, byteOffset, new Float32Array(values));
      cursor += byteLength;
      return { buffer, byteOffset };
    },
    endFrame() {
      if (!retired.size) return;
      const pending = [...retired];
      retired.clear();
      void device.queue.onSubmittedWorkDone().then(
        () => pending.forEach((entry) => entry.destroy()),
        () => pending.forEach((entry) => entry.destroy()),
      );
    },
    destroy() {
      buffer?.destroy();
      retired.forEach((entry) => entry.destroy());
      retired.clear();
      buffer = undefined;
      capacity = 0;
      cursor = 0;
    },
  };
};

const createPipeline = (
  device: GPUDevice,
  label: string,
  shader: string,
  layouts: GPUBindGroupLayout[],
  buffers: GPUVertexBufferLayout[],
  format: GPUTextureFormat,
  blend?: GPUBlendState,
): GPURenderPipeline => {
  const module = device.createShaderModule({ label: `${label} shader`, code: shader });
  return device.createRenderPipeline({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
    vertex: { module, entryPoint: "vertexMain", buffers },
    fragment: { module, entryPoint: "fragmentMain", targets: [{ format, blend }] },
    primitive: { topology: "triangle-list" },
  });
};

export const createWebGPUResources = (
  device: GPUDevice,
  format: GPUTextureFormat,
): WebGPUResources => {
  const canvasLayout = device.createBindGroupLayout({
    label: "Lenout canvas layout",
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
  });
  const imageLayout = device.createBindGroupLayout({
    label: "Lenout image layout",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });

  const solidBuffers: GPUVertexBufferLayout[] = [{
    arrayStride: 6 * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 2 * 4, format: "float32x4" },
    ],
  }];
  const imageBuffers: GPUVertexBufferLayout[] = [{
    arrayStride: 5 * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 2 * 4, format: "float32x2" },
      { shaderLocation: 2, offset: 4 * 4, format: "float32" },
    ],
  }];
  const brushBuffers: GPUVertexBufferLayout[] = [
    { arrayStride: 2 * 4, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
    {
      arrayStride: 10 * 4,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 1, offset: 0, format: "float32x2" },
        { shaderLocation: 2, offset: 2 * 4, format: "float32" },
        { shaderLocation: 3, offset: 3 * 4, format: "float32" },
        { shaderLocation: 4, offset: 4 * 4, format: "float32x4" },
        { shaderLocation: 5, offset: 8 * 4, format: "float32" },
        { shaderLocation: 6, offset: 9 * 4, format: "float32" },
      ],
    },
  ];

  const solidReplacePipeline = createPipeline(device, "Lenout solid replace", SOLID_SHADER, [canvasLayout], solidBuffers, format);
  const pipelineCache = new Map<string, GPURenderPipeline>();
  const blendedPipeline = (
    kind: "solid" | "image" | "brush",
    mode: BlendMode,
  ): GPURenderPipeline => {
    const key = `${kind}:${mode}`;
    const cached = pipelineCache.get(key);
    if (cached) return cached;
    const shader = kind === "solid" ? SOLID_SHADER : kind === "image" ? IMAGE_SHADER : BRUSH_SHADER;
    const layouts = kind === "image" ? [canvasLayout, imageLayout] : [canvasLayout];
    const buffers = kind === "solid" ? solidBuffers : kind === "image" ? imageBuffers : brushBuffers;
    const pipeline = createPipeline(device, `Lenout ${kind} ${mode}`, shader, layouts, buffers, format, blendState(mode));
    pipelineCache.set(key, pipeline);
    return pipeline;
  };

  const canvasBuffer = device.createBuffer({
    label: "Lenout canvas uniforms",
    size: 4 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const canvasBindGroup = device.createBindGroup({
    layout: canvasLayout,
    entries: [{ binding: 0, resource: { buffer: canvasBuffer } }],
  });
  const sampler = device.createSampler({
    label: "Lenout image sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  });
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
  const quadBuffer = device.createBuffer({
    label: "Lenout brush quad",
    size: quad.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(quadBuffer, 0, quad);

  const imageCache = new WeakMap<ImageBitmap, ImageResource & { texture: GPUTexture }>();
  const ownedTextures = new Set<GPUTexture>();
  const getImage = (source: ImageBitmap): ImageResource | null => {
    if (source.width < 1 || source.height < 1) return null;
    const cached = imageCache.get(source);
    if (cached) return cached;
    const texture = device.createTexture({
      label: "Lenout image texture",
      size: [source.width, source.height, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.copyExternalImageToTexture({ source }, { texture }, [source.width, source.height, 1]);
    const resource = {
      texture,
      bindGroup: device.createBindGroup({
        layout: imageLayout,
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: sampler },
        ],
      }),
    };
    imageCache.set(source, resource);
    ownedTextures.add(texture);
    return resource;
  };

  const solidBuffer = createDynamicBuffer(device, "Lenout solid vertices", GPUBufferUsage.VERTEX);
  const imageBuffer = createDynamicBuffer(device, "Lenout image vertices", GPUBufferUsage.VERTEX);
  const brushBuffer = createDynamicBuffer(device, "Lenout brush instances", GPUBufferUsage.VERTEX);

  return {
    canvasBindGroup,
    solidReplacePipeline,
    solidPipeline: (mode) => blendedPipeline("solid", mode),
    imagePipeline: (mode) => blendedPipeline("image", mode),
    brushPipeline: (mode) => blendedPipeline("brush", mode),
    solidBuffer,
    imageBuffer,
    brushBuffer,
    quadBuffer,
    getImage,
    releaseImage(source) {
      const resource = imageCache.get(source);
      if (!resource) return;
      ownedTextures.delete(resource.texture);
      imageCache.delete(source);
      // The cache may evict immediately after presentation; defer destruction
      // until every already-submitted tile that references this texture is done.
      void device.queue.onSubmittedWorkDone().then(
        () => resource.texture.destroy(),
        () => resource.texture.destroy(),
      );
    },
    beginFrame() {
      solidBuffer.beginFrame();
      imageBuffer.beginFrame();
      brushBuffer.beginFrame();
    },
    endFrame() {
      solidBuffer.endFrame();
      imageBuffer.endFrame();
      brushBuffer.endFrame();
    },
    updateCanvasSize(width, height) {
      device.queue.writeBuffer(canvasBuffer, 0, new Float32Array([
        width,
        height,
        width > 0 ? 1 / width : 0,
        height > 0 ? 1 / height : 0,
      ]));
    },
    destroy() {
      solidBuffer.destroy();
      imageBuffer.destroy();
      brushBuffer.destroy();
      quadBuffer.destroy();
      canvasBuffer.destroy();
      for (const texture of ownedTextures) texture.destroy();
      ownedTextures.clear();
    },
  };
};
