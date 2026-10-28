export type Rect = { x: number; y: number; width: number; height: number };

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
};
