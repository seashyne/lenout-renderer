import { describe, expect, it } from "vitest";
import {
  calculateLenoutDisplayMetrics,
  createCanvasDpiController,
  resolveLenoutPixelRatio,
} from "../src/dpi.js";

describe("Lenout DPI", () => {
  it("uses device DPI while respecting the GPU-memory cap", () => {
    expect(resolveLenoutPixelRatio("auto", 2, 3)).toBe(2);
    expect(resolveLenoutPixelRatio("auto", 3, 2.5)).toBe(2.5);
    expect(resolveLenoutPixelRatio(1.5, 2, 3)).toBe(1.5);
  });

  it("keeps logical dimensions separate from physical pixels", () => {
    expect(calculateLenoutDisplayMetrics(320, 180, 2)).toEqual({
      logicalWidth: 320,
      logicalHeight: 180,
      physicalWidth: 640,
      physicalHeight: 360,
      pixelRatio: 2,
      revision: 0,
    });
  });

  it("resizes the canvas backing store without changing its CSS size", () => {
    const canvas = {
      width: 320,
      height: 180,
      clientWidth: 320,
      clientHeight: 180,
      style: { width: "", height: "" },
      getBoundingClientRect: () => ({ width: 320, height: 180 }),
    } as unknown as HTMLCanvasElement;
    const controller = createCanvasDpiController(canvas, { pixelRatio: 2 });

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(canvas.style.width).toBe("320px");
    expect(canvas.style.height).toBe("180px");
    expect(controller.metrics.pixelRatio).toBe(2);
    expect(controller.resize(400, 200)).toBe(true);
    expect(controller.metrics).toMatchObject({
      logicalWidth: 400,
      logicalHeight: 200,
      physicalWidth: 800,
      physicalHeight: 400,
      revision: 2,
    });
  });
});
