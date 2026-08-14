// ---------------------------------------------------------------------------
// Render Pipeline — orchestrates scene graph → tile manager → renderer.
//
// Tile-aware render loop: only dirty tiles are re-rendered each frame.
// Clean tiles are preserved by the renderer's internal tile cache.
// ---------------------------------------------------------------------------

import type { SceneGraph } from "./sceneGraph.js";
import type { TileManager } from "./tileManager.js";
import type { LenoutRenderer } from "./renderer.js";
import type { RenderCommand, RenderTile, Rect } from "./types.js";
import { estimateTextBounds } from "./textLayout.js";
import { sharedVectorPathCache } from "./vectorPath.js";

export interface PipelineStats {
  frameTime: number;
  tileCount: number;
  dirtyTileCount: number;
  drawCalls: number;
}

export interface RenderPipeline {
  /** Register or replace render commands for a scene-graph node */
  setNodeCommands(nodeIndex: number, commands: RenderCommand[]): void;
  /** Remove a node's commands (called when node is removed) */
  removeNode(nodeIndex: number): void;
  /** Execute one tile-aware frame. Pass logical CSS-pixel dimensions. */
  render(viewportW: number, viewportH: number): void;
  /** Frame stats from last render() */
  readonly stats: PipelineStats;
}

interface StoredCommand {
  bounds: Rect | null;
  command: RenderCommand;
}

const expandBounds = (bounds: Rect, amount: number): Rect => ({
  x: bounds.x - amount,
  y: bounds.y - amount,
  width: bounds.width + amount * 2,
  height: bounds.height + amount * 2,
});

