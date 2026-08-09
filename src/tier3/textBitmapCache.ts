import type { Color, Rect } from "../types.js";

interface TextBitmap {
  source: ImageBitmap;
  destination: Rect;
}

export interface TextBitmapCache {
  get(text: string, font: string, x: number, y: number, color: Color): TextBitmap | null;
  sweep(): void;
  destroy(): void;
}

const colorKey = (color: Color): string => color.map((value) => value.toFixed(4)).join(",");

const colorCSS = (color: Color): string => {
  const [red, green, blue, alpha] = color;
  return `rgba(${Math.round(red * 255)},${Math.round(green * 255)},${Math.round(blue * 255)},${alpha})`;
};

export const createTextBitmapCache = (
  limit = 128,
  onEvict: (source: ImageBitmap) => void = () => undefined,
): TextBitmapCache => {
  const cache = new Map<string, { source: ImageBitmap; width: number; height: number }>();

  const evictOldest = (): void => {
    while (cache.size > limit) {
      const oldest = cache.entries().next().value as [string, { source: ImageBitmap }] | undefined;
      if (!oldest) return;
      onEvict(oldest[1].source);
      oldest[1].source.close();
      cache.delete(oldest[0]);
    }
  };

  return {
    get(text, requestedFont, x, y, color) {
      if (!text || typeof OffscreenCanvas === "undefined") return null;
      const font = requestedFont || "14px sans-serif";
      const key = `${font}\u0000${colorKey(color)}\u0000${text}`;
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return { source: cached.source, destination: { x: x - 2, y: y - 2, width: cached.width, height: cached.height } };
      }

      const measureCanvas = new OffscreenCanvas(1, 1);
      const measure = measureCanvas.getContext("2d");
      if (!measure) return null;
      measure.font = font;
      const metrics = measure.measureText(text);
      const fontPixels = Number.parseFloat(font) || 14;
      const width = Math.max(1, Math.ceil(metrics.width + 4));
      const height = Math.max(1, Math.ceil(
        (metrics.actualBoundingBoxAscent || fontPixels) +
        (metrics.actualBoundingBoxDescent || fontPixels * 0.3) + 4,
      ));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.clearRect(0, 0, width, height);
      context.font = font;
      context.fillStyle = colorCSS(color);
      context.textBaseline = "top";
      context.fillText(text, 2, 2);
      const source = canvas.transferToImageBitmap();
      cache.set(key, { source, width, height });
      return { source, destination: { x: x - 2, y: y - 2, width, height } };
    },
    sweep() {
      evictOldest();
    },
    destroy() {
      for (const item of cache.values()) {
        onEvict(item.source);
        item.source.close();
      }
      cache.clear();
    },
  };
};
