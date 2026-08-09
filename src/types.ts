// ---------------------------------------------------------------------------
// Types shared across all renderer tiers
// ---------------------------------------------------------------------------

/** 2D point */
export interface Vec2 {
  x: number;
  y: number;
}

/** 2D axis-aligned rectangle in world space */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 3-component color (R, G, B, A) */
export type Color = [number, number, number, number];

/** Stroke style for vector shapes */
export interface StrokeStyle {
  color: Color;
  width: number;
}

/** A render command — what to draw on a tile */
export type RenderCommand =
  | { type: "clear"; color: Color }
  | { type: "image"; src: ImageBitmap; dst: Rect; opacity: number }
  | { type: "rect"; dst: Rect; fill: Color; radius: number }
  | { type: "circle"; cx: number; cy: number; radius: number; fill: Color; stroke?: StrokeStyle }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill: Color; stroke?: StrokeStyle }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; color: Color; width: number }
  | { type: "polygon"; points: Vec2[]; fill: Color; stroke?: StrokeStyle }
  | { type: "path"; d: string; fill: Color; stroke?: StrokeStyle }
  | { type: "brushDabs"; dabs: BrushDab[] }
  | { type: "text"; text: string; font: string; x: number; y: number; color: Color };

/** A single brush dab — GPU or CPU will process these */
export interface BrushDab {
  x: number;
  y: number;
  size: number;
  hardness: number;
  opacity: number;
  color: Color;
  rotation: number;
}

/** A 256×256 (or 128×128 on CPU tier) render tile */
export interface RenderTile {
  id: number;
  worldX: number;
  worldY: number;
  size: number;
  dirty: boolean;
  /** Frame count when this tile was last accessed (for eviction) */
  lastAccessFrame: number;
}