const pointsBounds = (points: readonly { x: number; y: number }[]): Rect | null => {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Estimate a bounding rect for a single render command */
const commandBounds = (cmd: RenderCommand): Rect | null => {
  switch (cmd.type) {
    case "clear":
      return null;
    case "rect":
      return expandBounds(cmd.dst, (cmd.stroke?.width ?? 0) / 2 + 1);
    case "image":
      return { x: cmd.dst.x, y: cmd.dst.y, width: cmd.dst.width, height: cmd.dst.height };
    case "circle":
      return expandBounds({ x: cmd.cx - cmd.radius, y: cmd.cy - cmd.radius, width: cmd.radius * 2, height: cmd.radius * 2 }, (cmd.stroke?.width ?? 0) / 2 + 1);
    case "ellipse":
      return expandBounds({ x: cmd.cx - cmd.rx, y: cmd.cy - cmd.ry, width: cmd.rx * 2, height: cmd.ry * 2 }, (cmd.stroke?.width ?? 0) / 2 + 1);
    case "line": {
      const lw = cmd.width / 2 + 2;
      const minX = Math.min(cmd.x1, cmd.x2) - lw;
      const minY = Math.min(cmd.y1, cmd.y2) - lw;
      return { x: minX, y: minY, width: Math.abs(cmd.x2 - cmd.x1) + lw * 2, height: Math.abs(cmd.y2 - cmd.y1) + lw * 2 };
    }
    case "polygon":
    case "polyline": {
      const bounds = pointsBounds(cmd.points);
      return bounds ? expandBounds(bounds, (cmd.stroke?.width ?? 0) / 2 + 1) : null;
    }
    case "path": {
      const bounds = sharedVectorPathCache.get(cmd.d).bounds;
      return bounds ? expandBounds(bounds, (cmd.stroke?.width ?? 0) / 2 + 1) : null;
    }
    case "text": {
      return estimateTextBounds(cmd);
    }
    case "brushDabs": {
      if (cmd.dabs.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const dab of cmd.dabs) {
        const r = dab.size / 2;
        if (dab.x - r < minX) minX = dab.x - r;
        if (dab.y - r < minY) minY = dab.y - r;
        if (dab.x + r > maxX) maxX = dab.x + r;
        if (dab.y + r > maxY) maxY = dab.y + r;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }
};

/** Check whether two axis-aligned rects overlap */
const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;

export const createRenderPipeline = (
  sceneGraph: SceneGraph,
  tileManager: TileManager,
  renderer: LenoutRenderer,
): RenderPipeline => {
  const nodeCommands = new Map<number, StoredCommand[]>();
  const preparations = new Map<number, {
    revision: number;
    commands: RenderCommand[];
    running: boolean;
  }>();
  let _stats: PipelineStats = { frameTime: 0, tileCount: 0, dirtyTileCount: 0, drawCalls: 0 };
  let displayRevision = renderer.display.revision;
  let resourceRevision = renderer.runtime.resourceRevision;

  const storeCommands = (commands: readonly RenderCommand[]): StoredCommand[] =>
    commands.map((command) => ({ bounds: commandBounds(command), command }));

  const markCommandsDirty = (commands: readonly StoredCommand[]): void => {
    for (const { bounds } of commands) {
      if (bounds) tileManager.markDirtyRect(bounds);
    }
  };

  const prepareLatestCommands = (nodeIndex: number, commands: RenderCommand[]): void => {
    if (!renderer.prepareCommands) return;
    const state = preparations.get(nodeIndex) ?? { revision: 0, commands, running: false };
    state.revision++;
    state.commands = commands;
    preparations.set(nodeIndex, state);
    if (state.running) return;
    state.running = true;

    const processLatest = async (): Promise<void> => {
      while (preparations.get(nodeIndex) === state) {
        const revision = state.revision;
        let prepared: RenderCommand[];
        try {
          prepared = await renderer.prepareCommands!(state.commands);
        } catch {
          if (revision !== state.revision) continue;
          state.running = false;
          return;
        }
        if (preparations.get(nodeIndex) !== state) return;
        if (revision !== state.revision) continue;
        markCommandsDirty(nodeCommands.get(nodeIndex) ?? []);
        const stored = storeCommands(prepared);
        nodeCommands.set(nodeIndex, stored);
        markCommandsDirty(stored);
        sceneGraph.markDirty(nodeIndex);
        state.running = false;
        return;
      }
    };

    void processLatest();
  };

  return {
    stats: _stats,

    setNodeCommands(nodeIndex, commands) {
      markCommandsDirty(nodeCommands.get(nodeIndex) ?? []);
      const stored = storeCommands(commands);
      nodeCommands.set(nodeIndex, stored);
      markCommandsDirty(stored);
      sceneGraph.markDirty(nodeIndex);
      prepareLatestCommands(nodeIndex, commands);
    },

    removeNode(nodeIndex) {
      markCommandsDirty(nodeCommands.get(nodeIndex) ?? []);
      nodeCommands.delete(nodeIndex);
      preparations.delete(nodeIndex);
    },

    render(viewportW: number, viewportH: number) {
      const t0 = performance.now();
      renderer.resize(viewportW, viewportH);
      if (
        renderer.display.revision !== displayRevision
        || renderer.runtime.resourceRevision !== resourceRevision
      ) {
        // Backing-store and recovered-device changes both invalidate retained pixels.
        tileManager.reset();
        displayRevision = renderer.display.revision;
        resourceRevision = renderer.runtime.resourceRevision;
      }
      const dirtyNodes = sceneGraph.flushDirty();

      // Mark tiles dirty for nodes that changed this frame
      for (const nodeIdx of dirtyNodes) {
        const commands = nodeCommands.get(nodeIdx);
        if (!commands) continue;
        for (const { bounds } of commands) {
          if (bounds) tileManager.markDirtyRect(bounds);
        }
      }

      // Get visible tiles (camera at origin, zoom = 1)
      const tiles = tileManager.visibleTiles(0, 0, 1, viewportW, viewportH);
      const allEntries = [...nodeCommands.entries()]
        .filter(([nodeIndex]) => sceneGraph.data.visible[nodeIndex] !== 0)
        .sort(([left], [right]) => (
          // Farther 2.5D layers are composited first; z-index remains the
          // deterministic order within the same depth plane.
          sceneGraph.data.depth[right]! - sceneGraph.data.depth[left]!
          || sceneGraph.data.zIndex[left]! - sceneGraph.data.zIndex[right]!
          || left - right
        ));
      let dirtyCount = 0;
      let drawCalls = 0;

      renderer.beginFrame();

      // A lost WebGPU device is recovered asynchronously. Keep every dirty
      // tile dirty until a replacement resource generation is ready.
      if (renderer.runtime.state !== "ready") {
        renderer.endFrame();
        Object.assign(_stats, {
          frameTime: performance.now() - t0,
          tileCount: tiles.length,
          dirtyTileCount: tiles.filter((tile) => tile.dirty).length,
          drawCalls: 0,
        });
        tileManager.evict(300);
        return;
      }

      for (const tile of tiles) {
        if (!tile.dirty) {
          // Clean tile: blit from cache
          renderer.renderTile(tile, [], false);
          continue;
        }
        dirtyCount++;

        // Preserve scene/z order. Grouping by command type changes compositing
        // whenever text, images, vectors, and strokes overlap.
        const tileRect: Rect = {
          x: tile.worldX,
          y: tile.worldY,
          width: tile.size,
          height: tile.size,
        };

        const tileCmds: RenderCommand[] = [];
        for (const [, commands] of allEntries) {
          for (const { bounds, command } of commands) {
            if (command.type === "clear") {
              tileCmds.push(command);
              continue;
            }
            if (bounds && rectsOverlap(bounds, tileRect)) tileCmds.push(command);
          }
        }
        drawCalls += tileCmds.length;

        renderer.renderTile(tile, tileCmds, true);
        tile.dirty = false;
      }

      renderer.endFrame();

      Object.assign(_stats, {
        frameTime: performance.now() - t0,
        tileCount: tiles.length,
        dirtyTileCount: dirtyCount,
        drawCalls,
      });

      tileManager.evict(300);
    },
  };
};
