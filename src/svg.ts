import { circlePoints, ellipsePoints } from "./pathParser.js";
import { resolveComposite } from "./compositor.js";
import type { BlendMode, Color, Rect, RenderCommand, StrokeStyle, Vec2 } from "./types.js";
import { sharedVectorPathCache } from "./vectorPath.js";

interface SvgNode {
  attributes: Record<string, string>;
  children: SvgNode[];
  name: string;
  text: string;
}

interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface SvgStyle {
  blendMode: BlendMode;
  fill: Color | null;
  fillOpacity: number;
  fontFamily: string;
  fontSize: number;
  fontStyle: string;
  fontWeight: string;
  opacity: number;
  stroke: Color | null;
  strokeOpacity: number;
  strokeLineCap: StrokeStyle["lineCap"];
  strokeLineJoin: StrokeStyle["lineJoin"];
  strokeMiterLimit: number;
  strokeWidth: number;
}

export interface CompileSvgOptions {
  /** Optional world-space destination. The SVG viewBox is fitted inside it. */
  destination?: Rect;
  pathResolution?: number;
}

const identity = (): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
const multiply = (left: Matrix2D, right: Matrix2D): Matrix2D => ({
  a: left.a * right.a + left.c * right.b,
  b: left.b * right.a + left.d * right.b,
  c: left.a * right.c + left.c * right.d,
  d: left.b * right.c + left.d * right.d,
  e: left.a * right.e + left.c * right.f + left.e,
  f: left.b * right.e + left.d * right.f + left.f,
});
const transformPoint = (matrix: Matrix2D, point: Vec2): Vec2 => ({
  x: matrix.a * point.x + matrix.c * point.y + matrix.e,
  y: matrix.b * point.x + matrix.d * point.y + matrix.f,
});
const isIdentity = (matrix: Matrix2D): boolean =>
  matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1 && matrix.e === 0 && matrix.f === 0;
const scaleOf = (matrix: Matrix2D): number => Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));

const numeric = (value: string | undefined, fallback = 0): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};
const unit = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
const withAlpha = (color: Color, opacity: number): Color => [color[0], color[1], color[2], color[3] * unit(opacity)];

const namedColors: Record<string, Color> = {
  black: [0, 0, 0, 1],
  blue: [0, 0, 1, 1],
  gray: [0.5, 0.5, 0.5, 1],
  green: [0, 0.5, 0, 1],
  red: [1, 0, 0, 1],
  transparent: [0, 0, 0, 0],
  white: [1, 1, 1, 1],
  yellow: [1, 1, 0, 1],
};

export const parseSvgColor = (raw: string | undefined): Color | null | undefined => {
  if (raw === undefined || raw === "inherit") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "none") return null;
  if (namedColors[value]) return [...namedColors[value]] as Color;
  const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map((part) => part + part).join("") : hex;
    if (expanded.length === 6 || expanded.length === 8) {
      return [
        Number.parseInt(expanded.slice(0, 2), 16) / 255,
        Number.parseInt(expanded.slice(2, 4), 16) / 255,
        Number.parseInt(expanded.slice(4, 6), 16) / 255,
        expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/)?.[1]?.split(/[\s,\/]+/u).filter(Boolean);
  if (rgb && rgb.length >= 3) {
    const channel = (entry: string): number => entry.endsWith("%") ? unit(numeric(entry) / 100) : unit(numeric(entry) / 255);
    return [channel(rgb[0]!), channel(rgb[1]!), channel(rgb[2]!), rgb[3] === undefined ? 1 : unit(numeric(rgb[3], 1))];
  }
  return undefined;
};

const decodeXml = (value: string): string => value
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"")
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&")
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code.startsWith("x") ? code.slice(1) : code, code.startsWith("x") ? 16 : 10)));

const parseMarkup = (markup: string): SvgNode => {
  if (/<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error("Lenout Renderer: SVG entities and doctypes are not supported");
  const documentNode: SvgNode = { attributes: {}, children: [], name: "document", text: "" };
  const stack = [documentNode];
  for (const token of markup.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      const closing = token.match(/^<\/\s*([\w:-]+)/)?.[1]?.toLowerCase();
      if (stack.length > 1 && stack.at(-1)!.name === closing) stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const tag = token.match(/^<\s*([\w:-]+)/)?.[1]?.toLowerCase();
      if (!tag) continue;
      const blocked = tag === "script" || tag === "foreignobject" || tag === "image";
      const attributes: Record<string, string> = {};
      for (const match of token.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const name = match[1]!.toLowerCase();
        if (!name.startsWith("on") && name !== "href" && name !== "xlink:href") attributes[name] = decodeXml(match[2] ?? match[3] ?? "");
      }
      const node: SvgNode = { attributes, children: [], name: blocked ? "blocked" : tag, text: "" };
      stack.at(-1)!.children.push(node);
      if (!/\/\s*>$/.test(token) && !blocked) stack.push(node);
      continue;
    }
    stack.at(-1)!.text += decodeXml(token);
  }
  const root = documentNode.children.find((node) => node.name === "svg");
  if (!root) throw new Error("Lenout Renderer: expected an <svg> root element");
  return root;
};

