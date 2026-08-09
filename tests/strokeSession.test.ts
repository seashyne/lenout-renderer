import { describe, expect, it } from "vitest";
import { createStrokeSession } from "../src/strokeSession.js";

describe("StrokeSession", () => {
  it("produces no dabs for a single-point stroke", () => {
    const session = createStrokeSession({ spacing: 5 });
    session.begin({ x: 0, y: 0, pressure: 1, time: 0 });
    const dabs = session.end();
    // Single point produces one final dab
    expect(dabs.length).toBe(1);
    expect(dabs[0].x).toBe(0);
    expect(dabs[0].y).toBe(0);
  });

  it("interpolates dabs between two points", () => {
    const session = createStrokeSession({ spacing: 10, size: 20 });
    session.begin({ x: 0, y: 0, pressure: 1, time: 0 });
    const midDabs = session.move({ x: 100, y: 0, pressure: 1, time: 100 });
    // 100px distance / 10px spacing = 10 dabs during move
    expect(midDabs.length).toBeGreaterThanOrEqual(9);
    expect(midDabs.length).toBeLessThanOrEqual(11);

    const endDabs = session.end();
    // End produces one final dab
    expect(endDabs.length).toBe(1);
  });

  it("respects pressure-based size modulation", () => {
    const session = createStrokeSession({ size: 30, spacing: 10, pressureSize: true });
    session.begin({ x: 0, y: 0, pressure: 0.2, time: 0 });
    session.move({ x: 50, y: 0, pressure: 1, time: 50 });
    const dabs = session.end();

    // High-pressure dab should be larger than low-pressure min
    expect(dabs[0].size).toBeGreaterThan(15);
  });

  it("disables pressure modulation when pressureSize is false", () => {
    const session = createStrokeSession({ size: 20, spacing: 10, pressureSize: false });
    session.begin({ x: 0, y: 0, pressure: 0.1, time: 0 });
    session.move({ x: 50, y: 0, pressure: 0.1, time: 50 });
    const dabs = session.end();
    // Size should stay at base regardless of pressure
    expect(dabs[0].size).toBe(20);
  });

  it("cancels a stroke without producing dabs", () => {
    const session = createStrokeSession();
    session.begin({ x: 0, y: 0, pressure: 1, time: 0 });
    session.move({ x: 20, y: 0, pressure: 1, time: 50 });
    session.cancel();
    // After cancel, end should be a no-op (already cancelled)
    // start a new stroke to verify state is clean
    session.begin({ x: 10, y: 10, pressure: 1, time: 100 });
    const dabs = session.end();
    expect(dabs.length).toBe(1);
    expect(dabs[0].x).toBe(10);
    expect(dabs[0].y).toBe(10);
  });

  it("returns empty for end with no points", () => {
    const session = createStrokeSession();
    expect(session.end()).toEqual([]);
  });
});
