import { describe, expect, it } from "vitest";
import { parsePath, tessellatePathContours } from "../src/pathParser.js";
import { compileSvg, parseSvgColor } from "../src/svg.js";
import { createVectorPathCache } from "../src/vectorPath.js";

describe("SVG vector paths", () => {
  it("normalizes the complete common SVG path command set", () => {
    const segments = parsePath("M10 10 h80 v80 h-80 z m10-10 C10 0 20 0 20 10 S30 20 40 10 Q50 0 60 10 T80 10 A10 10 0 0 1 90 20");
    expect(segments.map((segment) => segment.cmd)).toEqual([
      "M", "L", "L", "L", "Z", "M", "C", "C", "Q", "Q", "A",
    ]);
    expect(segments.at(-1)).toMatchObject({ cmd: "A", x: 90, y: 20, sweep: true });
  });

  it("tessellates arcs and preserves whether a subpath is open", () => {
    const contours = tessellatePathContours(parsePath("M0 0 A20 10 30 0 1 40 0 M50 0 L60 0 Z"), 12);
    expect(contours).toHaveLength(2);
    expect(contours[0]!.closed).toBe(false);
    expect(contours[0]!.points.at(-1)!.x).toBeCloseTo(40, 5);
    expect(contours[1]!.closed).toBe(true);
  });

  it("reuses bounded parsed path data", () => {
    const cache = createVectorPathCache(2);
    const first = cache.get("M0 0 L10 0 L10 10 Z");
    expect(cache.get("M0 0 L10 0 L10 10 Z")).toBe(first);
    expect(first.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    cache.get("M0 0 L1 1");
    cache.get("M0 0 L2 2");
    expect(cache.size).toBe(2);
  });
});

describe("SVG compiler", () => {
  it("compiles safe shapes, inherited opacity, transforms and text", () => {
    const commands = compileSvg(`
      <svg viewBox="0 0 100 50">
        <g opacity="0.5" transform="translate(10 5)">
          <rect x="0" y="0" width="20" height="10" fill="#ff0000" />
          <path d="M0 20 h20" fill="none" stroke="rgb(0,0,255)" stroke-width="2" />
          <text x="0" y="40" font-size="12" text-anchor="middle">Night</text>
          <script>alert(1)</script>
        </g>
      </svg>
    `);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toMatchObject({ type: "polygon", composite: { opacity: 0.5 } });
    expect(commands[1]).toMatchObject({ type: "polyline", composite: { opacity: 0.5 } });
    expect(commands[2]).toMatchObject({ type: "text", text: "Night", align: "center" });
  });

  it("fits a viewBox into a destination and parses alpha colors", () => {
    const [command] = compileSvg('<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#33669980"/></svg>', {
      destination: { x: 10, y: 20, width: 200, height: 100 },
    });
    expect(command).toMatchObject({ type: "polygon" });
    if (command?.type === "polygon") {
      expect(command.points[0]).toEqual({ x: 60, y: 20 });
      expect(command.fill?.[3]).toBeCloseTo(128 / 255, 5);
    }
    expect(parseSvgColor("rgba(255, 0, 0, 0.25)")).toEqual([1, 0, 0, 0.25]);
  });

  it("rejects entity-bearing SVG documents", () => {
    expect(() => compileSvg('<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///secret">]><svg/>')).toThrow(/entities/);
  });
});
