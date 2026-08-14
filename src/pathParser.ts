import type { Vec2 } from "./types.js";

export type PathSegment =
  | { cmd: "M"; x: number; y: number }
  | { cmd: "L"; x: number; y: number }
  | { cmd: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { cmd: "Q"; x1: number; y1: number; x: number; y: number }
  | { cmd: "A"; rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; x: number; y: number }
  | { cmd: "Z" };

export interface PathContour {
  closed: boolean;
  points: Vec2[];
}

const tokenPattern = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const isCommand = (token: string | undefined): boolean => Boolean(token && /^[a-zA-Z]$/.test(token));
const parameterCount: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };

/**
 * Parse SVG path data and normalize relative, shorthand, horizontal and
 * vertical commands into absolute segments. Invalid trailing data is ignored.
 */
export const parsePath = (d: string): PathSegment[] => {
  const tokens = d.match(tokenPattern) ?? [];
  const segments: PathSegment[] = [];
  let index = 0;
  let active = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let previousCubicControl: Vec2 | null = null;
  let previousQuadControl: Vec2 | null = null;

  const numberAt = (offset: number): number | null => {
    const token = tokens[index + offset];
    if (token === undefined || isCommand(token)) return null;
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
  };
  const absolute = (value: number, origin: number, relative: boolean): number => relative ? origin + value : value;
  const resetControls = (): void => {
    previousCubicControl = null;
    previousQuadControl = null;
  };

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (isCommand(token)) {
      active = token;
      index++;
      if (active.toUpperCase() === "Z") {
        segments.push({ cmd: "Z" });
        x = startX;
        y = startY;
        resetControls();
        active = "";
      }
      continue;
    }
    if (!active) {
      index++;
      continue;
    }

    const upper = active.toUpperCase();
    const count = parameterCount[upper];
    if (!count || index + count > tokens.length) break;
    const values: number[] = [];
    for (let offset = 0; offset < count; offset++) {
      const value = numberAt(offset);
      if (value === null) break;
      values.push(value);
    }
    if (values.length !== count) {
      active = "";
      continue;
    }
    index += count;
    const relative = active === active.toLowerCase();

    switch (upper) {
      case "M": {
        x = absolute(values[0]!, x, relative);
        y = absolute(values[1]!, y, relative);
        startX = x;
        startY = y;
        segments.push({ cmd: "M", x, y });
        active = relative ? "l" : "L";
        resetControls();
        break;
      }
      case "L": {
        x = absolute(values[0]!, x, relative);
        y = absolute(values[1]!, y, relative);
        segments.push({ cmd: "L", x, y });
        resetControls();
        break;
      }
      case "H": {
        x = absolute(values[0]!, x, relative);
        segments.push({ cmd: "L", x, y });
        resetControls();
        break;
      }
      case "V": {
        y = absolute(values[0]!, y, relative);
        segments.push({ cmd: "L", x, y });
        resetControls();
        break;
      }
      case "C": {
        const x1 = absolute(values[0]!, x, relative);
        const y1 = absolute(values[1]!, y, relative);
        const x2 = absolute(values[2]!, x, relative);
        const y2 = absolute(values[3]!, y, relative);
        x = absolute(values[4]!, x, relative);
        y = absolute(values[5]!, y, relative);
        segments.push({ cmd: "C", x1, y1, x2, y2, x, y });
        previousCubicControl = { x: x2, y: y2 };
        previousQuadControl = null;
        break;
      }
      case "S": {
        const reflected: Vec2 = previousCubicControl ? { x: x * 2 - previousCubicControl.x, y: y * 2 - previousCubicControl.y } : { x, y };
        const x2 = absolute(values[0]!, x, relative);
        const y2 = absolute(values[1]!, y, relative);
        x = absolute(values[2]!, x, relative);
        y = absolute(values[3]!, y, relative);
        segments.push({ cmd: "C", x1: reflected.x, y1: reflected.y, x2, y2, x, y });
        previousCubicControl = { x: x2, y: y2 };
        previousQuadControl = null;
        break;
      }
      case "Q": {
        const x1 = absolute(values[0]!, x, relative);
        const y1 = absolute(values[1]!, y, relative);
        x = absolute(values[2]!, x, relative);
        y = absolute(values[3]!, y, relative);
        segments.push({ cmd: "Q", x1, y1, x, y });
        previousQuadControl = { x: x1, y: y1 };
        previousCubicControl = null;
        break;
      }
      case "T": {
        const reflected: Vec2 = previousQuadControl ? { x: x * 2 - previousQuadControl.x, y: y * 2 - previousQuadControl.y } : { x, y };
        x = absolute(values[0]!, x, relative);
        y = absolute(values[1]!, y, relative);
        segments.push({ cmd: "Q", x1: reflected.x, y1: reflected.y, x, y });
        previousQuadControl = reflected;
        previousCubicControl = null;
        break;
      }
      case "A": {
        const endX = absolute(values[5]!, x, relative);
        const endY = absolute(values[6]!, y, relative);
        segments.push({
          cmd: "A",
          rx: Math.abs(values[0]!),
          ry: Math.abs(values[1]!),
          rotation: values[2]!,
          largeArc: values[3] !== 0,
          sweep: values[4] !== 0,
          x: endX,
          y: endY,
        });
        x = endX;
        y = endY;
        resetControls();
        break;
      }
    }
  }
  return segments;
};

