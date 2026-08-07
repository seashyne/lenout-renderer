# Mellow

> *"Mellow" — the feeling of drawing on glass.*
> *No jank, no lag, no compromise.*

**Mellow** is the zero-dependency WebGPU render engine powering [Lenout](https://lenout.com).

## Architecture

```
┌──────────────────────────────────────────┐
│            createMellowRenderer()         │
│                  ↓                        │
│         detectMellowCapabilities()        │
│         ┌────────┼────────┐              │
│         ↓        ↓        ↓              │
│    Tier 3    Tier 2    Tier 1            │
│    WebGPU    WebGL 2   Canvas 2D         │
│    + NPU               + Workers         │
└──────────────────────────────────────────┘
```

| Tier | GPU API | Compute | 3D | NPU | Min Browser |
|------|---------|---------|----|-----|-------------|
| 3 — `webgpu+npu` | WebGPU | GPU shaders | ✅ | ✅ | Chrome 113+ |
| 3 — `webgpu` | WebGPU | GPU shaders | ✅ | ❌ | Chrome 113+ |
| 2 — `webgl2` | WebGL 2 | CPU Workers | ❌ | ❌ | All modern |
| 1 — `cpu` | Canvas 2D | CPU Workers | ❌ | ❌ | Every browser |

## Quick Start

```bash
npm install
npm run build
npm run demo
```

## Usage

```typescript
import { createMellowRenderer, detectMellowCapabilities } from "mellow-renderer";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

// Check what hardware we have
const caps = await detectMellowCapabilities();
console.log(`Running on tier: ${caps.tier}`);

// Create the renderer — auto-selects tier
const renderer = await createMellowRenderer(canvas);
renderer.start();

// Cleanup
renderer.destroy();
```

## Package Structure

```
src/
├── mellowRenderer.ts       ← Entry point + tier detection + factory
├── types.ts                ← Shared types (Rect, Color, RenderCommand, etc.)
├── tileManager.ts          ← Tile system (dirty marking, viewport culling, eviction)
├── sceneGraph.ts           ← SoA scene graph (flat typed arrays)
├── tier3/
│   └── webgpuRenderer.ts   ← Tier 3: native WebGPU + compute shaders + NPU
├── tier2/
│   └── webgl2Renderer.ts   ← Tier 2: WebGL 2 rendering, CPU compute fallback
├── tier1/
│   └── canvas2dRenderer.ts ← Tier 1: pure Canvas 2D + OffscreenCanvas Workers
├── shaders/
│   └── (WGSL shaders — coming soon)
└── workers/
    └── (Web Workers — coming soon)
```

## Key Design Decisions

- **Zero runtime dependencies** — only TypeScript + WebGPU/WebGL/Canvas APIs
- **Tile-based rendering** — only dirty tiles are re-rendered
- **SoA scene graph** — Structure-of-Arrays for CPU cache efficiency
- **Automatic tier detection** — no configuration needed
- **No GC in render loop** — object pools + flat buffers

## License

UNLICENSED — proprietary, all rights reserved.
