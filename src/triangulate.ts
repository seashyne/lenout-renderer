// ---------------------------------------------------------------------------
// Polygon Triangulation — converts polygon outlines to triangle lists.
//
// Uses fan triangulation for convex shapes (circles, ellipses, convex polys)
// and ear-clipping for simple polygons.
// ---------------------------------------------------------------------------

import type { Vec2 } from "./types.js";

/**
 * Fan triangulation: center point + ring of vertices.
 * Output: array of triangle indices [a,b,c, d,e,f, ...] (3 per triangle).
 */
export const fanTriangulate = (
  center: Vec2,
  ring: Vec2[],
  closeRing: boolean = true,
): number[] => {
  const indices: number[] = [];
  const all = [center, ...ring];
  if (closeRing) all.push(ring[0]!); // close the fan

  for (let i = 1; i < all.length - 1; i++) {
    indices.push(0, i, i + 1);
  }
  return indices;
};

/**
 * Simple polygon triangulation using ear-clipping.
 * Assumes simple (non-self-intersecting) polygon in CCW order.
 * Returns triangle indices into the vertices array (3 per triangle).
 */
export const earClipTriangulate = (vertices: Vec2[]): number[] => {
  if (vertices.length < 3) return [];
  if (vertices.length === 3) return [0, 1, 2];

  const indices: number[] = [];
  // Build working index array
  const remaining: number[] = vertices.map((_, i) => i);

  // Signed area to determine winding
  const signedArea = (a: number, b: number, c: number): number => {
    const va = vertices[a]!, vb = vertices[b]!, vc = vertices[c]!;
    return (vb.x - va.x) * (vc.y - va.y) - (vb.y - va.y) * (vc.x - va.x);
  };

  // Check if point p is inside triangle (a,b,c)
  const pointInTriangle = (p: number, a: number, b: number, c: number): boolean => {
    const vp = vertices[p]!, va = vertices[a]!, vb = vertices[b]!, vc = vertices[c]!;
    const d1 = (vb.x - va.x) * (vp.y - va.y) - (vb.y - va.y) * (vp.x - va.x);
    const d2 = (vc.x - vb.x) * (vp.y - vb.y) - (vc.y - vb.y) * (vp.x - vb.x);
    const d3 = (va.x - vc.x) * (vp.y - vc.y) - (va.y - vc.y) * (vp.x - vc.x);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  let safety = vertices.length * 3;
  while (remaining.length > 3 && safety-- > 0) {
    let earFound = false;
    for (let i = 0; i < remaining.length; i++) {
      const prev = remaining[(i - 1 + remaining.length) % remaining.length]!;
      const curr = remaining[i]!;
      const next = remaining[(i + 1) % remaining.length]!;

      // Check if triangle (prev, curr, next) is an ear (convex vertex)
      if (signedArea(prev, curr, next) <= 0) continue;

      // Check no other vertex lies inside this triangle
      let isEar = true;
      for (let j = 0; j < remaining.length; j++) {
        const p = remaining[j]!;
        if (p === prev || p === curr || p === next) continue;
        if (pointInTriangle(p, prev, curr, next)) {
          isEar = false;
          break;
        }
      }

      if (isEar) {
        indices.push(prev, curr, next);
        remaining.splice(i, 1);
        earFound = true;
        break;
      }
    }
    if (!earFound) break; // degenerate — fall back to fan
  }

  // Last 3 vertices form the final triangle
  if (remaining.length === 3) {
    indices.push(remaining[0]!, remaining[1]!, remaining[2]!);
  }

  return indices;
};

/** Triangulate a polygon (auto-selects fan vs ear-clip based on convexity) */
export const triangulate = (vertices: Vec2[]): number[] => {
  if (vertices.length < 3) return [];
  if (vertices.length === 3) return [0, 1, 2];

  // Use ear-clipping for general polygons
  return earClipTriangulate(vertices);
};

/**
 * Generate vertex positions for triangle rendering from vertices + indices.
 * Returns flat Float32Array: [x0,y0, x1,y1, x2,y2, ...]
 */
export const buildTriangleVertices = (
  vertices: Vec2[],
  indices: number[],
): Float32Array => {
  const out = new Float32Array(indices.length * 2);
  for (let i = 0; i < indices.length; i++) {
    const v = vertices[indices[i]!]!;
    out[i * 2] = v.x;
    out[i * 2 + 1] = v.y;
  }
  return out;
};
