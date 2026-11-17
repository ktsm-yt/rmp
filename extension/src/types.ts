export type Rect = { x: number; y: number; width: number; height: number };

/** One of the page's headings and controls, numbered for Claude to point at. */
export type Part = { n: number; kind: string; text: string };

/** Claude's latest `rmp-inbox.py point` on a send: the parts to frame. */
export type PointReply = { seq: number; numbers: number[]; note: string };
export type PointResult = PointReply | null | "unsupported";

export type Annotation = {
  kind: "dom" | "range" | "text" | "pen" | "capture";
  displayNumber: number;
  comment?: string;
  text?: string;
  element?: { selector?: string; text?: string };
  image?: string;
  imageRect?: Rect;
  displayRect?: Rect;
  url?: string;
  title?: string;
  // Only on the first annotation of a send (overlay/point.ts).
  parts?: Part[];
  partsTotal?: number;
};
