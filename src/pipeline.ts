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
import { parsePath } from "./pathParser.js";

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
  /** Execute one tile-aware frame. Pass canvas pixel dimensions. */
  render(viewportW: number, viewportH: number): void;
  /** Frame stats from last render() */
  readonly stats: PipelineStats;
}

/** Estimate a bounding rect for a single render command */
const commandBounds = (cmd: RenderCommand): Rect | null => {
  switch (cmd.type) {
    case "clear":
      return null;
    case "rect":
      return { x: cmd.dst.x, y: cmd.dst.y, width: cmd.dst.width, height: cmd.dst.height };
    case "image":
      return { x: cmd.dst.x, y: cmd.dst.y, width: cmd.dst.width, height: cmd.dst.height };
    case "circle":
      return { x: cmd.cx - cmd.radius, y: cmd.cy - cmd.radius, width: cmd.radius * 2, height: cmd.radius * 2 };
    case "ellipse":
      return { x: cmd.cx - cmd.rx, y: cmd.cy - cmd.ry, width: cmd.rx * 2, height: cmd.ry * 2 };
    case "line": {
      const lw = cmd.width / 2 + 2;
      const minX = Math.min(cmd.x1, cmd.x2) - lw;
      const minY = Math.min(cmd.y1, cmd.y2) - lw;
      return { x: minX, y: minY, width: Math.abs(cmd.x2 - cmd.x1) + lw * 2, height: Math.abs(cmd.y2 - cmd.y1) + lw * 2 };
    }
    case "polygon": {
      if (cmd.points.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of cmd.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case "path": {
      // Quick estimate: parse path to get bounding box
      const segs = parsePath(cmd.d);
      if (segs.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of segs) {
        if (s.cmd === "M" || s.cmd === "L") {
          if (s.x < minX) minX = s.x; if (s.y < minY) minY = s.y;
          if (s.x > maxX) maxX = s.x; if (s.y > maxY) maxY = s.y;
        } else if (s.cmd === "C") {
          const xs = [s.x, s.x1, s.x2];
          const ys = [s.y, s.y1, s.y2];
          for (const v of xs) { if (v < minX) minX = v; if (v > maxX) maxX = v; }
          for (const v of ys) { if (v < minY) minY = v; if (v > maxY) maxY = v; }
        }
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case "text": {
      const fontSize = Number(cmd.font.match(/([\d.]+)px/)?.[1] ?? 14);
      const estimatedWidth = Math.max(fontSize, cmd.text.length * fontSize);
      const estimatedHeight = fontSize * 1.6;
      return { x: cmd.x - 2, y: cmd.y - 2, width: estimatedWidth + 4, height: estimatedHeight + 4 };
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
  const nodeCommands = new Map<number, RenderCommand[]>();
  const preparations = new Map<number, {
    revision: number;
    commands: RenderCommand[];
    running: boolean;
  }>();
  let _stats: PipelineStats = { frameTime: 0, tileCount: 0, dirtyTileCount: 0, drawCalls: 0 };

  const markCommandsDirty = (commands: readonly RenderCommand[]): void => {
    for (const command of commands) {
      const bounds = commandBounds(command);
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
        nodeCommands.set(nodeIndex, prepared);
        markCommandsDirty(prepared);
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
      nodeCommands.set(nodeIndex, commands);
      markCommandsDirty(commands);
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
      const dirtyNodes = sceneGraph.flushDirty();

      // Mark tiles dirty for nodes that changed this frame
      for (const nodeIdx of dirtyNodes) {
        const cmds = nodeCommands.get(nodeIdx);
        if (!cmds) continue;
        for (const cmd of cmds) {
          const bounds = commandBounds(cmd);
          if (bounds) tileManager.markDirtyRect(bounds);
        }
      }

      // Get visible tiles (camera at origin, zoom = 1)
      const tiles = tileManager.visibleTiles(0, 0, 1, viewportW, viewportH);
      const allEntries = [...nodeCommands.entries()]
        .filter(([nodeIndex]) => sceneGraph.data.visible[nodeIndex] !== 0)
        .sort(([left], [right]) => (
          sceneGraph.data.zIndex[left]! - sceneGraph.data.zIndex[right]! || left - right
        ));
      let dirtyCount = 0;
      let drawCalls = 0;

      renderer.beginFrame();

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
          for (const command of commands) {
            if (command.type === "clear") {
              tileCmds.push(command);
              continue;
            }
            const bounds = commandBounds(command);
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
