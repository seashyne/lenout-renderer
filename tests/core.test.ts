import { describe, expect, it } from "vitest";
import { createSceneGraph, NodeKind } from "../src/sceneGraph.js";
import { createTileManager } from "../src/tileManager.js";

describe("SceneGraph", () => {
  it("adds nodes and returns valid indices", () => {
    const sg = createSceneGraph({ maxNodes: 100 });
    const a = sg.add(NodeKind.Image, 10, 20, 100, 50);
    const b = sg.add(NodeKind.Text, 30, 40, 200, 30);
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(sg.data.kinds[a]).toBe(NodeKind.Image);
    expect(sg.data.kinds[b]).toBe(NodeKind.Text);
    expect(sg.data.worldX[a]).toBe(10);
    expect(sg.data.worldY[b]).toBe(40);
  });

  it("marks nodes dirty and flushes", () => {
    const sg = createSceneGraph({ maxNodes: 100 });
    const a = sg.add(NodeKind.Image, 0, 0, 10, 10);
    const b = sg.add(NodeKind.Vector, 0, 0, 10, 10);

    // add() marks dirty automatically
    const dirty = sg.flushDirty();
    expect(dirty).toContain(a);
    expect(dirty).toContain(b);
    expect(dirty.length).toBe(2);

    // After flush, no more dirty
    expect(sg.flushDirty()).toEqual([]);

    // Manual mark
    sg.markDirty(a);
    expect(sg.flushDirty()).toEqual([a]);
  });

  it("reuses freed slots", () => {
    const sg = createSceneGraph({ maxNodes: 100 });
    sg.add(NodeKind.Image, 0, 0, 10, 10); // index 0
    const b = sg.add(NodeKind.Text, 0, 0, 10, 10); // index 1
    sg.remove(b); // free index 1
    const c = sg.add(NodeKind.Vector, 5, 5, 20, 20); // should reuse 1
    expect(c).toBe(1);
    expect(sg.data.kinds[1]).toBe(NodeKind.Vector);
  });

  it("throws when capacity exceeded", () => {
    const sg = createSceneGraph({ maxNodes: 2 });
    sg.add(NodeKind.Image, 0, 0, 1, 1);
    sg.add(NodeKind.Text, 0, 0, 1, 1);
    expect(() => sg.add(NodeKind.Vector, 0, 0, 1, 1)).toThrow();
  });

  it("updates transforms and marks dirty", () => {
    const sg = createSceneGraph({ maxNodes: 100 });
    const a = sg.add(NodeKind.Image, 0, 0, 100, 100);
    sg.flushDirty(); // clear

    sg.setTransform(a, 50, 60, 0.5, 2, 2);
    expect(sg.data.worldX[a]).toBe(50);
    expect(sg.data.worldY[a]).toBe(60);
    expect(sg.data.rotation[a]).toBe(0.5);
    expect(sg.data.scaleX[a]).toBe(2);
    expect(sg.data.scaleY[a]).toBe(2);
    expect(sg.flushDirty()).toEqual([a]);
  });
});

describe("TileManager", () => {
  it("creates tiles that cover the viewport", () => {
    const tm = createTileManager(256);
    const tiles = tm.visibleTiles(0, 0, 1, 800, 600);
    // 800/256 ≈ 4 tiles wide, 600/256 ≈ 3 tiles tall + 1 padding each side
    // = 6 columns × 5 rows = 30 base + extra = ~35 to 50 tiles
    expect(tiles.length).toBeGreaterThanOrEqual(30);
    expect(tiles.length).toBeLessThanOrEqual(56);
    // All tiles start dirty
    expect(tiles.every((t) => t.dirty)).toBe(true);
  });

  it("marks dirty rects", () => {
    const tm = createTileManager(256);
    // Populate tiles first
    tm.visibleTiles(0, 0, 1, 800, 600);

    // Mark a small rect as dirty
    tm.markDirtyRect({ x: 0, y: 0, width: 100, height: 100 });
    const tiles = tm.visibleTiles(0, 0, 1, 800, 600);
    // The (0,0) tile should still be dirty
    expect(tiles.some((t) => t.worldX === 0 && t.worldY === 0 && t.dirty)).toBe(true);
  });

  it("reuses existing tiles on subsequent calls", () => {
    const tm = createTileManager(256);
    const first = tm.visibleTiles(0, 0, 1, 800, 600);
    const second = tm.visibleTiles(0, 0, 1, 800, 600);
    // Same tile count (no new tiles created)
    expect(second.length).toBe(first.length);
  });

  it("resets all tiles", () => {
    const tm = createTileManager(256);
    tm.visibleTiles(0, 0, 1, 800, 600);
    tm.reset();
    const after = tm.visibleTiles(0, 0, 1, 800, 600);
    // All tiles should be dirty after reset + recreation
    expect(after.every((t) => t.dirty)).toBe(true);
  });

  it("evicts tiles that have not been accessed", () => {
    const tm = createTileManager(256);

    // Create tiles at (0,0) — these get lastAccessFrame = 0
    const first = tm.visibleTiles(0, 0, 1, 256, 256);
    expect(first.length).toBeGreaterThan(0);

    // Access (256,0) for several frames — those tiles stay fresh
    for (let i = 0; i < 5; i++) tm.visibleTiles(256, 0, 1, 256, 256);

    // Evict tiles older than 2 frames
    tm.evict(2);

    // Now access (0,0) again — old tiles evicted, new ones created with fresh access time
    const remaining = tm.visibleTiles(0, 0, 1, 256, 256);
    expect(remaining.every((t) => t.lastAccessFrame >= 5)).toBe(true);
  });

  it("keeps tiles accessed within the age window", () => {
    const tm = createTileManager(256);
    tm.visibleTiles(0, 0, 1, 256, 256); // frame 0
    tm.visibleTiles(0, 0, 1, 256, 256); // frame 1 — refreshes access

    // Evict tiles older than 0 frames — tiles accessed at frame 1 survive
    tm.evict(0);

    const tiles = tm.visibleTiles(0, 0, 1, 256, 256); // frame 2
    expect(tiles.length).toBeGreaterThan(0);
  });
});
