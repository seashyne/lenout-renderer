import type { Rect, TextCommand } from "./types.js";

export interface TextMeasurement {
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
  width: number;
}

export type TextMeasure = (text: string, font: string) => TextMeasurement;

export interface TextLayoutLine {
  text: string;
  width: number;
  x: number;
  y: number;
}

export interface TextLayout {
  bounds: Rect;
  fontSize: number;
  lineHeight: number;
  lines: readonly TextLayoutLine[];
}

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const graphemes = (text: string): string[] => {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)].map(({ segment }) => segment);
  }
  return Array.from(text);
};

const textWidth = (text: string, font: string, letterSpacing: number, measure: TextMeasure): number => {
  const glyphs = graphemes(text);
  return measure(text, font).width + Math.max(0, glyphs.length - 1) * letterSpacing;
};

const splitLongToken = (token: string, maxWidth: number, widthOf: (value: string) => number): string[] => {
  const pieces: string[] = [];
  let current = "";
  for (const glyph of graphemes(token)) {
    const candidate = current + glyph;
    if (current && widthOf(candidate) > maxWidth) {
      pieces.push(current);
      current = glyph;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
};

const wrapParagraph = (paragraph: string, maxWidth: number | undefined, widthOf: (value: string) => number): string[] => {
  if (!maxWidth || maxWidth <= 0 || widthOf(paragraph) <= maxWidth) return [paragraph];
  const tokens = paragraph.split(/(\s+)/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    const candidate = line + token;
    if (line && widthOf(candidate) > maxWidth) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = candidate;
    }
    if (line && widthOf(line) > maxWidth) {
      const pieces = splitLongToken(line, maxWidth, widthOf);
      lines.push(...pieces.slice(0, -1));
      line = pieces.at(-1) ?? "";
    }
  }
  lines.push(line.trimEnd());
  return lines;
};

export const layoutText = (command: TextCommand, measure: TextMeasure): TextLayout => {
  const font = command.font || "14px sans-serif";
  const fontSize = Math.max(1, Number(font.match(/([\d.]+)px/)?.[1] ?? 14));
  const lineHeight = Math.max(fontSize, command.lineHeight ?? fontSize * 1.2);
  const letterSpacing = Number.isFinite(command.letterSpacing) ? command.letterSpacing ?? 0 : 0;
  const maxWidth = command.maxWidth && Number.isFinite(command.maxWidth) ? Math.max(1, command.maxWidth) : undefined;
  const widthCache = new Map<string, number>();
  const widthOf = (value: string): number => {
    const cached = widthCache.get(value);
    if (cached !== undefined) return cached;
    const width = textWidth(value, font, letterSpacing, measure);
    widthCache.set(value, width);
    return width;
  };
  const rawLines = command.text.split(/\r?\n/u).flatMap((paragraph) => wrapParagraph(paragraph, maxWidth, widthOf));
  if (rawLines.length === 0) rawLines.push("");
  const widths = rawLines.map(widthOf);
  const blockHeight = rawLines.length * lineHeight;
  const direction = command.direction ?? "inherit";
  const requestedAlign = command.align ?? "start";
  const align = requestedAlign === "start" ? (direction === "rtl" ? "right" : "left")
    : requestedAlign === "end" ? (direction === "rtl" ? "left" : "right")
      : requestedAlign;
  const baseline = command.baseline ?? "top";
  const top = baseline === "middle" ? command.y - blockHeight / 2
    : baseline === "bottom" ? command.y - blockHeight
      : baseline === "alphabetic" ? command.y - fontSize
        : command.y;
  const lines = rawLines.map((text, index) => {
    const width = widths[index]!;
    const x = align === "center" ? command.x - width / 2 : align === "right" ? command.x - width : command.x;
    return { text, width, x, y: top + index * lineHeight };
  });
  const minX = Math.min(...lines.map((line) => line.x));
  const maxX = Math.max(...lines.map((line) => line.x + line.width));
  return {
    bounds: { x: minX, y: top, width: Math.max(0, maxX - minX), height: blockHeight },
    fontSize,
    lineHeight,
    lines,
  };
};

/** Conservative DOM-free bounds used by tile invalidation before rasterization. */
export const estimateTextBounds = (command: TextCommand): Rect => {
  const fontSize = Math.max(1, Number(command.font.match(/([\d.]+)px/)?.[1] ?? 14));
  const measure: TextMeasure = (text) => ({ width: text.length * fontSize });
  const bounds = layoutText(command, measure).bounds;
  return { x: bounds.x - 2, y: bounds.y - 2, width: bounds.width + 4, height: bounds.height + 4 };
};