const styleAttributes = (node: SvgNode): Record<string, string> => {
  const values = { ...node.attributes };
  for (const declaration of (node.attributes.style ?? "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    values[declaration.slice(0, separator).trim().toLowerCase()] = declaration.slice(separator + 1).trim();
  }
  return values;
};

const blendMode = (value: string | undefined, fallback: BlendMode): BlendMode =>
  value === "multiply" || value === "screen" || value === "add" ? value : fallback;

const inheritStyle = (parent: SvgStyle, node: SvgNode): SvgStyle => {
  const values = styleAttributes(node);
  const fill = parseSvgColor(values.fill);
  const stroke = parseSvgColor(values.stroke);
  return {
    blendMode: blendMode(values["mix-blend-mode"], parent.blendMode),
    fill: fill === undefined ? parent.fill : fill,
    fillOpacity: values["fill-opacity"] === undefined ? parent.fillOpacity : unit(numeric(values["fill-opacity"], 1)),
    fontFamily: values["font-family"] ?? parent.fontFamily,
    fontSize: numeric(values["font-size"], parent.fontSize),
    fontStyle: values["font-style"] ?? parent.fontStyle,
    fontWeight: values["font-weight"] ?? parent.fontWeight,
    opacity: parent.opacity * unit(numeric(values.opacity, 1)),
    stroke: stroke === undefined ? parent.stroke : stroke,
    strokeLineCap: values["stroke-linecap"] === "round" || values["stroke-linecap"] === "square" ? values["stroke-linecap"] : parent.strokeLineCap,
    strokeLineJoin: values["stroke-linejoin"] === "round" || values["stroke-linejoin"] === "bevel" ? values["stroke-linejoin"] : parent.strokeLineJoin,
    strokeMiterLimit: numeric(values["stroke-miterlimit"], parent.strokeMiterLimit),
    strokeOpacity: values["stroke-opacity"] === undefined ? parent.strokeOpacity : unit(numeric(values["stroke-opacity"], 1)),
    strokeWidth: numeric(values["stroke-width"], parent.strokeWidth),
  };
};

const parseTransform = (raw: string | undefined): Matrix2D => {
  let result = identity();
  for (const match of raw?.matchAll(/([a-z]+)\s*\(([^)]*)\)/gi) ?? []) {
    const name = match[1]!.toLowerCase();
    const values = match[2]!.split(/[\s,]+/u).filter(Boolean).map(Number);
    let next = identity();
    if (name === "matrix" && values.length >= 6) {
      next = { a: values[0]!, b: values[1]!, c: values[2]!, d: values[3]!, e: values[4]!, f: values[5]! };
    } else if (name === "translate") {
      next.e = values[0] ?? 0;
      next.f = values[1] ?? 0;
    } else if (name === "scale") {
      next.a = values[0] ?? 1;
      next.d = values[1] ?? values[0] ?? 1;
    } else if (name === "rotate") {
      const angle = (values[0] ?? 0) * Math.PI / 180;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const rotation = { a: cosine, b: sine, c: -sine, d: cosine, e: 0, f: 0 };
      const cx = values[1] ?? 0;
      const cy = values[2] ?? 0;
      next = multiply(multiply({ ...identity(), e: cx, f: cy }, rotation), { ...identity(), e: -cx, f: -cy });
    }
    result = multiply(result, next);
  }
  return result;
};

const pointList = (value: string | undefined): Vec2[] => {
  const values = value?.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const points: Vec2[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) points.push({ x: values[index]!, y: values[index + 1]! });
  return points;
};

const strokeStyle = (style: SvgStyle, matrix: Matrix2D): StrokeStyle | undefined => style.stroke ? {
  color: withAlpha(style.stroke, style.strokeOpacity),
  lineCap: style.strokeLineCap,
  lineJoin: style.strokeLineJoin,
  miterLimit: style.strokeMiterLimit,
  width: Math.max(0, style.strokeWidth * scaleOf(matrix)),
} : undefined;

const viewBoxMatrix = (root: SvgNode, destination: Rect | undefined): Matrix2D => {
  if (!destination) return identity();
  const viewBox = pointList(root.attributes.viewbox);
  const origin = viewBox[0];
  const extent = viewBox[1];
  const sourceX = origin?.x ?? 0;
  const sourceY = origin?.y ?? 0;
  const sourceWidth = extent?.x ?? numeric(root.attributes.width, destination.width);
  const sourceHeight = extent?.y ?? numeric(root.attributes.height, destination.height);
  const scale = Math.min(destination.width / Math.max(1, sourceWidth), destination.height / Math.max(1, sourceHeight));
  return {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: destination.x + (destination.width - sourceWidth * scale) / 2 - sourceX * scale,
    f: destination.y + (destination.height - sourceHeight * scale) / 2 - sourceY * scale,
  };
};

