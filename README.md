# Lenout Renderer (night) 0.9

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
- one command encoder and one queue submission per rendered frame;
- growable frame-arena GPU buffers shared across dirty tiles;
- premultiplied-alpha geometry, image, text, and brush pipelines;
- correct line-width geometry and tessellated vector fills/strokes;
- procedural anti-aliased brush edges using WGSL derivatives;
- instanced brush dabs with growable GPU buffers;
- cached image and text textures with bounded text-cache eviction;
- automatic GPU device-loss recovery with a full retained-tile redraw;
- automatic fallback when WebGPU adapter/device creation fails.

## Vector and SVG

Night parses the common SVG path command set (`M/L/H/V/C/S/Q/T/A/Z`), normalizes relative and shorthand commands, and preserves open versus closed contours. A bounded LRU stores parsed and tessellated paths so a path shared by several tiles is prepared once instead of once per tile.

`compileSvg()` accepts static SVG markup and emits ordinary Night render commands. It supports nested `svg`/`g` groups, paths, rectangles, circles, ellipses, lines, polygons, polylines, text, inherited presentation styles, transforms, opacity, blend modes, and optional viewBox fitting. Scripts, external images, event attributes, doctypes, and entities are ignored or rejected rather than entering the render pipeline.

```typescript
import { compileSvg } from "@lenout/render/svg";

pipeline.setNodeCommands(node, compileSvg(svgMarkup, {
  destination: { x: 0, y: 0, width: 800, height: 600 },
}));
```

## Text layout

Text commands support explicit alignment, baseline, direction, maximum width, line height, and letter spacing. WebGPU and WebGL 2 share a DPI-aware bounded bitmap cache; Canvas 2D uses the same layout algorithm directly. This keeps wrapping and tile invalidation consistent across runtime tiers.

## Compositor

Commands can carry `composite.opacity` and `composite.blendMode`. The `normal`, `multiply`, `screen`, and additive modes are available on WebGPU, WebGL 2, and Canvas 2D. `flattenCompositeLayers()` converts nested retained layers into ordered commands while multiplying ancestor opacity without moving rendering policy into UI components.

The renderer is 2D with a 2.5D composition layer. Scene nodes carry depth and parallax values, farther planes composite first, and `@lenout/render/depth-projection` provides perspective projection for host tools. `supports2_5D` is `true`; `supports3D` remains deliberately `false` until a real 3D command and depth-buffer pipeline exist.

## Runtime recovery and diagnostics

`renderer.runtime.state` reports `ready`, `recovering`, `lost`, or `destroyed`. The default `recoverDeviceLoss: true` behavior reacquires the shared GPU device after a driver/browser reset. `resourceRevision` increments after recovery, causing the render pipeline to invalidate and redraw every retained tile instead of presenting stale pixels.

`renderer.runtime.ai` reports the active neural backend plus pending, completed, and failed asynchronous preparation tasks. AI refinement never blocks the live pointer path.

## DPI-aware rendering

Lenout keeps world coordinates in logical CSS pixels and sizes the canvas backing store independently. The default `pixelRatio: "auto"` follows `window.devicePixelRatio`, capped at `2` to control GPU memory. WebGPU, WebGL 2, Canvas 2D, text bitmaps, tile scissors, and brush rendering all use the same display metrics.

Call `renderer.resize(width, height)` with logical dimensions when the layout changes. The render pipeline also performs this synchronization from the logical viewport passed to `render()`. A DPI or size change resets the retained tile surface so the next frame is redrawn at the new resolution.

## WebNN brush refinement

Long brush strokes are prepared asynchronously so pointer rendering is never blocked. A fixed WebNN matrix graph smooths adjacent position, size, and opacity samples in batches. Short strokes use the equivalent CPU operation because dispatch overhead would be larger than the work. Pending pointer updates are coalesced so only the newest node command is refined.

WebNN requires a secure context. For embedded deployments, allow the `webnn` Permissions Policy for the application origin. If context creation, graph compilation, or dispatch fails, refinement falls back to the matching CPU implementation.

## Audio synchronization

Night does not own browser media elements or an audio mixer. Those remain in Lenout's media runtime so rendering and playback lifecycles stay separate. The host runtime uses a frame-aware drift policy: normal decoder jitter does not trigger repeated seeks, while paused playback and export use half-frame accuracy. Audio layers can use `NodeKind.Audio` in the shared scene graph and participate in 2.5D ordering without coupling playback state to rendering.

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
  recoverDeviceLoss: true,
});
renderer.initialize();

const pipeline = createRenderPipeline(sceneGraph, tileManager, renderer);
const bounds = canvas.parentElement!.getBoundingClientRect();
pipeline.render(bounds.width, bounds.height);

console.log(renderer.display);
// { logicalWidth, logicalHeight, physicalWidth, physicalHeight, pixelRatio, revision }

renderer.destroy();
```

Use `renderer.runtime` for a settings/diagnostics surface. A temporary `recovering` state is expected after device loss; the pipeline keeps dirty tiles pending until the new device is ready.

Set `neuralBrushSmoothing` to `0` to preserve raw dab values, or use a value from `0` to `1` to blend toward neural/CPU-refined values.

Set `pixelRatio` to a fixed number for deterministic screenshots or exports. `maxPixelRatio` accepts values up to `4`; higher ratios increase backing-store memory quadratically. Set `manageCssSize: false` only when the host application owns the canvas CSS size completely.

## Source layout

```text
src/
├── dpi.ts                      logical/physical display sizing
├── renderer.ts                 capability detection and tier factory
├── pipeline.ts                 dirty-tile orchestration and async preparation
├── depthProjection.ts          2.5D perspective and parallax projection
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

Run `npm run benchmark --workspace @lenout/render` to measure large-area invalidation, viewport cache hits, bounded LRU eviction, cached/uncached SVG paths, and wrapped text layout on the current machine.
