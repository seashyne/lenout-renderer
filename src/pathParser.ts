// ---------------------------------------------------------------------------
// SVG Path Parser — parses path `d` attribute into segment lists and
// tessellates curves into flat polyline approximations.
// ---------------------------------------------------------------------------

import type { Vec2 } from "./types.js";

export type PathSegment =
  | { cmd: "M"; x: number; y: number }
  | { cmd: "L"; x: number; y: number }
  | { cmd: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { cmd: "Q"; x1: number; y1: number; x: number; y: number }
  | { cmd: "Z" };

/** Parse SVG path `d` string into an array of segments */
export const parsePath = (d: string): PathSegment[] => {
  const segments: PathSegment[] = [];
  // Tokenize: split on commas/whitespace, keep command letters
  const tokens = d
    .replace(/([MLCQZ])/gi, " $1 ")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);

  let i = 0;
  let curX = 0;
  let curY = 0;

  while (i < tokens.length) {
    const raw = tokens[i]!;
    const cmd = raw.toUpperCase();
    i++;

    switch (cmd) {
      case "M": {
        const x = parseFloat(tokens[i++]!);
        const y = parseFloat(tokens[i++]!);
        const isRel = raw === "m";
        curX = isRel ? curX + x : x;
        curY = isRel ? curY + y : y;
        segments.push({ cmd: "M", x: curX, y: curY });
        // Implicit L if more coords follow
        while (i < tokens.length && !/[MLCQZ]/i.test(tokens[i]!)) {
          const lx = parseFloat(tokens[i++]!);
          const ly = parseFloat(tokens[i++]!);
          curX = isRel ? curX + lx : lx;
          curY = isRel ? curY + ly : ly;
          segments.push({ cmd: "L", x: curX, y: curY });
        }
        break;
      }
      case "L": {
        do {
          const x = parseFloat(tokens[i++]!);
          const y = parseFloat(tokens[i++]!);
          const isRel = raw === "l";
          curX = isRel ? curX + x : x;
          curY = isRel ? curY + y : y;
          segments.push({ cmd: "L", x: curX, y: curY });
        } while (i < tokens.length && !/[MLCQZ]/i.test(tokens[i]!));
        break;
      }
      case "C": {
        do {
          const x1 = parseFloat(tokens[i++]!);
          const y1 = parseFloat(tokens[i++]!);
          const x2 = parseFloat(tokens[i++]!);
          const y2 = parseFloat(tokens[i++]!);
          const x = parseFloat(tokens[i++]!);
          const y = parseFloat(tokens[i++]!);
          const isRel = raw === "c";
          if (isRel) {
            curX += x; curY += y;
            segments.push({ cmd: "C", x1: curX - x + x1, y1: curY - y + y1, x2: curX - x + x2, y2: curY - y + y2, x: curX, y: curY });
          } else {
            curX = x; curY = y;
            segments.push({ cmd: "C", x1, y1, x2, y2, x: curX, y: curY });
          }
        } while (i < tokens.length && !/[MLCQZ]/i.test(tokens[i]!));
        break;
      }
      case "Q": {
        do {
          const x1 = parseFloat(tokens[i++]!);
          const y1 = parseFloat(tokens[i++]!);
          const x = parseFloat(tokens[i++]!);
          const y = parseFloat(tokens[i++]!);
          const isRel = raw === "q";
          if (isRel) {
            curX += x; curY += y;
            segments.push({ cmd: "Q", x1: curX - x + x1, y1: curY - y + y1, x: curX, y: curY });
          } else {
            curX = x; curY = y;
            segments.push({ cmd: "Q", x1, y1, x: curX, y: curY });
          }
        } while (i < tokens.length && !/[MLCQZ]/i.test(tokens[i]!));
        break;
      }
      case "Z": {
        segments.push({ cmd: "Z" });
        break;
      }
    }
  }

  return segments;
};

/** Evaluate cubic bezier at parameter t (0–1) */
const cubicBezier = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** Evaluate quadratic bezier at parameter t */
const quadBezier = (t: number, p0: number, p1: number, p2: number): number => {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
};

/**
 * Tessellate path segments into flat points.
 * Curves are approximated with `segmentsPerCurve` line segments.
 * Returns array of polylines (sub-paths separated by M/Z commands).
 */
export const tessellatePath = (
  segments: PathSegment[],
  segmentsPerCurve: number = 16,
): Vec2[][] => {
  const polylines: Vec2[][] = [];
  let current: Vec2[] = [];
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;

  for (const seg of segments) {
    switch (seg.cmd) {
      case "M": {
        if (current.length > 0) polylines.push(current);
        current = [];
        curX = seg.x;
        curY = seg.y;
        startX = curX;
        startY = curY;
        current.push({ x: curX, y: curY });
        break;
      }
      case "L": {
        curX = seg.x;
        curY = seg.y;
        current.push({ x: curX, y: curY });
        break;
      }
      case "C": {
        const fromX = curX, fromY = curY;
        for (let i = 1; i <= segmentsPerCurve; i++) {
          const t = i / segmentsPerCurve;
          curX = cubicBezier(t, fromX, seg.x1, seg.x2, seg.x);
          curY = cubicBezier(t, fromY, seg.y1, seg.y2, seg.y);
          current.push({ x: curX, y: curY });
        }
        break;
      }
      case "Q": {
        const fromX = curX, fromY = curY;
        for (let i = 1; i <= segmentsPerCurve; i++) {
          const t = i / segmentsPerCurve;
          curX = quadBezier(t, fromX, seg.x1, seg.x);
          curY = quadBezier(t, fromY, seg.y1, seg.y);
          current.push({ x: curX, y: curY });
        }
        break;
      }
      case "Z": {
        if (current.length > 0) {
          current.push({ x: startX, y: startY });
        }
        curX = startX;
        curY = startY;
        break;
      }
    }
  }

  if (current.length > 0) polylines.push(current);
  return polylines;
};

/** Generate circle points (for tessellation into triangle fan) */
export const circlePoints = (cx: number, cy: number, radius: number, segments: number = 32): Vec2[] => {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (Math.PI * 2 * i) / segments;
    pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  }
  return pts;
};

/** Generate ellipse points */
export const ellipsePoints = (cx: number, cy: number, rx: number, ry: number, segments: number = 32): Vec2[] => {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (Math.PI * 2 * i) / segments;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
};
