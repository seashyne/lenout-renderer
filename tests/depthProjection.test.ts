import { describe, expect, it } from "vitest";
import { depthScale2_5D, projectPoint2_5D, projectRect2_5D } from "../src/depthProjection.js";

const view = {
  cameraX: 20,
  cameraY: 10,
  perspective: 0.2,
  viewportHeight: 600,
  viewportWidth: 800,
  zoom: 1,
};

describe("2.5D depth projection", () => {
  it("scales distant layers down without crossing zero", () => {
    expect(depthScale2_5D(2, 0.2)).toBeCloseTo(1 / 1.4, 8);
    expect(depthScale2_5D(-100, 1)).toBe(10);
  });

  it("supports camera-independent HUD layers", () => {
    const point = projectPoint2_5D({ x: 400, y: 300 }, { depth: 0, parallax: 0 }, view);
    expect(point).toEqual({ x: 400, y: 300 });
  });

  it("projects rectangle position and size with one stable scale", () => {
    const projected = projectRect2_5D(
      { x: 400, y: 300, width: 140, height: 70 },
      { depth: 2, parallax: 1 },
      view,
    );
    expect(projected.width).toBeCloseTo(100, 8);
    expect(projected.height).toBeCloseTo(50, 8);
    expect(projected.x).toBeLessThan(400);
  });
});
