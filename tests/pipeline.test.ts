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
      supportsVectorPaths: true,
      supportsSvg: true,
      supportsTextLayout: true,
      blendModes: ["normal", "multiply", "screen", "add"],
      supports2_5D: true,
      supports3D: false,
      workerCount: 4,
    } satisfies LenoutCapabilities,
    runtime: {
      state: "ready",
      resourceRevision: 0,
      deviceLosses: 0,
      lastDeviceLoss: null,
      ai: { backend: "none", completedTasks: 0, failedTasks: 0, pendingTasks: 0 },
    },
    display: {
      logicalWidth: 1,
      logicalHeight: 1,
      physicalWidth: 1,
      physicalHeight: 1,
      pixelRatio: 1,
      revision: 0,
    },
    resize(): boolean { return false; },
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

  it("redraws retained tiles after a DPI backing-store change", () => {
    const sg = createSceneGraph({ maxNodes: 10 });
    const tm = createTileManager(128);
    const renderer = stubRenderer();
    const pipeline = createRenderPipeline(sg, tm, renderer);
    const idx = sg.add(NodeKind.Vector, 0, 0, 100, 100);
    pipeline.setNodeCommands(idx, [
      { type: "rect", dst: { x: 0, y: 0, width: 100, height: 100 }, fill: [1, 0, 0, 1], radius: 0 },
    ]);
    pipeline.render(320, 180);

    const callsBefore = renderer.tileCalls.length;
    (renderer.display as { revision: number }).revision++;
    pipeline.render(320, 180);

    expect(renderer.tileCalls.slice(callsBefore).some((call) => call.dirty)).toBe(true);
  });

  it("keeps dirty tiles pending while GPU resources recover", () => {
    const sg = createSceneGraph({ maxNodes: 10 });
    const tm = createTileManager(128);
    const renderer = stubRenderer();
    const pipeline = createRenderPipeline(sg, tm, renderer);
    const idx = sg.add(NodeKind.Vector, 0, 0, 100, 100);
    pipeline.setNodeCommands(idx, [
      { type: "rect", dst: { x: 0, y: 0, width: 100, height: 100 }, fill: [1, 0, 0, 1], radius: 0 },
    ]);

    renderer.runtime.state = "recovering";
    pipeline.render(320, 180);
    expect(renderer.tileCalls).toHaveLength(0);

    renderer.runtime.state = "ready";
    renderer.runtime.resourceRevision++;
    pipeline.render(320, 180);
    expect(renderer.tileCalls.some((call) => call.dirty)).toBe(true);
  });

  it("composites farther 2.5D layers before foreground layers", () => {
    const sg = createSceneGraph({ maxNodes: 10 });
    const tm = createTileManager(128, { overscanTiles: 0 });
    const renderer = stubRenderer();
    const pipeline = createRenderPipeline(sg, tm, renderer);
    const foreground = sg.add(NodeKind.Vector, 0, 0, 50, 50);
    const background = sg.add(NodeKind.Vector, 0, 0, 50, 50);
    sg.setDepth(foreground, -1);
    sg.setDepth(background, 2);
    pipeline.setNodeCommands(foreground, [
      { type: "rect", dst: { x: 0, y: 0, width: 50, height: 50 }, fill: [1, 0, 0, 1], radius: 0 },
    ]);
    pipeline.setNodeCommands(background, [
      { type: "rect", dst: { x: 0, y: 0, width: 50, height: 50 }, fill: [0, 0, 1, 1], radius: 0 },
    ]);

    pipeline.render(100, 100);
    const commands = renderer.tileCalls.find((call) => call.cmds.length === 2)?.cmds;
    expect(commands?.map((command) => command.type === "rect" ? command.fill : null)).toEqual([
      [0, 0, 1, 1],
      [1, 0, 0, 1],
    ]);
  });
});
