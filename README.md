# Lenout Renderer (night)

Lenout Renderer is the project-owned, tile-based 2D renderer. It selects native WebGPU first and falls back to WebGL 2 or Canvas 2D when the browser cannot create a WebGPU device.

## Runtime tiers

| Tier | Drawing backend | Neural backend | Notes |
|---|---|---|---|
| `webgpu+webnn` | Native WebGPU | WebNN | WebNN context and graph are available |
| `webgpu` | Native WebGPU | CPU fallback | WebGPU drawing without WebNN |
| `webgl2` | WebGL 2 | None | Compatibility renderer |
| `cpu` | Canvas 2D | None | Last-resort renderer |

`webgpu+webnn` does not mean the browser guarantees a physical NPU. The current WebNN standard accepts an accelerated-execution preference, but the user agent chooses between available CPU, GPU, and dedicated ML accelerators. `capabilities.neuralBackend` reports `webnn-accelerated`, `webnn`, `cpu`, or `none`; the legacy `npuInference` field remains `false` because WebNN does not expose the selected physical device.

## WebGPU path

The Tier 3 renderer includes:

- persistent tile accumulation with dirty-tile clearing;
- premultiplied-alpha geometry, image, text, and brush pipelines;
- correct line-width geometry and tessellated vector fills/strokes;
- procedural anti-aliased brush edges using WGSL derivatives;
- instanced brush dabs with growable GPU buffers;
- cached image and text textures with bounded text-cache eviction;
- automatic fallback when WebGPU adapter/device creation fails.

The renderer is currently 2D. `supports3D` is deliberately `false` until a real 3D command and depth pipeline exist.

## DPI-aware rendering

Lenout keeps world coordinates in logical CSS pixels and sizes the canvas backing store independently. The default `pixelRatio: "auto"` follows `window.devicePixelRatio`, capped at `2` to control GPU memory. WebGPU, WebGL 2, Canvas 2D, text bitmaps, tile scissors, and brush rendering all use the same display metrics.

Call `renderer.resize(width, height)` with logical dimensions when the layout changes. The render pipeline also performs this synchronization from the logical viewport passed to `render()`. A DPI or size change resets the retained tile surface so the next frame is redrawn at the new resolution.

## WebNN brush refinement

Long brush strokes are prepared asynchronously so pointer rendering is never blocked. A fixed WebNN matrix graph smooths adjacent position, size, and opacity samples in batches. Short strokes use the equivalent CPU operation because dispatch overhead would be larger than the work. Pending pointer updates are coalesced so only the newest node command is refined.

WebNN requires a secure context. For embedded deployments, allow the `webnn` Permissions Policy for the application origin. If context creation, graph compilation, or dispatch fails, refinement falls back to the matching CPU implementation.

## Usage

```typescript
import { createLenoutRenderer } from "@lenout/render";
import { createRenderPipeline } from "@lenout/render/pipeline";

const canvas = document.querySelector("canvas")!;
const renderer = await createLenoutRenderer(canvas, {
  neuralBrushSmoothing: 0.18,
  powerPreference: "high-performance",
  pixelRatio: "auto",
  maxPixelRatio: 2,
});
renderer.initialize();

const pipeline = createRenderPipeline(sceneGraph, tileManager, renderer);
const bounds = canvas.parentElement!.getBoundingClientRect();
pipeline.render(bounds.width, bounds.height);

console.log(renderer.display);
// { logicalWidth, logicalHeight, physicalWidth, physicalHeight, pixelRatio, revision }

renderer.destroy();
```

Set `neuralBrushSmoothing` to `0` to preserve raw dab values, or use a value from `0` to `1` to blend toward neural/CPU-refined values.

Set `pixelRatio` to a fixed number for deterministic screenshots or exports. `maxPixelRatio` accepts values up to `4`; higher ratios increase backing-store memory quadratically. Set `manageCssSize: false` only when the host application owns the canvas CSS size completely.

## Source layout

```text
src/
├── dpi.ts                      logical/physical display sizing
├── renderer.ts                 capability detection and tier factory
├── pipeline.ts                 dirty-tile orchestration and async preparation
├── neural/
│   ├── webnnTypes.ts           narrow WebNN runtime types
│   └── webnnBrushRefiner.ts    accelerated graph and CPU fallback
└── tier3/
    ├── webgpuRenderer.ts       frame and tile orchestration
    ├── webgpuResources.ts      pipelines, buffers, and texture cache
    ├── webgpuGeometry.ts       command tessellation
    ├── webgpuShaders.ts        WGSL programs
    └── textBitmapCache.ts      bounded text raster cache
```

The package has no runtime dependencies. TypeScript, Vite, Vitest, and WebGPU declarations are development-only dependencies.
