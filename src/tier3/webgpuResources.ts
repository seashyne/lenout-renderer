import { BRUSH_SHADER, IMAGE_SHADER, SOLID_SHADER } from "./webgpuShaders.js";

export interface ImageResource {
  bindGroup: GPUBindGroup;
}

export interface DynamicGPUBuffer {
  upload(values: readonly number[]): GPUBuffer;
  destroy(): void;
}

export interface WebGPUResources {
  canvasBindGroup: GPUBindGroup;
  solidBlendPipeline: GPURenderPipeline;
  solidReplacePipeline: GPURenderPipeline;
  imagePipeline: GPURenderPipeline;
  brushPipeline: GPURenderPipeline;
  solidBuffer: DynamicGPUBuffer;
  imageBuffer: DynamicGPUBuffer;
  brushBuffer: DynamicGPUBuffer;
  quadBuffer: GPUBuffer;
  getImage(source: ImageBitmap): ImageResource | null;
  releaseImage(source: ImageBitmap): void;
  updateCanvasSize(width: number, height: number): void;
  destroy(): void;
}

const premultipliedBlend: GPUBlendState = {
  color: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

const createDynamicBuffer = (
  device: GPUDevice,
  label: string,
  usage: GPUBufferUsageFlags,
): DynamicGPUBuffer => {
  let capacity = 0;
  let buffer: GPUBuffer | undefined;
  return {
    upload(values) {
      const byteLength = Math.max(4, values.length * Float32Array.BYTES_PER_ELEMENT);
      if (!buffer || byteLength > capacity) {
        buffer?.destroy();
        capacity = 2 ** Math.ceil(Math.log2(byteLength));
        buffer = device.createBuffer({ label, size: capacity, usage: usage | GPUBufferUsage.COPY_DST });
      }
      device.queue.writeBuffer(buffer, 0, new Float32Array(values));
      return buffer;
    },
    destroy() {
      buffer?.destroy();
      buffer = undefined;
      capacity = 0;
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
  const solidBlendPipeline = createPipeline(device, "Lenout solid blend", SOLID_SHADER, [canvasLayout], solidBuffers, format, premultipliedBlend);
  const imagePipeline = createPipeline(device, "Lenout image", IMAGE_SHADER, [canvasLayout, imageLayout], imageBuffers, format, premultipliedBlend);
  const brushPipeline = createPipeline(device, "Lenout brush", BRUSH_SHADER, [canvasLayout], brushBuffers, format, premultipliedBlend);

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
    solidBlendPipeline,
    solidReplacePipeline,
    imagePipeline,
    brushPipeline,
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
