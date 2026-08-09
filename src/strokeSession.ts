// ---------------------------------------------------------------------------
// Stroke Session — collects pointer input and converts to BrushDab arrays.
//
// Each pointer-down begins a session. Pointer-move events are accumulated
// and converted into dab positions (with optional pressure/spacing).
// Pointer-up finalises the stroke and returns the dab array.
//
// Supports Catmull-Rom spline smoothing for natural-looking curves.
// ---------------------------------------------------------------------------

import type { BrushDab, Color } from "./types.js";

export interface StrokePoint {
  x: number;
  y: number;
  /** Normalised pressure 0–1 (from PointerEvent) */
  pressure: number;
  /** Time in ms (for velocity calculation) */
  time: number;
}

export interface StrokeConfig {
  /** Base brush size in pixels */
  size: number;
  /** Brush hardness 0–1 (0 = soft, 1 = hard) */
  hardness: number;
  /** RGBA color tuple */
  color: Color;
  /** Maximum spacing between dabs in pixels (lower = denser stroke) */
  spacing: number;
  /** Whether to use pressure for size modulation */
  pressureSize: boolean;
  /** Whether to use pressure for opacity modulation */
  pressureOpacity: boolean;
  /** Smoothing factor 0–1 (0 = raw linear, 1 = full Catmull-Rom) */
  smoothing: number;
}

const DEFAULT_CONFIG: StrokeConfig = {
  size: 20,
  hardness: 0.5,
  color: [1, 1, 1, 1],
  spacing: 3,
  pressureSize: true,
  pressureOpacity: false,
  smoothing: 0.5,
};

export interface StrokeSession {
  begin(point: StrokePoint): void;
  move(point: StrokePoint): BrushDab[];
  end(): BrushDab[];
  cancel(): void;
  config: StrokeConfig;
}

// ---------------------------------------------------------------------------
// Catmull-Rom spline
// ---------------------------------------------------------------------------

/** Evaluate Catmull-Rom at parameter t (0–1) between p1 and p2, with tangents from p0,p3 */
const catmullRom = (
  t: number,
  p0: number, p1: number, p2: number, p3: number,
): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
};

/** Evaluate Catmull-Rom for a 2D point with pressure */
const catmullRomPoint = (
  t: number,
  p0: StrokePoint, p1: StrokePoint, p2: StrokePoint, p3: StrokePoint,
): { x: number; y: number; pressure: number } => ({
  x: catmullRom(t, p0.x, p1.x, p2.x, p3.x),
  y: catmullRom(t, p0.y, p1.y, p2.y, p3.y),
  pressure: catmullRom(t, p0.pressure, p1.pressure, p2.pressure, p3.pressure),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createStrokeSession = (config: Partial<StrokeConfig> = {}): StrokeSession => {
  const cfg: StrokeConfig = { ...DEFAULT_CONFIG, ...config };
  let points: StrokePoint[] = [];
  /** Index of the last point whose segment was fully emitted */
  let emittedIdx = -1;

  /** Create a BrushDab at a computed position */
  const makeDab = (x: number, y: number, pressure: number): BrushDab => ({
    x,
    y,
    size: cfg.pressureSize ? cfg.size * (0.3 + pressure * 0.7) : cfg.size,
    hardness: cfg.hardness,
    opacity: cfg.pressureOpacity ? 0.3 + pressure * 0.7 : 1,
    color: [...cfg.color] as Color,
    rotation: 0,
  });

  /** Generate dabs along a straight line between two points */
  const linearDabs = (from: StrokePoint, to: StrokePoint): BrushDab[] => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.5) return [];

    const steps = Math.max(1, Math.ceil(dist / cfg.spacing));
    const dabs: BrushDab[] = [];
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      dabs.push(makeDab(
        from.x + dx * t,
        from.y + dy * t,
        from.pressure + (to.pressure - from.pressure) * t,
      ));
    }
    return dabs;
  };

  /** Generate dabs along a Catmull-Rom curve between p1 and p2 */
  const smoothDabs = (
    p0: StrokePoint, p1: StrokePoint, p2: StrokePoint, p3: StrokePoint,
  ): BrushDab[] => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return [];

    const steps = Math.max(1, Math.ceil(dist / cfg.spacing));
    const dabs: BrushDab[] = [];
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const pt = catmullRomPoint(t, p0, p1, p2, p3);
      dabs.push(makeDab(pt.x, pt.y, pt.pressure));
    }
    return dabs;
  };

  return {
    config: cfg,

    begin(point: StrokePoint): void {
      points = [point];
      emittedIdx = -1;
    },

    move(point: StrokePoint): BrushDab[] {
      points.push(point);
      if (points.length < 2) return [];

      // Determine the segment to emit
      const useSmooth = cfg.smoothing > 0 && points.length >= 4;
      let allDabs: BrushDab[] = [];

      if (useSmooth) {
        // Emit from points[length-4] to points[length-3] using 4-point window
        const segStart = points.length - 4;
        if (emittedIdx < segStart + 1) {
          const p0 = points[segStart]!;
          const p1 = points[segStart + 1]!;
          const p2 = points[segStart + 2]!;
          const p3 = points[segStart + 3]!;
          allDabs = smoothDabs(p0, p1, p2, p3);
          emittedIdx = segStart + 1;
        }
      } else {
        // Linear: emit from previous point to current
        const fromIdx = Math.max(emittedIdx, points.length - 2);
        for (let i = fromIdx; i < points.length - 1; i++) {
          const from = points[i]!;
          const to = points[i + 1]!;
          allDabs.push(...linearDabs(from, to));
          emittedIdx = i + 1;
        }
      }

      return allDabs;
    },

    end(): BrushDab[] {
      if (points.length === 0) return [];

      const dabs: BrushDab[] = [];

      // Emit any remaining un-emitted segments
      if (emittedIdx < points.length - 1) {
        if (cfg.smoothing > 0 && points.length >= 3) {
          // Emit the last smooth segment if we have enough points
          const n = points.length;
          // Use the last emitted point as p0, or duplicate p1
          const p0Idx = Math.max(0, emittedIdx - 1);
          const p1Idx = Math.max(emittedIdx, 0);
          if (n - p1Idx >= 2) {
            // At least 2 points remaining
            const p0 = points[p0Idx]!;
            const p1 = points[p1Idx]!;
            const p2 = points[Math.min(p1Idx + 1, n - 1)]!;
            const p3 = points[Math.min(p1Idx + 2, n - 1)]!;
            dabs.push(...smoothDabs(p0, p1, p2, p3));
          }
          // Remaining segments linear
          for (let i = p1Idx + 1; i < n - 1; i++) {
            dabs.push(...linearDabs(points[i]!, points[i + 1]!));
          }
        } else {
          for (let i = Math.max(emittedIdx, 0); i < points.length - 1; i++) {
            dabs.push(...linearDabs(points[i]!, points[i + 1]!));
          }
        }
      }

      // Final dab at last point
      const last = points[points.length - 1]!;
      dabs.push(makeDab(last.x, last.y, last.pressure));

      points = [];
      emittedIdx = -1;
      return dabs;
    },

    cancel(): void {
      points = [];
      emittedIdx = -1;
    },
  };
};
