import type { RenderTile, Rect } from "./types.js";

/**
 * Tile Manager — divides the viewport into fixed-size tiles.
 *
 * Coordinate lookup and eviction are independent: nested numeric maps avoid
 * coordinate-key collisions, while the insertion-ordered map is the LRU list.
 */

export interface TileManagerOptions {
  /** Maximum retained offscreen tiles. Visible tiles are never evicted mid-frame. */
  maxCachedTiles?: number;
  /** Number of tiles retained around the visible viewport. */
  overscanTiles?: number;
}

export interface TileManagerStats {
  cachedTileCount: number;
  frame: number;
  maxCachedTiles: number;
}

export interface TileManager {
  /** Mark cached tiles overlapping a half-open world-space rectangle as dirty. */
  markDirtyRect(rect: Rect): void;
  /** Get tiles visible in the current viewport. */
  visibleTiles(cameraX: number, cameraY: number, zoom: number, viewportW: number, viewportH: number): RenderTile[];
  /** Evict tiles not accessed for `maxAge` frames and enforce the cache bound. */
  evict(maxAgeFrames: number): void;
  /** Current cache diagnostics. */
  readonly stats: TileManagerStats;
  /** Reset all tiles. */
  reset(): void;
}

interface TileRecord {
  tile: RenderTile;
  tx: number;
  ty: number;
}

const finiteIntegerAtLeast = (value: number | undefined, fallback: number, minimum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
};

export const createTileManager = (
  tileSize: number,
  options: TileManagerOptions = {},
): TileManager => {
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new Error("Lenout Renderer: tile size must be a positive finite number");
  }

  const maxCachedTiles = finiteIntegerAtLeast(options.maxCachedTiles, 4096, 1);
  const overscanTiles = finiteIntegerAtLeast(options.overscanTiles, 1, 0);
  const rows = new Map<number, Map<number, TileRecord>>();
  const lru = new Map<number, TileRecord>();
  let frameCount = 0;
  let nextTileId = 1;

  const getRecord = (tx: number, ty: number): TileRecord | undefined => rows.get(tx)?.get(ty);

  const touch = (record: TileRecord): void => {
    record.tile.lastAccessFrame = frameCount;
    lru.delete(record.tile.id);
    lru.set(record.tile.id, record);
  };

  const remove = (record: TileRecord): void => {
    const row = rows.get(record.tx);
    row?.delete(record.ty);
    if (row?.size === 0) rows.delete(record.tx);
    lru.delete(record.tile.id);
  };

  const allocate = (tx: number, ty: number): RenderTile => {
    const existing = getRecord(tx, ty);
    if (existing) {
      touch(existing);
      return existing.tile;
    }

    const tile: RenderTile = {
      id: nextTileId++,
      worldX: tx * tileSize,
      worldY: ty * tileSize,
      size: tileSize,
      dirty: true,
      lastAccessFrame: frameCount,
    };
    const record = { tile, tx, ty };
    const row = rows.get(tx) ?? new Map<number, TileRecord>();
    row.set(ty, record);
    rows.set(tx, row);
    lru.set(tile.id, record);
    return tile;
  };

  const dirtyRecord = (record: TileRecord): void => {
    record.tile.dirty = true;
  };

  const tileRange = (start: number, extent: number): [number, number] => {
    const end = start + extent;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    const min = Math.floor(low / tileSize);
    // Rectangles are half-open, so an edge exactly on a tile boundary does not
    // invalidate the adjacent tile. Zero-area bounds still address one tile.
    const max = high === low ? min : Math.ceil(high / tileSize) - 1;
    return [min, max];
  };

  return {
    markDirtyRect(rect): void {
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
      const [minTX, maxTX] = tileRange(rect.x, rect.width);
      const [minTY, maxTY] = tileRange(rect.y, rect.height);
      const columnCount = maxTX - minTX + 1;
      const rowCount = maxTY - minTY + 1;
      const coordinateCount = columnCount * rowCount;

      // Small invalidations use direct lookup. Very large bounds scan only the
      // retained cache, preventing an accidental billion-pixel rect from
      // turning into millions of empty map probes.
      if (Number.isSafeInteger(coordinateCount) && coordinateCount <= lru.size) {
        for (let tx = minTX; tx <= maxTX; tx++) {
          const row = rows.get(tx);
          if (!row) continue;
          for (let ty = minTY; ty <= maxTY; ty++) {
            const record = row.get(ty);
            if (record) dirtyRecord(record);
          }
        }
        return;
      }

      for (const record of lru.values()) {
        if (record.tx >= minTX && record.tx <= maxTX && record.ty >= minTY && record.ty <= maxTY) {
          dirtyRecord(record);
        }
      }
    },

    visibleTiles(cameraX, cameraY, zoom, viewportW, viewportH): RenderTile[] {
      frameCount++;
      if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(viewportW) || !Number.isFinite(viewportH)) {
        return [];
      }
      const invZoom = 1 / zoom;
      const worldW = Math.max(0, viewportW) * invZoom;
      const worldH = Math.max(0, viewportH) * invZoom;
      const worldX = -cameraX * invZoom;
      const worldY = -cameraY * invZoom;

      const minTX = Math.floor(worldX / tileSize) - overscanTiles;
      const minTY = Math.floor(worldY / tileSize) - overscanTiles;
      const maxTX = (worldW === 0
        ? Math.floor(worldX / tileSize)
        : Math.ceil((worldX + worldW) / tileSize) - 1) + overscanTiles;
      const maxTY = (worldH === 0
        ? Math.floor(worldY / tileSize)
        : Math.ceil((worldY + worldH) / tileSize) - 1) + overscanTiles;

      const result: RenderTile[] = [];
      for (let ty = minTY; ty <= maxTY; ty++) {
        for (let tx = minTX; tx <= maxTX; tx++) result.push(allocate(tx, ty));
      }
      return result;
    },

    evict(maxAgeFrames): void {
      const age = finiteIntegerAtLeast(maxAgeFrames, 0, 0);
      const oldestAllowedFrame = frameCount - age;
      for (const record of lru.values()) {
        if (record.tile.lastAccessFrame >= oldestAllowedFrame) break;
        remove(record);
      }

      if (lru.size <= maxCachedTiles) return;
      for (const record of lru.values()) {
        // A viewport may legitimately exceed the configured cache bound.
        if (lru.size <= maxCachedTiles || record.tile.lastAccessFrame === frameCount) break;
        remove(record);
      }
    },

    get stats() {
      return { cachedTileCount: lru.size, frame: frameCount, maxCachedTiles };
    },

    reset(): void {
      rows.clear();
      lru.clear();
      frameCount = 0;
      nextTileId = 1;
    },
  };
};
