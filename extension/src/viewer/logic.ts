import type { Rect } from "../types.js";

export function normalizeRect(start: { x: number; y: number }, end: { x: number; y: number }): Rect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function compositeRect(rect: Rect, scale: number, offset: { x: number; y: number }): Rect {
  return { x: (rect.x - offset.x) * scale, y: (rect.y - offset.y) * scale, width: rect.width * scale, height: rect.height * scale };
}

// Where a point on a page lands after pdf.js lays the pages out again: same spot, as a share of that page.
export function movePoint(point: { x: number; y: number }, before: Rect[], after: Rect[]): { x: number; y: number } {
  const gap = (box: Rect) => Math.max(box.y - point.y, point.y - box.y - box.height, 0);
  const index = before.reduce((best, box, i) => gap(box) < gap(before[best]!) ? i : best, 0);
  const from = before[index], to = after[index];
  if (!from || !to || !from.width || !from.height) return point;
  return { x: to.x + (point.x - from.x) / from.width * to.width, y: to.y + (point.y - from.y) / from.height * to.height };
}
