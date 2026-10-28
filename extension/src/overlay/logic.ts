import type { Annotation, Rect } from "../types.js";

export type Mode = "element" | "pen";
export const MODES: Mode[] = ["element", "pen"];

export function nextMode(mode: Mode, step = 1): Mode {
  return MODES[(MODES.indexOf(mode) + step + MODES.length) % MODES.length] ?? "element";
}

export function selectMark(selected: number[], number: number, extend: boolean): number[] {
  return extend ? (selected.includes(number) ? selected : [...selected, number]) : [number];
}

export function keyAction(event: {
  key: string;
  metaKey: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  isComposing: boolean;
  keyCode: number;
  isTrusted: boolean;
  inComment: boolean;
  /** Focus is in a page input, textarea or contenteditable (not ours). */
  editing?: boolean;
  /** A mark is selected (its comment may be closed). */
  selected?: boolean;
  listOpen: boolean;
  /** The pen (📷) is on: Enter / Esc / ⌘Z belong to it. */
  drawing?: boolean;
}): "list" | "save" | "send" | "mode" | "mode-back" | "cancel" | "delete" | "pen-finish" | "pen-undo" | "pen-cancel" | null {
  if (!event.isTrusted || event.isComposing || event.keyCode === 229) return null;
  const command = event.metaKey || event.ctrlKey === true;
  if (event.listOpen && (["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(event.key) ||
      (/^[0-9]$/.test(event.key) && !command))) return "list";
  if (event.key === "Enter" && command) return "send";
  if (event.key === "Enter" && event.inComment && !event.shiftKey) return "save";
  if (event.drawing && !event.inComment && !event.editing) {
    if (event.key === "Enter") return "pen-finish";
    if (event.key === "Escape") return "pen-cancel";
    if (event.key.toLowerCase() === "z" && command) return "pen-undo";
  }
  if (event.key === "Escape" && (event.inComment || event.selected)) return "cancel";
  if (event.inComment || event.editing) return null;
  if (event.key === "Tab") return event.shiftKey ? "mode-back" : "mode";
  if ((event.key === "Delete" || event.key === "Backspace") && event.selected) return "delete";
  return null;
}

export function selectorFor(element: Element): string {
  if (element.id) return `#${escapeId(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    if (current.id) {
      parts.unshift(`#${escapeId(current.id)}`);
      break;
    }
    let index = 1;
    for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.tagName === current.tagName) index += 1;
    }
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function escapeId(id: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function documentRect(rect: { left: number; top: number; width: number; height: number }): Rect {
  return { x: rect.left + scrollOffset("x"), y: rect.top + scrollOffset("y"), width: rect.width, height: rect.height };
}

export function rangeText(rect: Rect, elements: Iterable<Element>, limit = 500): string {
  const words: string[] = [];
  const intersects = (box: DOMRect) => {
    const x = box.left + scrollOffset("x"), y = box.top + scrollOffset("y");
    return box.width > 0 && box.height > 0 && x + box.width >= rect.x &&
      x <= rect.x + rect.width && y + box.height >= rect.y && y <= rect.y + rect.height;
  };
  for (const element of elements) {
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    }
    if (!intersects(element.getBoundingClientRect())) continue;
    // Read direct text nodes so ancestors cannot pull in text outside the rectangle.
    for (const node of element.childNodes) {
      if (node.nodeType !== 3 || !node.textContent?.trim()) continue;
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(node);
      if (intersects(range.getBoundingClientRect())) words.push(node.textContent.replace(/\s+/g, " ").trim());
    }
    if (words.join(" ").length >= limit) break;
  }
  return words.join(" ").slice(0, limit);
}

// The PDF viewer scrolls its own container instead of the window; it names that container here.
export function scrollOffset(axis: "x" | "y"): number {
  if (typeof window === "undefined") return 0;
  const root = (window as Window & { __rmpScrollRoot?: Element }).__rmpScrollRoot;
  return axis === "x" ? window.scrollX + (root?.scrollLeft ?? 0) : window.scrollY + (root?.scrollTop ?? 0);
}

