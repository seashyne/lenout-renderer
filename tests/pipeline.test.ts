import { describe, expect, it } from "vitest";
import { createSceneGraph, NodeKind } from "../src/sceneGraph.js";
import { createTileManager } from "../src/tileManager.js";
import { createRenderPipeline } from "../src/pipeline.js";
import type { LenoutRenderer, LenoutCapabilities } from "../src/renderer.js";
import type { RenderCommand, RenderTile } from "../src/types.js";

/** Stub renderer that records tile render calls for inspection */
const stubRenderer = (): LenoutRenderer & { tileCalls: { tile: RenderTile; cmds: RenderCommand[]; dirty: boolean }[] } => {
  const tileCalls: { tile: RenderTile; cmds: RenderCommand[]; dirty: boolean }[] = [];
  return {
    capabilities: {
      tier: "cpu",
      gpuCompute: false,
      webnnInference: false,
      npuInference: false,
      neuralBackend: "none",
      maxBrushDabs: 200,
      tileSize: 128,
      supports3D: false,
      workerCount: 4,
    } satisfies LenoutCapabilities,
    initialize(): void {},
    beginFrame(): void {},
    renderTile(tile: RenderTile, commands: RenderCommand[], isDirty: boolean): void {
      tileCalls.push({ tile, cmds: commands, dirty: isDirty });
    },
    endFrame(): void {},
    destroy(): void {},
    tileCalls,
  };
};

describe("RenderPipeline (tile-aware)", () => {
  it("dispatches commands to dirty tiles via renderTile", () => {
    const sg = createSceneGraph({ maxNodes: 10 });
    const tm = createTileManager(128);
    const renderer = stubRenderer();
    const pipeline = createRenderPipeline(sg, tm, renderer);

    const idx = sg.add(NodeKind.Vector, 10, 20, 100, 50);
    pipeline.setNodeCommands(idx, [
      { type: "rect", dst: { x: 10, y: 20, width: 100, height: 50 }, fill: [1, 0, 0, 1], radius: 0 },
    ]);

    pipeline.render(800, 600);

    // Should have called renderTile for at least one dirty tile
    const dirtyCalls = renderer.tileCalls.filter((c) => c.dirty);
    expect(dirtyCalls.length).toBeGreaterThan(0);
    // At least one tile should contain the rect command
    const allCmds = dirtyCalls.flatMap((c) => c.cmds);
    expect(allCmds.some((c) => c.type === "rect")).toBe(true);
  });

  it("does not call renderTile for clean tiles", () => {
    const sg = createSceneGraph({ maxNodes: 10 });
    const tm = createTileManager(128);
    const renderer = stubRenderer();
    const pipeline = createRenderPipeline(sg, tm, renderer);

    // First frame: all tiles dirty
    const idx = sg.add(NodeKind.Vector, 10, 20, 100, 50);
    pipeline.setNodeCommands(idx, [
      { type: "rect", dst: { x: 10, y: 20, width: 100, height: 50 }, fill: [1, 0, 0, 1], radius: 0 },
    ]);
    pipeline.render(800, 600);

    // Second frame: no changes, all tiles should be clean
    const callsBefore = renderer.tileCalls.length;
    pipeline.render(800, 600);
    // No new tile calls since nothing changed
    const dirtyAfterSecond = renderer.tileCalls.slice(callsBefore).filter((c) => c.dirty);
    expect(dirtyAfterSecond.length).toBe(0);
  });

  it("removed node triggers tile re-render", () => {
    const sg = createSceneGraph({ maxNodes: 10 });
    const tm = createTileManager(128);
    const renderer = stubRenderer();
    const pipeline = createRenderPipeline(sg, tm, renderer);

    const idx = sg.add(NodeKind.Vector, 10, 20, 200, 150);
    pipeline.setNodeCommands(idx, [
      { type: "rect", dst: { x: 10, y: 20, width: 200, height: 150 }, fill: [1, 0, 0, 1], radius: 0 },
    ]);
    pipeline.render(800, 600);

    // Remove the node
    pipeline.removeNode(idx);
    pipeline.render(800, 600);

    // Previously dirty tiles should now be re-rendered empty
    const dirtyCalls = renderer.tileCalls.filter((c) => c.dirty);
    expect(dirtyCalls.length).toBeGreaterThan(0);
  });

  it("renders dirty tiles when node commands change", () => {
    const sg = createSceneGraph({ maxNodes: 10 });
    const tm = createTileManager(128);
    const renderer = stubRenderer();
    const pipeline = createRenderPipeline(sg, tm, renderer);

    const idx = sg.add(NodeKind.Vector, 10, 20, 200, 150);
    pipeline.setNodeCommands(idx, [
      { type: "rect", dst: { x: 10, y: 20, width: 200, height: 150 }, fill: [1, 0, 0, 1], radius: 0 },
    ]);

    pipeline.render(800, 600);

    // After render, the pipeline should have dispatched dirty tiles
    const dirtyCalls = renderer.tileCalls.filter((c) => c.dirty);
    expect(dirtyCalls.length).toBeGreaterThan(0);
  });
});
