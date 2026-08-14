import { resolveComposite } from "../compositor.js";
import { circlePoints, ellipsePoints } from "../pathParser.js";
import { triangulate } from "../triangulate.js";
import type { BrushDab, Color, Rect, RenderCommand, RenderTile, StrokeStyle, Vec2 } from "../types.js";
import { sharedVectorPathCache } from "../vectorPath.js";

const SOLID_FLOATS = 6;
const IMAGE_FLOATS = 5;
const BRUSH_FLOATS = 10;

const appendVertex = (target: number[], point: Vec2, color: Color): void => {
  target.push(point.x, point.y, color[0], color[1], color[2], color[3]);
};

const appendTriangle = (target: number[], a: Vec2, b: Vec2, c: Vec2, color: Color): void => {
  appendVertex(target, a, color);
  appendVertex(target, b, color);
  appendVertex(target, c, color);
};

const withOpacity = (color: Color, opacity: number): Color => [color[0], color[1], color[2], color[3] * opacity];

const appendPolygon = (target: number[], points: readonly Vec2[], color: Color): void => {
  if (points.length < 3) return;
  const vertices = [...points];
  const first = vertices[0]!;
  const last = vertices.at(-1)!;
  if (vertices.length > 3 && first.x === last.x && first.y === last.y) vertices.pop();
  const signedArea = vertices.reduce((area, point, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    return area + point.x * next.y - next.x * point.y;
  }, 0);
  if (signedArea < 0) vertices.reverse();
  for (const index of triangulate(vertices)) appendVertex(target, vertices[index]!, color);
};

const appendRect = (target: number[], rect: Rect, color: Color): void => {
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.x + rect.width, y: rect.y };
  const bottomLeft = { x: rect.x, y: rect.y + rect.height };
  const bottomRight = { x: rect.x + rect.width, y: rect.y + rect.height };
  appendTriangle(target, topLeft, topRight, bottomLeft, color);
  appendTriangle(target, bottomLeft, topRight, bottomRight, color);
};

const roundedRectPoints = (rect: Rect, radius: number): Vec2[] => {
  const safeRadius = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  if (safeRadius === 0) {
    return [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ];
  }
  const points: Vec2[] = [];
  const corners = [
    [rect.x + safeRadius, rect.y + safeRadius, Math.PI, Math.PI * 1.5],
    [rect.x + rect.width - safeRadius, rect.y + safeRadius, Math.PI * 1.5, Math.PI * 2],
    [rect.x + rect.width - safeRadius, rect.y + rect.height - safeRadius, 0, Math.PI * 0.5],
    [rect.x + safeRadius, rect.y + rect.height - safeRadius, Math.PI * 0.5, Math.PI],
  ] as const;
  const steps = Math.max(3, Math.ceil(safeRadius / 4));
  for (const [cx, cy, start, end] of corners) {
    for (let index = 0; index <= steps; index++) {
      const angle = start + (end - start) * (index / steps);
      points.push({ x: cx + Math.cos(angle) * safeRadius, y: cy + Math.sin(angle) * safeRadius });
    }
  }
  return points;
};

const appendLine = (target: number[], from: Vec2, to: Vec2, width: number, color: Color): void => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0 || width <= 0) return;
  const nx = (-dy / length) * width * 0.5;
  const ny = (dx / length) * width * 0.5;
  const a = { x: from.x + nx, y: from.y + ny };
  const b = { x: to.x + nx, y: to.y + ny };
  const c = { x: from.x - nx, y: from.y - ny };
  const d = { x: to.x - nx, y: to.y - ny };
  appendTriangle(target, a, b, c, color);
  appendTriangle(target, c, b, d, color);
};

const appendStroke = (
  target: number[],
  points: readonly Vec2[],
  style: StrokeStyle,
  closed: boolean,
): void => {
  const { width, color } = style;
  const end = closed ? points.length : points.length - 1;
  for (let index = 0; index < end; index++) {
    appendLine(target, points[index]!, points[(index + 1) % points.length]!, width, color);
  }
  if (style.lineJoin === "round") {
    const firstJoin = closed ? 0 : 1;
    const lastJoin = closed ? points.length : points.length - 1;
    for (let index = firstJoin; index < lastJoin; index++) {
      appendPolygon(target, circlePoints(points[index]!.x, points[index]!.y, width / 2, 12), color);
    }
  }
  if (!closed && style.lineCap === "round" && points.length > 1) {
    appendPolygon(target, circlePoints(points[0]!.x, points[0]!.y, width / 2, 12), color);
    appendPolygon(target, circlePoints(points.at(-1)!.x, points.at(-1)!.y, width / 2, 12), color);
  }
};

