import type { RenderTile, Rect } from "./types.js";

/**
 * Tile Manager — divides the viewport into fixed-size tiles.
 *
 * Only dirty tiles are re-rendered. Tiles outside the viewport are
 * evicted after a configurable age to free GPU memory.
 */

export interface TileManager {
  /** Mark tiles overlapping a world-space rectangle as dirty */
  markDirtyRect(rect: Rect): void;
  /** Get tiles visible in the current viewport */
  visibleTiles(cameraX: number, cameraY: number, zoom: number, viewportW: number, viewportH: number): RenderTile[];
  /** Evict tiles not accessed for `maxAge` frames */
  evict(maxAgeFrames: number): void;
  /** Reset all tiles */
  reset(): void;
}

export const createTileManager = (tileSize: number): TileManager => {
  const tiles = new Map<number, RenderTile>();
  let frameCount = 0;

  const tileId = (tx: number, ty: number): number => tx * 65536 + ty;

  const allocate = (tx: number, ty: number): RenderTile => {
    const id = tileId(tx, ty);
    const existing = tiles.get(id);
    if (existing) return existing;
    const tile: RenderTile = {
      id,
      worldX: tx * tileSize,
      worldY: ty * tileSize,
      size: tileSize,
      dirty: true,
    };
    tiles.set(id, tile);
    return tile;
  };

  return {
    markDirtyRect(rect: Rect): void {
      const minTX = Math.floor(rect.x / tileSize);
      const minTY = Math.floor(rect.y / tileSize);
      const maxTX = Math.floor((rect.x + rect.width) / tileSize);
      const maxTY = Math.floor((rect.y + rect.height) / tileSize);
      for (let ty = minTY; ty <= maxTY; ty++) {
        for (let tx = minTX; tx <= maxTX; tx++) {
          const tile = tiles.get(tileId(tx, ty));
          if (tile) tile.dirty = true;
        }
      }
    },

    visibleTiles(cameraX, cameraY, zoom, viewportW, viewportH): RenderTile[] {
      frameCount++;
      const invZoom = 1 / zoom;
      const worldW = viewportW * invZoom;
      const worldH = viewportH * invZoom;
      const worldX = -cameraX * invZoom;
      const worldY = -cameraY * invZoom;

      const minTX = Math.floor(worldX / tileSize) - 1;
      const minTY = Math.floor(worldY / tileSize) - 1;
      const maxTX = Math.ceil((worldX + worldW) / tileSize) + 1;
      const maxTY = Math.ceil((worldY + worldH) / tileSize) + 1;

      const result: RenderTile[] = [];
      for (let ty = minTY; ty <= maxTY; ty++) {
        for (let tx = minTX; tx <= maxTX; tx++) {
          result.push(allocate(tx, ty));
        }
      }
      return result;
    },

    evict(maxAgeFrames: number): void {
      for (const [id, tile] of tiles) {
        // Stub: track lastAccessFrame per tile
        void id;
        void tile;
      }
      void maxAgeFrames;
    },

    reset(): void {
      tiles.clear();
      frameCount = 0;
    },
  };
};
