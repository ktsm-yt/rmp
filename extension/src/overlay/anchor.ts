import type { Rect } from "../types";
import { documentRect, scrollOffset } from "./logic";

type Point = { x: number; y: number };
type Frame = { x: number; y: number; scale: number };

// These draw their picture to the size of their box, so a bigger box is a bigger picture. Text only gets bigger by a
// transform: a wider paragraph wraps differently, and a place in it stays the same distance from its corner.
const PICTURES = "img,video,canvas,iframe,object,embed";
// ponytail: position and one scale, so a page that rotates or skews its content is not followed exactly.
function frameOf(element: Element): Frame | null {
  const box = element.getBoundingClientRect();
  if (!element.isConnected || (!box.width && !box.height)) return null;
  const scale = element instanceof HTMLElement && !element.matches(PICTURES)
    ? element.offsetWidth ? box.width / element.offsetWidth : 1 : Math.hypot(box.width, box.height);
  const { x, y } = documentRect(box);
  return { x, y, scale: scale || 1 };
}

/** A place on the page that has no element of its own (a range, a drawing), kept by the part under it. */
export class Anchor {
  private now: Frame;
  private constructor(private readonly element: Element, private readonly at: Frame, private readonly base: Rect) { this.now = at; }

  /** The part under the middle of the rect, else the nearest one that moves with that blank. */
  static under(rect: Rect, pick: (x: number, y: number) => Element | null): Anchor | null {
    const middle = { x: rect.x - scrollOffset("x") + rect.width / 2, y: rect.y - scrollOffset("y") + rect.height / 2 };
    const hit = pick(middle.x, middle.y);
    // A blank hits a container, which may be the window the content moves in: only a part of the content is sure to move.
    const element = hit && isPart(hit) ? hit : nearest(hit ?? document.body, middle) ?? hit;
    const at = element && frameOf(element);
    return at ? new Anchor(element, at, { ...rect }) : null;
  }

  /** Where the part is now; while it is hidden or gone, where it was last. */
  read(): void { this.now = frameOf(this.element) ?? this.now; }
  point(p: Point): Point {
    const k = this.now.scale / this.at.scale;
    return { x: this.now.x + (p.x - this.at.x) * k, y: this.now.y + (p.y - this.at.y) * k };
  }
  rect(): Rect {
    const { x, y } = this.point(this.base), k = this.now.scale / this.at.scale;
    return { x, y, width: this.base.width * k, height: this.base.height * k };
  }
}

function isPart(element: Element): boolean {
  return !element.firstElementChild || [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
}

// A fixed header or the inside of a scrolling box moves apart from the blank around it.
function movesApart(element: Element, root: Element): boolean {
  for (let at: Element | null = element; at && at !== root; at = at.parentElement) {
    const { position, overflowX, overflowY } = getComputedStyle(at);
    if (position === "fixed" || position === "sticky" || [overflowX, overflowY].some((value) => value === "auto" || value === "scroll")) return true;
  }
  return false;
}

// ponytail: the first 5000 parts; a bigger page falls back to the container.
function nearest(root: Element, { x, y }: Point): Element | null {
  let best: Element | null = null, distance = Infinity, seen = 0;
  for (const element of root.querySelectorAll("*")) {
    if ((seen += 1) > 5000) return null;
    if (!isPart(element)) continue;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const away = Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
    if (away < distance && getComputedStyle(element).visibility !== "hidden" && !movesApart(element, root)) { best = element; distance = away; }
  }
  return best;
}