const cubicBezier = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const quadBezier = (t: number, p0: number, p1: number, p2: number): number => {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
};

const vectorAngle = (ux: number, uy: number, vx: number, vy: number): number =>
  Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);

const tessellateArc = (from: Vec2, segment: Extract<PathSegment, { cmd: "A" }>, resolution: number): Vec2[] => {
  if (segment.rx === 0 || segment.ry === 0 || (from.x === segment.x && from.y === segment.y)) {
    return [{ x: segment.x, y: segment.y }];
  }
  const phi = segment.rotation * Math.PI / 180;
  const cosine = Math.cos(phi);
  const sine = Math.sin(phi);
  const dx = (from.x - segment.x) * 0.5;
  const dy = (from.y - segment.y) * 0.5;
  const transformedX = cosine * dx + sine * dy;
  const transformedY = -sine * dx + cosine * dy;
  let rx = segment.rx;
  let ry = segment.ry;
  const scale = transformedX ** 2 / rx ** 2 + transformedY ** 2 / ry ** 2;
  if (scale > 1) {
    const root = Math.sqrt(scale);
    rx *= root;
    ry *= root;
  }
  const numerator = Math.max(0, rx ** 2 * ry ** 2 - rx ** 2 * transformedY ** 2 - ry ** 2 * transformedX ** 2);
  const denominator = rx ** 2 * transformedY ** 2 + ry ** 2 * transformedX ** 2;
  const direction = segment.largeArc === segment.sweep ? -1 : 1;
  const coefficient = denominator === 0 ? 0 : direction * Math.sqrt(numerator / denominator);
  const centerPrimeX = coefficient * (rx * transformedY / ry);
  const centerPrimeY = coefficient * (-ry * transformedX / rx);
  const centerX = cosine * centerPrimeX - sine * centerPrimeY + (from.x + segment.x) * 0.5;
  const centerY = sine * centerPrimeX + cosine * centerPrimeY + (from.y + segment.y) * 0.5;
  const startX = (transformedX - centerPrimeX) / rx;
  const startY = (transformedY - centerPrimeY) / ry;
  const endX = (-transformedX - centerPrimeX) / rx;
  const endY = (-transformedY - centerPrimeY) / ry;
  const startAngle = vectorAngle(1, 0, startX, startY);
  let delta = vectorAngle(startX, startY, endX, endY);
  if (!segment.sweep && delta > 0) delta -= Math.PI * 2;
  if (segment.sweep && delta < 0) delta += Math.PI * 2;
  const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI * 2) * resolution * 4));
  const points: Vec2[] = [];
  for (let step = 1; step <= steps; step++) {
    const angle = startAngle + delta * step / steps;
    const arcX = rx * Math.cos(angle);
    const arcY = ry * Math.sin(angle);
    points.push({
      x: cosine * arcX - sine * arcY + centerX,
      y: sine * arcX + cosine * arcY + centerY,
    });
  }
  return points;
};

/** Tessellate normalized SVG segments while preserving open/closed subpaths. */
export const tessellatePathContours = (segments: readonly PathSegment[], resolution = 16): PathContour[] => {
  const contours: PathContour[] = [];
  let points: Vec2[] = [];
  let closed = false;
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  const steps = Math.max(2, Math.min(256, Math.round(resolution)));
  const flush = (): void => {
    if (points.length > 0) contours.push({ closed, points });
    points = [];
    closed = false;
  };

  for (const segment of segments) {
    switch (segment.cmd) {
      case "M":
        flush();
        current = { x: segment.x, y: segment.y };
        start = current;
        points.push(current);
        break;
      case "L":
        current = { x: segment.x, y: segment.y };
        points.push(current);
        break;
      case "C": {
        const from = current;
        for (let step = 1; step <= steps; step++) {
          const t = step / steps;
          current = {
            x: cubicBezier(t, from.x, segment.x1, segment.x2, segment.x),
            y: cubicBezier(t, from.y, segment.y1, segment.y2, segment.y),
          };
          points.push(current);
        }
        break;
      }
      case "Q": {
        const from = current;
        for (let step = 1; step <= steps; step++) {
          const t = step / steps;
          current = {
            x: quadBezier(t, from.x, segment.x1, segment.x),
            y: quadBezier(t, from.y, segment.y1, segment.y),
          };
          points.push(current);
        }
        break;
      }
      case "A":
        points.push(...tessellateArc(current, segment, steps));
        current = { x: segment.x, y: segment.y };
        break;
      case "Z":
        if (points.length > 0 && (current.x !== start.x || current.y !== start.y)) points.push(start);
        current = start;
        closed = true;
        break;
    }
  }
  flush();
  return contours;
};

/** Backwards-compatible polyline view of tessellated path contours. */
export const tessellatePath = (segments: readonly PathSegment[], resolution = 16): Vec2[][] =>
  tessellatePathContours(segments, resolution).map((contour) => contour.points);

export const circlePoints = (cx: number, cy: number, radius: number, segments = 32): Vec2[] => {
  const points: Vec2[] = [];
  for (let index = 0; index < segments; index++) {
    const angle = Math.PI * 2 * index / segments;
    points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return points;
};

export const ellipsePoints = (cx: number, cy: number, rx: number, ry: number, segments = 32): Vec2[] => {
  const points: Vec2[] = [];
  for (let index = 0; index < segments; index++) {
    const angle = Math.PI * 2 * index / segments;
    points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  }
  return points;
};
