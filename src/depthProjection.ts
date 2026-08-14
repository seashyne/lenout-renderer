import type { Rect, Vec2 } from "./types.js";

export interface DepthLayer2_5D {
  /** Positive values move away from the camera; negative values move forward. */
  depth: number;
  /** Camera-motion multiplier. Zero pins the layer to the viewport. */
  parallax: number;
}

export interface DepthView2_5D {
  cameraX: number;
  cameraY: number;
  /** Perspective strength per depth unit. Zero produces parallax-only motion. */
  perspective: number;
  viewportHeight: number;
  viewportWidth: number;
  zoom: number;
}

const finiteOr = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;

export const depthScale2_5D = (depth: number, perspective: number, zoom = 1): number => {
  const safeDepth = finiteOr(depth, 0);
  const safePerspective = Math.max(0, finiteOr(perspective, 0));
  const denominator = Math.max(0.1, 1 + safeDepth * safePerspective);
  return Math.max(0.01, finiteOr(zoom, 1)) / denominator;
};

/** Projects a world point into a 2D viewport using depth-aware scale and parallax. */
export const projectPoint2_5D = (
  point: Vec2,
  layer: DepthLayer2_5D,
  view: DepthView2_5D,
): Vec2 => {
  const centerX = finiteOr(view.viewportWidth, 0) / 2;
  const centerY = finiteOr(view.viewportHeight, 0) / 2;
  const scale = depthScale2_5D(layer.depth, view.perspective, view.zoom);
  const parallax = Math.max(0, finiteOr(layer.parallax, 1));
  return {
    x: centerX + (point.x - centerX) * scale - finiteOr(view.cameraX, 0) * parallax * scale,
    y: centerY + (point.y - centerY) * scale - finiteOr(view.cameraY, 0) * parallax * scale,
  };
};

export const projectRect2_5D = (
  rect: Rect,
  layer: DepthLayer2_5D,
  view: DepthView2_5D,
): Rect => {
  const origin = projectPoint2_5D({ x: rect.x, y: rect.y }, layer, view);
  const scale = depthScale2_5D(layer.depth, view.perspective, view.zoom);
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width * scale,
    height: rect.height * scale,
  };
};
