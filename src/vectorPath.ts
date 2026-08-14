import { parsePath, tessellatePathContours, type PathContour, type PathSegment } from "./pathParser.js";
import type { Rect } from "./types.js";

export interface VectorPath {
  bounds: Rect | null;
  contours: readonly PathContour[];
  segments: readonly PathSegment[];
}

export interface VectorPathCache {
  get(d: string, resolution?: number): VectorPath;
  clear(): void;
  readonly size: number;
}

const contourBounds = (contours: readonly PathContour[]): Rect | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { points } of contours) {
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
};

/** Bounded LRU cache prevents parsing and tessellating the same path per tile. */
export const createVectorPathCache = (limit = 512): VectorPathCache => {
  const entries = new Map<string, VectorPath>();
  const safeLimit = Math.max(1, Math.floor(limit));
  return {
    get(d, requestedResolution = 20) {
      const resolution = Math.max(2, Math.min(256, Math.round(requestedResolution)));
      const key = `${resolution}\u0000${d}`;
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }
      const segments = parsePath(d);
      const contours = tessellatePathContours(segments, resolution);
      const path = { bounds: contourBounds(contours), contours, segments };
      entries.set(key, path);
      while (entries.size > safeLimit) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return path;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
};

export const sharedVectorPathCache = createVectorPathCache();