/** Compile safe, static SVG markup into Night render commands. */
export const compileSvg = (markup: string, options: CompileSvgOptions = {}): RenderCommand[] => {
  const root = parseMarkup(markup);
  const commands: RenderCommand[] = [];
  const resolution = options.pathResolution ?? 20;
  const initialStyle: SvgStyle = {
    blendMode: "normal",
    fill: [0, 0, 0, 1],
    fillOpacity: 1,
    fontFamily: "sans-serif",
    fontSize: 16,
    fontStyle: "normal",
    fontWeight: "400",
    opacity: 1,
    stroke: null,
    strokeLineCap: "butt",
    strokeLineJoin: "miter",
    strokeMiterLimit: 4,
    strokeOpacity: 1,
    strokeWidth: 1,
  };

  const push = (command: RenderCommand, style: SvgStyle): void => {
    const composite = resolveComposite({ blendMode: style.blendMode, opacity: style.opacity });
    commands.push({ ...command, composite });
  };

  const visit = (node: SvgNode, parentStyle: SvgStyle, parentMatrix: Matrix2D): void => {
    if (node.name === "blocked") return;
    const style = inheritStyle(parentStyle, node);
    const matrix = multiply(parentMatrix, parseTransform(node.attributes.transform));
    const fill = style.fill ? withAlpha(style.fill, style.fillOpacity) : undefined;
    const stroke = strokeStyle(style, matrix);
    const a = node.attributes;

    if (node.name === "path" && a.d) {
      if (isIdentity(matrix)) {
        push({ type: "path", d: a.d, fill, stroke, fillRule: a["fill-rule"] === "evenodd" ? "evenodd" : "nonzero" }, style);
      } else {
        for (const contour of sharedVectorPathCache.get(a.d, resolution).contours) {
          const points = contour.points.map((point) => transformPoint(matrix, point));
          if (fill) push({ type: "polygon", points, fill, fillRule: a["fill-rule"] === "evenodd" ? "evenodd" : "nonzero" }, style);
          if (stroke) push({ type: contour.closed ? "polygon" : "polyline", points, stroke }, style);
        }
      }
    } else if (node.name === "rect") {
      const x = numeric(a.x);
      const y = numeric(a.y);
      const width = Math.max(0, numeric(a.width));
      const height = Math.max(0, numeric(a.height));
      if (isIdentity(matrix)) push({ type: "rect", dst: { x, y, width, height }, radius: Math.max(0, numeric(a.rx, numeric(a.ry))), fill, stroke }, style);
      else push({ type: "polygon", points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }].map((point) => transformPoint(matrix, point)), fill, stroke }, style);
    } else if (node.name === "circle") {
      const cx = numeric(a.cx);
      const cy = numeric(a.cy);
      const radius = Math.max(0, numeric(a.r));
      if (isIdentity(matrix)) push({ type: "circle", cx, cy, radius, fill, stroke }, style);
      else push({ type: "polygon", points: circlePoints(cx, cy, radius, 48).map((point) => transformPoint(matrix, point)), fill, stroke }, style);
    } else if (node.name === "ellipse") {
      const cx = numeric(a.cx);
      const cy = numeric(a.cy);
      const rx = Math.max(0, numeric(a.rx));
      const ry = Math.max(0, numeric(a.ry));
      if (isIdentity(matrix)) push({ type: "ellipse", cx, cy, rx, ry, fill, stroke }, style);
      else push({ type: "polygon", points: ellipsePoints(cx, cy, rx, ry, 48).map((point) => transformPoint(matrix, point)), fill, stroke }, style);
    } else if (node.name === "line" && stroke) {
      const from = transformPoint(matrix, { x: numeric(a.x1), y: numeric(a.y1) });
      const to = transformPoint(matrix, { x: numeric(a.x2), y: numeric(a.y2) });
      push({ type: "line", x1: from.x, y1: from.y, x2: to.x, y2: to.y, color: stroke.color, width: stroke.width }, style);
    } else if (node.name === "polygon" || (node.name === "polyline" && stroke)) {
      const points = pointList(a.points).map((point) => transformPoint(matrix, point));
      if (node.name === "polygon") push({ type: "polygon", points, fill, stroke }, style);
      else if (stroke) push({ type: "polyline", points, stroke }, style);
    } else if (node.name === "text") {
      const position = transformPoint(matrix, { x: numeric(a.x), y: numeric(a.y) });
      const anchor = a["text-anchor"];
      const baseline = a["dominant-baseline"];
      push({
        type: "text",
        text: node.text.trim(),
        x: position.x,
        y: position.y,
        color: fill ?? [0, 0, 0, 1],
        font: `${style.fontStyle} ${style.fontWeight} ${Math.max(1, style.fontSize * scaleOf(matrix))}px ${style.fontFamily}`,
        align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
        baseline: baseline === "middle" || baseline === "central" ? "middle" : baseline === "text-after-edge" ? "bottom" : "alphabetic",
      }, style);
    }

    for (const child of node.children) visit(child, style, matrix);
  };

  const rootMatrix = viewBoxMatrix(root, options.destination);
  visit(root, initialStyle, rootMatrix);
  return commands;
};