const curveSegments = (radius: number): number => Math.max(20, Math.min(96, Math.ceil(radius * 0.75)));

export const appendSolidGeometry = (
  target: number[],
  command: RenderCommand,
  tile: RenderTile,
): { vertexOffset: number; vertexCount: number; replace: boolean } | null => {
  const start = target.length / SOLID_FLOATS;
  const opacity = resolveComposite(command.composite).opacity;
  switch (command.type) {
    case "clear":
      appendRect(target, { x: tile.worldX, y: tile.worldY, width: tile.size, height: tile.size }, withOpacity(command.color, opacity));
      break;
    case "rect": {
      const points = roundedRectPoints(command.dst, command.radius);
      if (command.fill) appendPolygon(target, points, withOpacity(command.fill, opacity));
      if (command.stroke) appendStroke(target, points, { ...command.stroke, color: withOpacity(command.stroke.color, opacity) }, true);
      break;
    }
    case "circle": {
      const points = circlePoints(command.cx, command.cy, command.radius, curveSegments(command.radius));
      if (command.fill) appendPolygon(target, points, withOpacity(command.fill, opacity));
      if (command.stroke) appendStroke(target, points, { ...command.stroke, color: withOpacity(command.stroke.color, opacity) }, true);
      break;
    }
    case "ellipse": {
      const points = ellipsePoints(command.cx, command.cy, command.rx, command.ry, curveSegments(Math.max(command.rx, command.ry)));
      if (command.fill) appendPolygon(target, points, withOpacity(command.fill, opacity));
      if (command.stroke) appendStroke(target, points, { ...command.stroke, color: withOpacity(command.stroke.color, opacity) }, true);
      break;
    }
    case "line":
      appendLine(target, { x: command.x1, y: command.y1 }, { x: command.x2, y: command.y2 }, command.width, withOpacity(command.color, opacity));
      break;
    case "polygon":
      if (command.fill) appendPolygon(target, command.points, withOpacity(command.fill, opacity));
      if (command.stroke) appendStroke(target, command.points, { ...command.stroke, color: withOpacity(command.stroke.color, opacity) }, true);
      break;
    case "polyline":
      appendStroke(target, command.points, { ...command.stroke, color: withOpacity(command.stroke.color, opacity) }, false);
      break;
    case "path":
      for (const contour of sharedVectorPathCache.get(command.d).contours) {
        if (command.fill) appendPolygon(target, contour.points, withOpacity(command.fill, opacity));
        if (command.stroke) appendStroke(target, contour.points, { ...command.stroke, color: withOpacity(command.stroke.color, opacity) }, contour.closed);
      }
      break;
    default:
      return null;
  }
  return {
    vertexOffset: start,
    vertexCount: target.length / SOLID_FLOATS - start,
    replace: command.type === "clear",
  };
};

export const appendImageGeometry = (target: number[], rect: Rect, opacity: number): { vertexOffset: number; vertexCount: number } => {
  const start = target.length / IMAGE_FLOATS;
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  target.push(
    left, top, 0, 0, opacity,
    right, top, 1, 0, opacity,
    left, bottom, 0, 1, opacity,
    left, bottom, 0, 1, opacity,
    right, top, 1, 0, opacity,
    right, bottom, 1, 1, opacity,
  );
  return { vertexOffset: start, vertexCount: 6 };
};

export const appendBrushInstances = (target: number[], dabs: readonly BrushDab[], opacity = 1): { firstInstance: number; instanceCount: number } => {
  const start = target.length / BRUSH_FLOATS;
  for (const dab of dabs) {
    target.push(
      dab.x, dab.y, Math.max(0.01, dab.size), Math.max(0, Math.min(1, dab.hardness)),
      dab.color[0], dab.color[1], dab.color[2], dab.color[3],
      Math.max(0, Math.min(1, dab.opacity * opacity)), dab.rotation,
    );
  }
  return { firstInstance: start, instanceCount: dabs.length };
};

export const transparentTileGeometry = (tile: RenderTile): number[] => {
  const target: number[] = [];
  appendRect(target, { x: tile.worldX, y: tile.worldY, width: tile.size, height: tile.size }, [0, 0, 0, 0]);
  return target;
};
