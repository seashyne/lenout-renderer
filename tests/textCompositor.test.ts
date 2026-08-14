import { describe, expect, it } from "vitest";
import { flattenCompositeLayers, resolveComposite } from "../src/compositor.js";
import { layoutText } from "../src/textLayout.js";
import type { TextCommand } from "../src/types.js";

const text = (overrides: Partial<TextCommand> = {}): TextCommand => ({
  type: "text",
  text: "Night renderer text",
  font: "10px sans-serif",
  x: 100,
  y: 40,
  color: [1, 1, 1, 1],
  ...overrides,
});

describe("text layout", () => {
  it("wraps, aligns and positions multiline text deterministically", () => {
    const layout = layoutText(text({ align: "center", baseline: "middle", maxWidth: 60, lineHeight: 14 }), (value) => ({ width: value.length * 6 }));
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.every((line) => line.width <= 60)).toBe(true);
    expect(layout.bounds.y).toBe(40 - layout.bounds.height / 2);
    expect(layout.lines[0]!.x).toBe(100 - layout.lines[0]!.width / 2);
  });

  it("accounts for letter spacing in measured width", () => {
    const layout = layoutText(text({ text: "ABC", letterSpacing: 2 }), (value) => ({ width: value.length * 5 }));
    expect(layout.lines[0]!.width).toBe(19);
  });
});

describe("retained compositor", () => {
  it("preserves paint order and multiplies nested opacity", () => {
    const commands = flattenCompositeLayers([{
      opacity: 0.5,
      blendMode: "multiply",
      commands: [{ type: "rect", dst: { x: 0, y: 0, width: 10, height: 10 }, radius: 0, fill: [1, 0, 0, 1] }],
      children: [{
        opacity: 0.4,
        commands: [{ type: "text", text: "A", font: "10px sans-serif", x: 0, y: 0, color: [1, 1, 1, 1], composite: { opacity: 0.5 } }],
      }],
    }]);
    expect(commands).toHaveLength(2);
    expect(resolveComposite(commands[0]!.composite)).toEqual({ blendMode: "multiply", opacity: 0.5 });
    expect(resolveComposite(commands[1]!.composite)).toEqual({ blendMode: "multiply", opacity: 0.1 });
  });

  it("clamps invalid opacity and skips hidden layers", () => {
    expect(resolveComposite({ opacity: 2 }).opacity).toBe(1);
    expect(flattenCompositeLayers([{ visible: false, commands: [text()] }])).toEqual([]);
  });
});