export function newAnnotation(
  annotations: Annotation[],
  annotation: Omit<Annotation, "displayNumber" | "url" | "title">,
): Annotation {
  return { ...annotation, displayNumber: annotations.length + 1, url: location.href, title: document.title };
}

export type Clock = {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

export class DraftDebouncer {
  private handle: ReturnType<typeof setTimeout> | undefined;
  private running = Promise.resolve();

  constructor(private readonly clock: Clock, private readonly write: (annotations: Annotation[]) => Promise<void>) {}

  schedule(annotations: Annotation[]): void {
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
    const snapshot = annotations.map((annotation) => ({
      ...annotation,
      element: annotation.element && { ...annotation.element },
      imageRect: annotation.imageRect && { ...annotation.imageRect },
    }));
    this.handle = this.clock.setTimeout(() => {
      this.handle = undefined;
      void this.queue(snapshot);
    }, 300);
  }

  clear(): Promise<void> {
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
    this.handle = undefined;
    return this.queue([]);
  }

  private queue(annotations: Annotation[]): Promise<void> {
    this.running = this.running.then(() => this.write(annotations)).catch(() => {});
    return this.running;
  }
}

export function startTicketWatch(
  ticket: string,
  status: (ticket: string) => Promise<"new" | "read" | "missing" | null>,
  onRead: () => void,
  onPendingNew: () => void,
  clock: Clock = window,
): () => void {
  let stopped = false;
  const handles: ReturnType<typeof setTimeout>[] = [];
  const later = (callback: () => void, ms: number) => handles.push(clock.setTimeout(callback, ms));
  const stop = () => {
    stopped = true;
    handles.forEach((handle) => clock.clearTimeout(handle));
  };
  const readStatus = async () => {
    try { return await status(ticket); }
    catch { return null; }
  };
  const check = async () => {
    if (stopped) return;
    const result = await readStatus();
    if (stopped) return;
    if (result === "read") { stop(); onRead(); }
    else later(() => void check(), 3000);
  };
  later(() => void check(), 3000);
  later(() => {
    if (stopped) return;
    void readStatus().then((result) => {
      if (stopped) return;
      if (result === "read") { stop(); onRead(); }
      else if (result === "new") onPendingNew();
    });
  }, 60_000);
  later(stop, 600_000);
  return stop;
}

export function startDeliveryWatch(
  ticket: string,
  route: string,
  status: (ticket: string) => Promise<"new" | "read" | "missing" | null>,
  onRead: () => void,
  copyText: (text: string, success: string) => Promise<void> | void,
  clock: Clock = window,
): () => void {
  return startTicketWatch(ticket, status, onRead, () => {
    if (route === "pending") void copyText(`/rmp ${ticket}`, "手で: 未読のためコピーしました");
  }, clock);
}

// Why rmv did not type /rmp into the target (its 409 / 403 / 404 reason), so a manual copy says what to fix.
const MANUAL_WHY: Record<string, string> = {
  draft: "宛先の入力欄に書きかけがある",
  permission_pending: "宛先が許可か質問の返事を待っている",
  stale: "宛先の端末で別の会話が開かれている",
  unverified: "宛先の今の会話か入力欄を確かめられない",
  not_live: "宛先の端末が閉じているか動いていない",
  not_enabled: "rmv がこの拡張からの打ち込みを受け付けていない",
  unknown_session: "rmv がこの会話を知らない",
  rmv_unreachable: "rmv が動いていない",
  rmv_error: "rmv がエラーを返した",
};

export function manualToast(deliver?: string): string {
  const why = deliver ? MANUAL_WHY[deliver] : undefined;
  return why ? `手で: ${why}ためコピーしました` : "手で: コピーしました";
}
