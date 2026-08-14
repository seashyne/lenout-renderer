import { performance } from "node:perf_hooks";
import { createTileManager } from "../dist/tileManager.js";
import { parsePath, tessellatePathContours } from "../dist/pathParser.js";
import { createVectorPathCache } from "../dist/vectorPath.js";
import { layoutText } from "../dist/textLayout.js";

const measure = (name, iterations, operation) => {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index++) operation(index);
  const elapsedMs = performance.now() - startedAt;
  return {
    benchmark: name,
    iterations,
    totalMs: Number(elapsedMs.toFixed(2)),
    averageMs: Number((elapsedMs / iterations).toFixed(4)),
  };
};

const tileManager = createTileManager(128, { maxCachedTiles: 8_192, overscanTiles: 0 });
tileManager.visibleTiles(0, 0, 1, 8_192, 8_192);
const vectorCache = createVectorPathCache(512);
const svgPath = "M20 80 C20 20 80 20 80 80 S140 140 140 80 A30 20 25 0 1 200 90 Q230 140 260 80 Z";
vectorCache.get(svgPath);
const textCommand = {
  type: "text",
  text: "Night renders multilingual vector text without repeating layout work across tiles.",
  font: "18px sans-serif",
  x: 0,
  y: 0,
  color: [1, 1, 1, 1],
  maxWidth: 360,
  lineHeight: 24,
  letterSpacing: 0.25,
};

const results = [
  measure("large dirty rect / 4,096 cached tiles", 250, () => {
    tileManager.markDirtyRect({ x: -1_000_000, y: -1_000_000, width: 2_000_000, height: 2_000_000 });
  }),
  measure("viewport cache hit / 4,096 tiles", 100, () => {
    tileManager.visibleTiles(0, 0, 1, 8_192, 8_192);
  }),
  measure("pan + bounded LRU eviction", 1_000, (frame) => {
    tileManager.visibleTiles(-frame * 16, 0, 1, 1_024, 768);
    tileManager.evict(300);
  }),
  measure("cached SVG path lookup", 10_000, () => {
    vectorCache.get(svgPath);
  }),
  measure("uncached SVG parse + tessellate", 1_000, () => {
    tessellatePathContours(parsePath(svgPath), 20);
  }),
  measure("wrapped text layout", 10_000, () => {
    layoutText(textCommand, (text) => ({ width: text.length * 9 }));
  }),
];

console.table(results);
console.log("cache", tileManager.stats);
