import { layoutText } from "../textLayout.js";
import type { Color, Rect, TextCommand } from "../types.js";

interface TextBitmap {
  destination: Rect;
  source: ImageBitmap;
}

interface CachedTextBitmap {
  height: number;
  offsetX: number;
  offsetY: number;
  source: ImageBitmap;
  width: number;
}

export interface TextBitmapCache {
  get(command: TextCommand): TextBitmap | null;
  sweep(): void;
  destroy(): void;
}

const colorKey = (color: Color): string => color.map((value) => value.toFixed(4)).join(",");
const colorCSS = ([red, green, blue, alpha]: Color): string =>
  `rgba(${Math.round(red * 255)},${Math.round(green * 255)},${Math.round(blue * 255)},${alpha})`;

const cacheKey = (command: TextCommand, ratio: number): string => [
  ratio.toFixed(3),
  command.font,
  colorKey(command.color),
  command.text,
  command.maxWidth ?? "",
  command.lineHeight ?? "",
  command.letterSpacing ?? "",
  command.align ?? "",
  command.baseline ?? "",
  command.direction ?? "",
].join("\u0000");

export const createTextBitmapCache = (
  limit = 128,
  onEvict: (source: ImageBitmap) => void = () => undefined,
  pixelRatio: () => number = () => 1,
): TextBitmapCache => {
  const cache = new Map<string, CachedTextBitmap>();
  let measureCanvas: OffscreenCanvas | undefined;

  const evictOldest = (): void => {
    while (cache.size > limit) {
      const oldest = cache.entries().next().value as [string, CachedTextBitmap] | undefined;
      if (!oldest) return;
      onEvict(oldest[1].source);
      oldest[1].source.close();
      cache.delete(oldest[0]);
    }
  };

  return {
    get(command) {
      if (!command.text || typeof OffscreenCanvas === "undefined") return null;
      const font = command.font || "14px sans-serif";
      const ratio = Math.max(0.5, pixelRatio());
      const key = cacheKey({ ...command, font }, ratio);
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return {
          source: cached.source,
          destination: {
            x: command.x + cached.offsetX,
            y: command.y + cached.offsetY,
            width: cached.width,
            height: cached.height,
          },
        };
      }

      measureCanvas ??= new OffscreenCanvas(1, 1);
      const measure = measureCanvas.getContext("2d");
      if (!measure) return null;
      measure.font = font;
      const normalized: TextCommand = { ...command, font, x: 0, y: 0 };
      const layout = layoutText(normalized, (text, requestedFont) => {
        measure.font = requestedFont;
        return measure.measureText(text);
      });
      const padding = 2;
      const width = Math.max(1, Math.ceil(layout.bounds.width + padding * 2));
      const height = Math.max(1, Math.ceil(layout.bounds.height + padding * 2));
      const canvas = new OffscreenCanvas(Math.ceil(width * ratio), Math.ceil(height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.font = font;
      context.fillStyle = colorCSS(command.color);
      context.textBaseline = "top";
      context.textAlign = "left";
      context.direction = command.direction === "rtl" ? "rtl" : "ltr";
      const spacingContext = context as OffscreenCanvasRenderingContext2D & { letterSpacing?: string };
      if (spacingContext.letterSpacing !== undefined) spacingContext.letterSpacing = `${command.letterSpacing ?? 0}px`;
      for (const line of layout.lines) {
        context.fillText(
          line.text,
          line.x - layout.bounds.x + padding,
          line.y - layout.bounds.y + padding,
        );
      }
      const source = canvas.transferToImageBitmap();
      const entry: CachedTextBitmap = {
        source,
        width,
        height,
        offsetX: layout.bounds.x - padding,
        offsetY: layout.bounds.y - padding,
      };
      cache.set(key, entry);
      return {
        source,
        destination: {
          x: command.x + entry.offsetX,
          y: command.y + entry.offsetY,
          width,
          height,
        },
      };
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
      measureCanvas = undefined;
    },
  };
};
