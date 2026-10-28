import { describe, expect, it } from "vitest";
import { compositeRect, movePoint, normalizeRect } from "../src/viewer/logic.js";

describe("PDF viewer geometry", () => {
  it("normalizes reverse and forward drags", () => {
    expect(normalizeRect({ x: 90, y: 40 }, { x: 10, y: 15 })).toEqual({ x: 10, y: 15, width: 80, height: 25 });
    expect(normalizeRect({ x: 10, y: 15 }, { x: 90, y: 40 })).toEqual({ x: 10, y: 15, width: 80, height: 25 });
  });
  it("places a document rectangle in composite image pixels", () => {
    expect(compositeRect({ x: 130, y: 80, width: 20, height: 10 }, 2, { x: 100, y: 50 })).toEqual({ x: 60, y: 60, width: 40, height: 20 });
  });
  it("keeps capture coordinates at the image origin after scroll", () => {
    expect(compositeRect({ x: 48, y: 72, width: 120, height: 44 }, 2, { x: 0, y: 0 })).toEqual({ x: 96, y: 144, width: 240, height: 88 });
  });
  it("moves a point with its page when the pages grow, and picks the nearest page in a gap", () => {
    const before = [{ x: 100, y: 0, width: 200, height: 300 }, { x: 100, y: 310, width: 200, height: 300 }];
    const after = [{ x: 50, y: 0, width: 400, height: 600 }, { x: 50, y: 610, width: 400, height: 600 }];
    expect(movePoint({ x: 150, y: 75 }, before, after)).toEqual({ x: 150, y: 150 });
    expect(movePoint({ x: 200, y: 460 }, before, after)).toEqual({ x: 250, y: 910 });
    expect(movePoint({ x: 200, y: 308 }, before, after)).toEqual({ x: 250, y: 606 });
    expect(movePoint({ x: 1, y: 2 }, [], [])).toEqual({ x: 1, y: 2 });
  });
});
