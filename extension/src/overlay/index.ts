import type { InboxSendResult, TargetList } from "../inboxSend";
import type { Annotation, Rect } from "../types";
import {
  DraftDebouncer, documentRect, keyAction, manualToast, newAnnotation, nextMode, rangeText, scrollOffset,
  selectMark, selectorFor, startDeliveryWatch, type Mode,
} from "./logic";

type SendReply = { kind: "pick"; list: TargetList } |
  { kind: "sent"; result: InboxSendResult; route: "now" | "next" | "manual" | "pending" };
const modeName: Record<Mode, string> = { element: "要素", pen: "📷" };
const modeHint: Record<Mode, string> = {
  element: "クリックで注釈 · 文字をなぞると文字に注釈 · 余白か ⌥ でドラッグして囲む · ⌘ で細かく · Shift で複数",
  pen: "描いて Enter · 描かずに Enter で全体 · ⌘Z 戻す · Esc 消す",
};
// Clicking a bold word or link inside a paragraph marks the paragraph (⌘ still picks the smallest element).
const BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dt,dd,figcaption";
const routeName = (route: string) => route === "now" ? "今すぐ" : route === "next" ? "次の入力" : "手で";
type Point = { x: number; y: number };
// Drawn icons, not text glyphs: ↶ came out thin and small in some fonts.
const ICONS = {
  undo: '<path d="M9 5 4 10l5 5"/><path d="M4 10h10a5 5 0 0 1 0 10h-3"/>',
  done: '<path d="m5 12 5 5 9-10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // The modes are drawn too: the 📷 emoji came out in colour beside these.
  pick: '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z"/>',
  shot: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (name: keyof typeof ICONS, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
// The pen: box / arrow / line, 3 colours (the idea after Orca's markup tool, MIT; no Orca code).
type PenTool = "rect" | "arrow" | "pen";
type PenShape = { tool: PenTool; color: string; points: Point[] };
const PEN_TOOLS: [PenTool, string][] = [["rect", "四角"], ["arrow", "矢印"], ["pen", "手描き"]];
const PEN_COLORS = ["#e5484d", "#f5a623", "#1f6fd6"];
type ViewerRangeImage = { image: string; imageRect: Rect };
type Screenshot = { image: string; imageRect?: Rect };

async function request<T>(message: object): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

class Overlay {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "open" });
  private readonly toolbar = document.createElement("div");
  private readonly layer = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly elements = new Map<Annotation, Element>();
  private annotations: Annotation[] = [];
  private selected: number[] = [];
  private editor: HTMLTextAreaElement | null = null;
  private card: HTMLElement | null = null;
  private mode: Mode = "element";
  private dragStart: Point | null = null;
  // A press that moved 4px draws a range instead of marking the element; the click that follows is dropped.
  private dragging = false;
  private dragged = false;
  // The press was on a character (and ⌥ was not held), so the drag selects text from here instead of drawing a range.
  // The selection is set by hand: the browser's own would follow Shift into the open comment and steal its focus.
  private selectFrom: CaretPosition | null = null;
  // The first press after a 📷 mark only closes its still-open comment (a stray click made an element mark).
  private leftPen = false;
  // Where the pen bar was dragged to (it is built again on every render); null keeps it at the bottom centre.
  private penBarAt: Point | null = null;
  private pointer: { x: number; y: number } | null = null;
  // Shapes in document px: `shapes` wait for Enter, `inks` stay drawn with the mark they became.
  private drawing: PenShape | null = null;
  private shapes: PenShape[] = [];
  private readonly inks = new Map<Annotation, PenShape[]>();
  // 📷 stills the page: the screen taken on entering is laid over it, and the pen draws on that.
  private readonly still = document.createElement("img");
  private shot: Screenshot | null = null;
  private penTool: PenTool = "rect";
  private penColor = PEN_COLORS[0]!;
  private list: TargetList | undefined;
  private picked: { sid: string | null } | undefined;
  // Only the list a ⌘Enter opened ("which session?") sends on a pick; picking from the chip just sets the destination,
  // so more marks can still be added before sending.
  private sendOnPick = false;
  private readonly watches = new Set<() => void>();
  private sending = false;
  private capturing = false;
  private tabId: number | undefined;
  private initializing: Promise<void> | undefined;
  active = false;
  private readonly drafts = new DraftDebouncer(window, async (annotations) => {
    try {
      await request({ type: "rmp:draft", url: location.href, title: document.title, annotations });
    } catch {
      this.toast("下書きを保存できませんでした。受信箱を確認してください");
    }
  });

  constructor() {
    this.host.id = "rmp-overlay-root";
    this.shadow.innerHTML = `<style>
      :host{all:initial!important;position:static!important}
      *,*::before,*::after{box-sizing:border-box}
      button,textarea,span,strong{font:13px/1.4 system-ui,-apple-system,"Hiragino Sans",sans-serif}
      button{cursor:pointer;border:1px solid #e4e4e7;border-radius:8px;padding:6px 11px;background:#fff;color:#18181b;white-space:nowrap}
      button:hover{background:#f4f4f5}
      button:focus-visible,textarea:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}
      button:disabled{opacity:.6;cursor:wait}
      .rmp-primary{background:#18181b;border-color:#18181b;color:#fff;font-weight:600}
      .rmp-primary:hover{background:#3f3f46}
      .rmp-danger{color:#be123c;border-color:#fecdd3}
      .rmp-danger:hover{background:#fff1f2}
      .rmp-toolbar{position:fixed;z-index:2147483647;top:calc(var(--rmp-top,0px) + 12px);right:12px;display:flex;gap:8px;align-items:center;padding:7px 8px 7px 14px;background:#fff;color:#18181b;border:1px solid #e4e4e7;border-radius:14px;box-shadow:0 6px 24px #0000001f,0 1px 3px #00000014;max-width:calc(100vw - 24px)}
      .rmp-toolbar>*{flex:none}
      .rmp-state{display:flex;align-items:center;gap:8px;font-weight:600;cursor:default;white-space:nowrap}
      .rmp-state::before{content:"";width:9px;height:9px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 4px #e5484d2e}
      .rmp-modes{display:flex;gap:2px;padding:3px;background:#f4f4f5;border-radius:10px}
      .rmp-modes button{border:0;background:transparent;padding:5px 11px;color:#52525b}
      .rmp-modes button[aria-pressed=true]{background:#fff;color:#18181b;font-weight:600;box-shadow:0 1px 3px #0000002e}
      .rmp-count{color:#52525b;white-space:nowrap;min-width:3.6em}
      .rmp-toolbar>.rmp-chip{flex:0 1 auto;min-width:0}
      .rmp-chip{background:#fff1f2;color:#be123c;border-color:#fecdd3;font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis}
      .rmp-chip:hover{background:#ffe4e6}
      .rmp-list{position:fixed;z-index:2147483647;top:calc(var(--rmp-top,0px) + 68px);right:12px;width:min(380px,calc(100vw - 24px));max-height:65vh;overflow:auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:6px;box-shadow:0 8px 28px #00000029;color:#18181b;font:13px system-ui,sans-serif}
      .rmp-list p{margin:6px 8px;color:#52525b}
      .rmp-list button{display:block;width:100%;margin:2px 0;text-align:left;border-color:transparent;white-space:normal}
      .rmp-list button:hover,.rmp-list button:focus{background:#fff1f2}
      .rmp-frame,.rmp-hover{position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #e5484d;border-radius:4px;background:#e5484d14}
      .rmp-frame.on{background:#e5484d29;box-shadow:0 0 0 3px #e5484d33}
      .rmp-hover{border-style:dashed;background:#e5484d0d}
      .rmp-mark{position:fixed;z-index:2147483646;border:2px solid #fff;padding:0;color:#fff;background:#e5484d;border-radius:50%;width:24px;height:24px;font:600 12px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px #00000040}
      .rmp-mark:hover{background:#dc2626}
      .rmp-mark[aria-pressed=true]{box-shadow:0 0 0 3px #e5484d59,0 1px 4px #00000040}
      .rmp-card{position:fixed;z-index:2147483647;width:320px;max-width:calc(100vw - 16px);padding:12px;background:#fff;color:#18181b;border:1px solid #e4e4e7;border-radius:14px;box-shadow:0 10px 32px #00000029,0 1px 3px #00000014}
      .rmp-card-head,.rmp-card-foot{display:flex;align-items:center;gap:8px}
      .rmp-card-head{margin-bottom:8px}
      .rmp-card-head .rmp-badge{min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#e5484d;color:#fff;font:600 12px/22px system-ui,sans-serif;text-align:center}
      .rmp-card-head strong{font-weight:600}
      .rmp-keys,.rmp-card-foot span{margin-right:auto;color:#71717a;font-size:12px}
      .rmp-card-head .rmp-keys{margin:0 0 0 auto}
      .rmp-card textarea{display:block;width:100%;min-height:64px;padding:8px 10px;border:1px solid #e4e4e7;border-radius:10px;background:#fafafa;color:#18181b;resize:vertical}
      .rmp-card textarea:focus{outline:none;border-color:#e5484d;background:#fff;box-shadow:0 0 0 3px #e5484d26}
      .rmp-card-foot{margin-top:10px}
      .rmp-toasts{position:fixed;z-index:2147483647;right:12px;bottom:12px;display:flex;flex-direction:column;align-items:end;gap:6px;max-width:calc(100vw - 24px)}
      .rmp-toast{max-width:100%;padding:10px 14px;background:#18181b;color:#fff;border-radius:10px;box-shadow:0 6px 20px #00000033;font:13px system-ui,sans-serif;white-space:pre-wrap}
      .rmp-toast button{margin-left:8px}
      /* A canvas sizes itself by its pixels (2x on Retina), so pin it to the window. */
      .rmp-canvas{position:fixed;inset:0;width:100%;height:100%;z-index:2147483644;pointer-events:none}
      .rmp-still{position:fixed;inset:0;width:100%;height:100%;z-index:2147483643;pointer-events:none}
      .rmp-close{border:0;background:transparent;color:#71717a;font-size:16px;line-height:1;padding:4px 6px}
      .rmp-penbar .rmp-close{color:#a1a1aa}
      .rmp-canvas.pen{pointer-events:auto;cursor:crosshair;touch-action:none}
      .rmp-toolbar,.rmp-penbar{cursor:grab}
      button svg{display:block}
      .rmp-penbar{position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);display:flex;gap:4px;align-items:center;padding:6px;background:#18181bf0;border-radius:12px;box-shadow:0 6px 20px #0000004d;max-width:calc(100vw - 24px);flex-wrap:wrap}
      .rmp-penbar button{border-color:transparent;background:transparent;color:#e4e4e7;padding:5px 10px}
      .rmp-penbar button:hover{background:#3f3f46}
      .rmp-penbar button[aria-pressed=true]{border-color:#e4e4e7;color:#fff}
      .rmp-penbar .rmp-swatch{width:22px;height:22px;margin:0 2px;padding:0;border-radius:50%;border:2px solid #18181b}
      .rmp-penbar .rmp-swatch[aria-pressed=true]{box-shadow:0 0 0 2px #fff}
      .rmp-penbar .rmp-primary{background:#e5484d;color:#fff}
    </style>`;
    this.toolbar.className = "rmp-toolbar";
    this.toolbar.setAttribute("role", "toolbar");
    this.toolbar.setAttribute("aria-label", "赤入れ");
    this.canvas.className = "rmp-canvas";
    this.draggable(this.toolbar, () => undefined);
    this.still.className = "rmp-still";
    this.shadow.append(this.canvas, this.layer, this.toolbar);
    document.addEventListener("mousemove", (event) => this.onMove(event), true);
    document.addEventListener("mousedown", (event) => this.onDown(event), true);
    document.addEventListener("click", (event) => this.onClick(event), true);
    document.addEventListener("mouseup", (event) => this.onUp(event), true);
    document.addEventListener("keydown", (event) => this.onKey(event), true);
    document.addEventListener("keyup", (event) => this.onCommandKey(event, false), true);
    addEventListener("scroll", () => {
      if (this.active) { this.hideHover(); this.renderMarks(); this.renderStrokes(); }
    }, true);
    addEventListener("resize", () => { if (this.active) { this.resizeCanvas(); this.renderMarks(); } });
    this.canvas.addEventListener("pointerdown", (event) => this.startPen(event));
    this.canvas.addEventListener("pointermove", (event) => this.drawPen(event));
    this.canvas.addEventListener("pointerup", (event) => this.endShape(event));
    this.canvas.addEventListener("pointercancel", (event) => this.endShape(event));
    // The page is a still while the pen is on; scrolling it would slide the strokes off the picture.
    // ponytail: wheel only; arrow keys / Space can still scroll the page under the still.
    this.canvas.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
  }

  private run(action: () => Promise<unknown>): void {
    void action().catch((error) => this.toast(error instanceof Error ? error.message : "処理できませんでした"));
  }

  async activate(): Promise<void> {
    if (this.active) return;
    this.active = true;
    document.documentElement.append(this.host);
    this.renderToolbar();
    this.resizeCanvas();
    // Back from hide(): the marks not yet sent are still here.
    this.renderMarks();
    this.renderStrokes();
    this.initializing = request<{ tabId: number; list: TargetList }>({ type: "rmp:init", url: location.href }).then((reply) => {
      this.tabId = reply.tabId;
      this.list = reply.list;
      this.renderToolbar();
    });
    await this.initializing;
  }

  // The shortcut / toolbar button only hides the bar so the page can be used; × in the bar is what drops the marks.
  // ponytail: kept in memory, so a reload or another page loses them (the draft in the inbox stays).
  hide(): void {
    // Strokes not yet made into a mark are dropped, as with Esc.
    if (this.mode === "pen") { this.shapes = []; this.setMode("element"); }
    this.saveComment(true);
    this.active = false;
    this.dragStart = null;
    this.dragging = false;
    this.selectFrom = null;
    this.shadow.querySelector(".rmp-list")?.remove();
    this.hideHover();
    this.host.remove();
  }

  async close(): Promise<void> {
    this.active = false;
    this.mode = "element";
    this.canvas.classList.remove("pen");
    this.unfreeze();
    this.saveComment(true);
    this.annotations = [];
    this.selected = [];
    this.elements.clear();
    this.shapes = [];
    this.inks.clear();
    this.drawing = null;
    this.dragStart = null;
    this.dragging = false;
    for (const stop of this.watches) stop();
    this.watches.clear();
    this.shadow.querySelector(".rmp-list")?.remove();
    this.hideHover();
    this.layer.replaceChildren();
    this.host.remove();
    await this.drafts.clear();
  }

  async replaceDocument(): Promise<void> {
    this.annotations = [];
    this.selected = [];
    this.elements.clear();
    this.shapes = [];
    this.inks.clear();
    this.drawing = null;
    this.dragStart = null;
    this.dragging = false;
    this.saveComment(true);
    this.renderMarks();
    this.renderStrokes();
    await this.drafts.clear();
  }

  async copyTabId(): Promise<void> {
    await this.initializing;
    if (this.tabId === undefined) throw new Error("タブ ID を取得できませんでした");
    await this.copyText(String(this.tabId), "タブ ID をコピーしました");
  }

  private isOurs(event: Event): boolean { return event.composedPath().includes(this.host); }
  private point(event: MouseEvent): Point { return { x: event.clientX + scrollOffset("x"), y: event.clientY + scrollOffset("y") }; }

  private targetAt(x: number, y: number, smallest: boolean): Element | null {
    const targets = document.elementsFromPoint(x, y).filter((element) => element !== this.host &&
      !this.host.contains(element) && element !== document.documentElement && element !== document.body);
    if (!smallest) {
      const top = targets[0];
      if (!top) return null;
      const block = getComputedStyle(top).display.startsWith("inline") ? top.closest(BLOCKS) : null;
      return block && targets.includes(block) ? block : top;
    }
    return targets.reduce<Element | null>((best, element) => {
      if (!best || best.contains(element)) return element;
      if (element.contains(best)) return best;
      const a = best.getBoundingClientRect(), b = element.getBoundingClientRect();
      return b.width * b.height < a.width * a.height ? element : best;
    }, null);
  }

  // The PDF viewer calls this when it lays the pages out again (zoom, sidebar); element marks follow by themselves.
  remap(move: (point: Point) => Point): void {
    for (const annotation of this.annotations) {
      const rect = annotation.displayRect;
      if (!rect || this.elements.has(annotation)) continue;
      const start = move({ x: rect.x, y: rect.y }), end = move({ x: rect.x + rect.width, y: rect.y + rect.height });
      annotation.displayRect = { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
    }
    for (const shape of [...[...this.inks.values()].flat(), ...this.shapes]) shape.points = shape.points.map(move);
    this.renderMarks();
    this.renderStrokes();
  }

  // PDF text comes in the fragments its maker wrote (often mid-word), so a press takes the line around it.
  // A table row is one line too (its cells are joined by plain spaces in PDFs printed from HTML); only a gap of
  // 3 line heights (columns) splits it. ⌘ still takes the one piece.
  private pdfLine(target: Element | null, smallest: boolean): { rect: Rect; text: string } | null {
    const layer = target?.closest(".textLayer");
    if (!target || !layer || target === layer || smallest) return null;
    const hit = target.getBoundingClientRect(), middle = hit.top + hit.height / 2;
    const pieces = [...layer.querySelectorAll("span")].filter((span) => !span.firstElementChild).map((span) => ({ span, box: span.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0 && box.top <= middle && middle <= box.bottom).sort((a, b) => a.box.left - b.box.left);
    const at = pieces.findIndex(({ span }) => span === target || target.contains(span));
    if (at < 0) return null;
    let first = at, last = at;
    const near = (a: DOMRect, b: DOMRect) => b.left - a.right < 3 * Math.max(a.height, b.height);
    while (first > 0 && near(pieces[first - 1]!.box, pieces[first]!.box)) first -= 1;
    while (last < pieces.length - 1 && near(pieces[last]!.box, pieces[last + 1]!.box)) last += 1;
    const line = pieces.slice(first, last + 1);
    const left = Math.min(...line.map(({ box }) => box.left)), top = Math.min(...line.map(({ box }) => box.top));
    const rect = documentRect(new DOMRect(left, top, Math.max(...line.map(({ box }) => box.right)) - left, Math.max(...line.map(({ box }) => box.bottom)) - top));
    return { rect, text: line.map(({ span }) => span.textContent ?? "").join("").replace(/\s+/g, " ").trim() };
  }

  // On a PDF page only text counts: between lines the pointer is over a layer as big as the page, which made
  // the hover box flash across the whole page.
  private elementAt(x: number, y: number, smallest: boolean): Element | null {
    const target = this.targetAt(x, y, smallest);
    return target?.closest("#viewer") && !target.closest(".textLayer span") ? null : target;
  }

  private showTargetAt(x: number, y: number, smallest: boolean): void {
    const target = this.elementAt(x, y, smallest);
    const rect = this.pdfLine(target, smallest)?.rect ?? (target && documentRect(target.getBoundingClientRect()));
    if (rect) this.showHover(rect);
    else this.hideHover();
  }

  private onMove(event: MouseEvent): void {
    if (!this.active || this.isOurs(event) || this.sending) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    const start = this.dragStart, point = this.point(event);
    if (start && !this.dragging && Math.hypot(point.x - start.x, point.y - start.y) >= 4) this.dragging = true;
    if (this.mode === "element" && start && this.dragging) {
      const from = this.selectFrom, to = from && document.caretPositionFromPoint(event.clientX, event.clientY);
      if (from && to) getSelection()?.setBaseAndExtent(from.offsetNode, from.offset, to.offsetNode, to.offset);
      if (from) this.hideHover();
      else this.showHover(rectBetween(start, point));
    } else if (this.mode === "element") {
      this.showTargetAt(event.clientX, event.clientY, event.metaKey || event.ctrlKey);
    }
  }

  private onDown(event: MouseEvent): void {
    if (!event.isTrusted || !this.active || this.isOurs(event) || this.sending || event.button !== 0) return;
    this.dragged = false;
    const strayAfterPen = this.leftPen && Boolean(this.card);
    this.leftPen = false;
    if (this.mode === "element" && strayAfterPen) {
      this.dragged = true;
      event.preventDefault();
      this.saveComment(true);
      return;
    }
    if (this.mode === "element") {
      // Keep an open comment focused when Shift adds another element.
      event.preventDefault();
      this.selectFrom = event.altKey ? null : textAt(event.clientX, event.clientY);
      this.dragStart = this.point(event);
    }
  }

  private onClick(event: MouseEvent): void {
    if (!event.isTrusted || !this.active || this.isOurs(event) || this.mode !== "element" || this.sending || event.button !== 0) return;
    if (this.dragged) { this.dragged = false; event.preventDefault(); event.stopImmediatePropagation(); return; }
    const smallest = event.metaKey || event.ctrlKey;
    const target = this.elementAt(event.clientX, event.clientY, smallest);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const line = this.pdfLine(target, smallest);
    if (line) {
      const same = (a: Rect, b: Rect) => [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every((d) => Math.abs(d) < 1);
      const existing = this.annotations.find((a) => a.kind === "text" && a.displayRect && same(a.displayRect, line.rect));
      if (existing) this.focusMark(existing, event.shiftKey);
      else this.add({ kind: "text", text: line.text, imageRect: line.rect, displayRect: { ...line.rect } }, event.shiftKey);
      return;
    }
    // A second click on an already marked element opens that mark's comment instead of adding a duplicate.
    const existing = this.annotations.find((a) => this.elements.get(a) === target);
    if (existing) { this.focusMark(existing, event.shiftKey); return; }
    const annotation = this.add({ kind: "dom", element: { selector: selectorFor(target), text: visibleText(target) },
      imageRect: documentRect(target.getBoundingClientRect()) }, event.shiftKey);
    if (annotation) this.elements.set(annotation, target);
  }

  private onUp(event: MouseEvent): void {
    if (!event.isTrusted || event.button !== 0) return;
    const dragStart = this.dragging ? this.dragStart : null;
    const selecting = Boolean(this.selectFrom);
    this.dragStart = null;
    this.dragging = false;
    this.selectFrom = null;
    if (!this.active || this.isOurs(event) || this.sending) return;
    // Nothing got selected (the page forbids it): the drag falls back to a range.
    if (this.mode === "element" && dragStart && selecting && this.addSelection(event.shiftKey)) {
      this.dragged = true;
      this.hideHover();
    } else if (this.mode === "element" && dragStart) {
      this.dragged = true;
      const rect = rectBetween(dragStart, this.point(event));
      if (rect.width > 2 && rect.height > 2) {
        const viewerRangeImage = (window as Window & {
          __rmpViewerRangeImage?: (displayRect: Rect) => ViewerRangeImage;
        }).__rmpViewerRangeImage;
        const image = viewerRangeImage?.(rect);
        this.add({ kind: "range", displayRect: rect, image: image?.image, imageRect: image?.imageRect ?? rect,
          text: rangeText(rect, document.querySelectorAll("body *")) }, event.shiftKey);
      }
      this.hideHover();
    }
  }

  private addSelection(extend: boolean): boolean {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.toString().trim()) return false;
    const rect = documentRect(selection.getRangeAt(0).getBoundingClientRect());
    this.add({ kind: "text", text: selection.toString().trim().slice(0, 1000), imageRect: rect, displayRect: { ...rect } }, extend);
    selection.removeAllRanges();
    return true;
  }

  // Pressing or releasing ⌘ / Ctrl switches the hover box without moving the mouse.
  private onCommandKey(event: KeyboardEvent, down: boolean): void {
    if (!this.active || this.mode !== "element" || !this.pointer || this.sending ||
        (event.key !== "Meta" && event.key !== "Control")) return;
    this.showTargetAt(this.pointer.x, this.pointer.y, down);
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.active) return;
    this.onCommandKey(event, true);
    const target = event.composedPath()[0];
    const inComment = target === this.editor;
    const editing = target instanceof HTMLElement && !this.isOurs(event) &&
      (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);
    const action = keyAction({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
      isComposing: event.isComposing, keyCode: event.keyCode, isTrusted: event.isTrusted, inComment, editing,
      selected: this.selected.length > 0, listOpen: Boolean(this.shadow.querySelector(".rmp-list")),
      drawing: this.mode === "pen" });
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action === "list") { this.handleListKey(event); return; }
    if (this.sending) return;
    if (action === "mode" || action === "mode-back") this.setMode(nextMode(this.mode, action === "mode" ? 1 : -1));
    else if (action === "save") this.saveComment(true);
    else if (action === "cancel") this.cancel();
    else if (action === "delete") this.deleteSelected();
    else if (action === "pen-finish") this.run(() => this.finishPen(true));
    else if (action === "pen-undo") { this.shapes.pop(); this.renderStrokes(); }
    else if (action === "pen-cancel") this.cancelPen();
    else if (action === "send") { this.saveComment(true); this.run(() => this.send()); }
  }

  private setMode(mode: Mode): void {
    // Leaving the pen keeps what was drawn as a mark.
    if (this.mode === "pen" && mode !== "pen") this.run(async () => { await this.finishPen(); this.unfreeze(); });
    const entering = this.mode !== "pen" && mode === "pen";
    if (mode !== this.mode) this.leftPen = false;
    this.mode = mode;
    this.hideHover();
    this.renderToolbar();
    this.canvas.classList.toggle("pen", mode === "pen");
    // After the pen bar is up, so the screenshot hides it too.
    if (entering) this.run(() => this.freeze());
  }

  private add(value: Omit<Annotation, "displayNumber" | "url" | "title">, extend = false): Annotation | null {
    if (this.sending || !this.active) return null;
    if (this.annotations.length >= 200) { this.toast("注釈は200件までです。送ってから追加してください"); return null; }
    this.saveComment(!extend);
    const annotation = newAnnotation(this.annotations, value);
    this.annotations.push(annotation);
    this.selected = selectMark(this.selected, annotation.displayNumber, extend);
    if (extend && this.editor) this.updateComment();
    else this.openComment(annotation);
    this.renderMarks();
    this.drafts.schedule(this.annotations);
    return annotation;
  }

  private renderMarks(): void {
    this.layer.replaceChildren();
    for (const annotation of this.annotations) {
      const element = this.elements.get(annotation);
      const rect = element?.isConnected ? documentRect(element.getBoundingClientRect()) : annotation.displayRect ?? annotation.imageRect;
      if (!rect) continue;
      const on = this.selected.includes(annotation.displayNumber);
      const frame = document.createElement("div");
      frame.className = on ? "rmp-frame on" : "rmp-frame";
      position(frame, rect);
      const mark = document.createElement("button");
      mark.className = "rmp-mark";
      mark.textContent = String(annotation.displayNumber);
      mark.setAttribute("aria-label", `注釈 ${annotation.displayNumber} のコメント`);
      mark.setAttribute("aria-pressed", String(on));
      // The badge sits in the left margin so it does not cover the first character.
      const left = rect.x - scrollOffset("x");
      mark.style.left = `${left >= 30 ? left - 30 : left + 3}px`;
      mark.style.top = `${rect.y - scrollOffset("y") + (left >= 30 ? 0 : 3)}px`;
      mark.onclick = (event) => {
        if (!event.isTrusted || this.sending) return;
        this.focusMark(annotation, event.shiftKey);
      };
      this.layer.append(frame, mark);
    }
    const count = this.shadow.querySelector(".rmp-count");
    if (count) count.textContent = `注釈 ${this.annotations.length}`;
    this.positionEditor();
  }

  private focusMark(annotation: Annotation, extend: boolean): void {
    this.saveComment(!extend);
    this.selected = selectMark(this.selected, annotation.displayNumber, extend);
    if (this.editor && extend) this.updateComment();
    else this.openComment(annotation);
    this.renderMarks();
  }

  private openComment(annotation: Annotation): void {
    if (this.editor) this.saveComment(true);
    const card = document.createElement("div");
    card.className = "rmp-card";
    card.setAttribute("role", "group");
    const head = document.createElement("div");
    head.className = "rmp-card-head";
    head.innerHTML = `<span class="rmp-badge"></span><strong></strong><span class="rmp-keys">Enter で保存 · Esc で閉じる</span>`;
    const foot = document.createElement("div");
    foot.className = "rmp-card-foot";
    const newline = document.createElement("span");
    newline.textContent = "Shift+Enter で改行";
    const remove = this.button("削除", async () => this.deleteSelected());
    remove.classList.add("rmp-danger");
    const save = this.button("保存", async () => this.saveComment(true));
    save.classList.add("rmp-primary");
    foot.append(newline, remove, save);
    const field = document.createElement("textarea");
    field.dataset.rmpComment = "true";
    field.setAttribute("aria-label", "コメント");
    field.value = annotation.comment ?? "";
    field.addEventListener("input", (event) => { if (event.isTrusted && (!(event instanceof InputEvent) || !event.isComposing)) this.updateComment(); });
    field.addEventListener("compositionend", (event) => { if (event.isTrusted) this.updateComment(); });
    // Out of the shadow root the target is our host, not a field, so page shortcuts (GitHub's j / k) would take the key.
    for (const type of ["keydown", "keypress", "keyup"]) field.addEventListener(type, (event) => event.stopPropagation());
    this.editor = field;
    this.card = card;
    card.append(head, field, foot);
    this.shadow.append(card);
    this.positionEditor();
    field.focus({ preventScroll: true });
  }

  private positionEditor(): void {
    if (!this.card) return;
    const numbers = this.selected.join(", ");
    this.card.querySelector(".rmp-badge")!.textContent = numbers;
    this.card.querySelector("strong")!.textContent = `注釈 ${numbers}`;
    this.card.setAttribute("aria-label", `注釈 ${numbers} のコメント欄`);
    const annotation = this.annotations.find((a) => a.displayNumber === this.selected[0]);
    const element = annotation && this.elements.get(annotation);
    const rect = element?.isConnected ? documentRect(element.getBoundingClientRect()) : annotation?.displayRect ?? annotation?.imageRect;
    const x = (rect?.x ?? scrollOffset("x")) - scrollOffset("x"), top = (rect?.y ?? scrollOffset("y")) - scrollOffset("y"), bottom = top + (rect?.height ?? 0);
    const height = this.card.offsetHeight || 170;
    // Below the mark when it fits, else above it, else pinned inside the window.
    const y = bottom + 8 + height <= innerHeight ? bottom + 8 : top - 8 - height >= 70 ? top - 8 - height : innerHeight - height - 12;
    this.card.style.left = `${Math.max(8, Math.min(innerWidth - this.card.offsetWidth - 8, x))}px`;
    this.card.style.top = `${Math.max(70, y)}px`;
  }

  private updateComment(): void {
    if (!this.editor || this.sending) return;
    for (const annotation of this.annotations) {
      if (this.selected.includes(annotation.displayNumber)) annotation.comment = this.editor.value;
    }
    this.drafts.schedule(this.annotations);
  }

  private saveComment(close: boolean): void {
    this.updateComment();
    if (close && this.editor) { this.editor = null; this.card?.remove(); this.card = null; }
  }

  // Esc: close the comment and deselect; a selected mark that still has no comment is dropped.
  private cancel(): void {
    this.saveComment(true);
    const empty = this.annotations.filter((a) => this.selected.includes(a.displayNumber) && !a.comment?.trim());
    this.selected = empty.map((a) => a.displayNumber);
    if (empty.length) this.deleteSelected();
    else { this.selected = []; this.renderMarks(); }
    getSelection()?.removeAllRanges();
  }

  private deleteSelected(): void {
    if (this.sending) return;
    const gone = new Set(this.selected);
    this.editor = null; this.card?.remove(); this.card = null;
    for (const annotation of this.annotations) {
      if (gone.has(annotation.displayNumber)) { this.elements.delete(annotation); this.inks.delete(annotation); }
    }
    this.annotations = this.annotations.filter((a) => !gone.has(a.displayNumber));
    this.annotations.forEach((a, index) => { a.displayNumber = index + 1; });
    this.selected = [];
    this.renderMarks();
    this.renderStrokes();
    this.drafts.schedule(this.annotations);
  }

  private renderToolbar(): void {
    this.toolbar.replaceChildren();
    const state = document.createElement("span");
    state.className = "rmp-state";
    state.textContent = this.sending ? "送信中" : "赤入れ";
    const modes = document.createElement("div");
    modes.className = "rmp-modes";
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "モード (Tab で切り替え)");
    for (const mode of Object.keys(modeName) as Mode[]) {
      const button = this.button(modeName[mode], async () => this.setMode(mode));
      button.innerHTML = icon(mode === "pen" ? "shot" : "pick", 20);
      button.setAttribute("aria-label", mode === "pen" ? "撮影" : "要素");
      button.title = modeHint[mode];
      button.setAttribute("aria-pressed", String(mode === this.mode));
      modes.append(button);
    }
    const count = document.createElement("span");
    count.className = "rmp-count";
    count.textContent = `注釈 ${this.annotations.length}`;
    this.toolbar.append(state, modes, count);
    const destination = this.picked ? this.picked.sid :
      this.list?.decision.action === "send" ? this.list.decision.to : null;
    const option = this.list?.options.find((s) => s.sid === destination);
    const chip = this.button(option ? `宛先: ${option.label} [${routeName(option.delivery)}]` :
      this.picked?.sid === null ? "宛先なし [手で]" : "宛先を選ぶ", () => this.openTargets());
    chip.className = "rmp-chip";
    this.toolbar.append(this.button("タブ ID", () => this.copyTabId()), chip);
    const send = this.button("送る", () => this.send());
    send.classList.add("rmp-primary");
    const close = this.icon("close", "終了", () => this.close());
    close.className = "rmp-close";
    close.setAttribute("aria-label", "終了");
    this.toolbar.append(send, close);
    for (const button of this.toolbar.querySelectorAll("button")) button.disabled = this.sending;
    this.shadow.querySelector(".rmp-penbar")?.remove();
    if (this.mode === "pen") this.shadow.append(this.penBar());
  }

  // A bar moves when dragged by its background; its buttons still click.
  // ponytail: the spot is not kept in the window after a resize or across page loads.
  // The pen bar is built again on renders (even mid-drag), so the drag moves whichever bar is current.
  private draggable(bar: HTMLElement, save: (at: Point) => void, current = () => bar): void {
    bar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      event.preventDefault();
      const box = bar.getBoundingClientRect(), dx = event.clientX - box.left, dy = event.clientY - box.top;
      const move = (e: PointerEvent) => {
        const at = { x: Math.max(0, Math.min(innerWidth - box.width, e.clientX - dx)),
          y: Math.max(0, Math.min(innerHeight - box.height, e.clientY - dy)) };
        place(current(), at);
        save(at);
      };
      addEventListener("pointermove", move, true);
      addEventListener("pointerup", () => removeEventListener("pointermove", move, true), { once: true, capture: true });
    });
  }

  private penBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "rmp-penbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "ペン");
    if (this.penBarAt) place(bar, this.penBarAt);
    this.draggable(bar, (at) => { this.penBarAt = at; }, () => this.shadow.querySelector<HTMLElement>(".rmp-penbar") ?? bar);
    const pressed = (button: HTMLButtonElement, on: boolean) => { button.setAttribute("aria-pressed", String(on)); return button; };
    for (const [tool, label] of PEN_TOOLS) {
      bar.append(pressed(this.button(label, async () => { this.penTool = tool; this.renderToolbar(); }), tool === this.penTool));
    }
    for (const color of PEN_COLORS) {
      const swatch = pressed(this.button("", async () => { this.penColor = color; this.renderToolbar(); }), color === this.penColor);
      swatch.className = "rmp-swatch";
      swatch.style.background = color;
      swatch.setAttribute("aria-label", `色 ${color}`);
      bar.append(swatch);
    }
    const finish = this.icon("done", "完了", () => this.finishPen(true));
    finish.classList.add("rmp-primary");
    const cancel = this.icon("close", "やめる", async () => this.cancelPen());
    cancel.className = "rmp-close";
    bar.append(this.icon("undo", "戻す", async () => { this.shapes.pop(); this.renderStrokes(); }), finish, cancel);
    return bar;
  }

  private icon(name: keyof typeof ICONS, label: string, action: () => Promise<unknown>): HTMLButtonElement {
    const button = this.button("", action);
    button.innerHTML = icon(name);
    button.setAttribute("aria-label", label);
    return button;
  }

  private button(label: string, action: () => Promise<unknown>): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = label;
    button.onclick = (event) => { if (event.isTrusted) this.run(action); };
    return button;
  }

  private async openTargets(): Promise<void> {
    if (this.sending) return;
    this.saveComment(true);
    this.sendOnPick = false;
    this.list = await request<TargetList>({ type: "rmp:targets", url: location.href, picked: this.picked });
    if (this.active) this.renderList(this.list);
  }

  private renderList(list: TargetList): void {
    this.list = list;
    this.shadow.querySelector(".rmp-list")?.remove();
    const menu = document.createElement("div");
    menu.className = "rmp-list";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "宛先を選ぶ");
    menu.tabIndex = -1;
    if (list.decision.action === "pick") {
      const why = document.createElement("p");
      why.textContent = list.decision.message;
      menu.append(why);
    }
    for (const option of list.options) {
      const row = this.button(`${option.label} [${routeName(option.delivery)}] ${option.folder} ${option.reason ?? ""} ${option.head}`,
        () => this.pick(option.sid));
      row.dataset.sid = option.sid;
      menu.append(row);
    }
    const none = this.button("宛先なし [手で]", () => this.pick(null));
    menu.append(none);
    this.shadow.append(menu);
    const highlight = list.decision.action === "pick" ? list.decision.highlight : list.decision.to;
    const focused = highlight ? [...menu.querySelectorAll("button")].find((row) => row.dataset.sid === highlight) : null;
    (focused ?? menu).focus();
  }

  private handleListKey(event: KeyboardEvent): void {
    const menu = this.shadow.querySelector(".rmp-list");
    if (!menu) return;
    if (event.key === "Escape") { menu.remove(); return; }
    const rows = [...menu.querySelectorAll("button")];
    const index = rows.indexOf(this.shadow.activeElement as HTMLButtonElement);
    // 1-9 pick the n-th destination, 0 picks 宛先なし (the last row).
    if (/^[0-9]$/.test(event.key)) {
      const n = Number(event.key);
      const row = n === 0 ? rows.length - 1 : n - 1 < rows.length - 1 ? n - 1 : -1;
      if (row >= 0) { const sid = rows[row]?.dataset.sid ?? null; this.run(() => this.pick(sid)); }
      return;
    }
    const back = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey);
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Tab") {
      const next = index < 0 ? (back ? rows.length - 1 : 0) : (index + (back ? -1 : 1) + rows.length) % rows.length;
      rows[next]?.focus();
    } else if (event.key === "Enter" && index >= 0) {
      const sid = rows[index]?.dataset.sid ?? null;
      this.run(() => this.pick(sid));
    }
  }

  private async pick(sid: string | null): Promise<void> {
    this.shadow.querySelector(".rmp-list")?.remove();
    this.picked = { sid };
    this.renderToolbar();
    const send = this.sendOnPick;
    this.sendOnPick = false;
    if (send && this.annotations.length) return this.send();
    await request({ type: "rmp:pick", url: location.href, sid });
    if (this.annotations.length) this.toast("宛先を決めました。⌘Enter か『送る』で送ります");
  }

  private async send(): Promise<void> {
    if (this.sending || this.capturing) return;
    await this.finishPen();
    this.saveComment(true);
    if (!this.annotations.length) { this.toast("注釈を付けてから送ってください"); return; }
    this.sending = true;
    this.renderToolbar();
    try {
      const annotations = this.annotations.map(({ displayRect: _displayRect, ...annotation }) => annotation);
      const reply = await request<SendReply>({ type: "rmp:send", url: location.href,
        annotations, picked: this.picked });
      if (reply.kind === "pick") { this.sendOnPick = true; if (this.active) this.renderList(reply.list); return; }
      if (!reply.result.ok) {
        this.toast(reply.result.reason === "inbox_timeout" ?
          "届いたか分からない。/rmp で確かめてから送り直す" : "送信できませんでした。注釈は残しています");
        return;
      }
      this.annotations = [];
      this.selected = [];
      this.elements.clear();
      this.inks.clear();
      this.renderMarks();
      this.renderStrokes();
      const ticket = reply.result.ticket;
      if (reply.route === "manual" && ticket) await this.copyText(`/rmp ${ticket}`, manualToast(reply.result.deliver));
      else this.toast(reply.route === "now" ? "今すぐ: 届けました" : reply.route === "next" ?
        "次の入力で知らせます" : reply.route === "pending" ? "配送の返事を待っています。60秒後に未読なら手で届けられます" : "受信箱に保存しました");
      await this.drafts.clear();
      if (ticket && this.active) {
        const stop = startDeliveryWatch(ticket, reply.route, (value) => request({ type: "rmp:status", ticket: value }),
          () => this.toast("読まれた"), (text, success) => this.copyText(text, success));
        this.watches.add(stop);
      }
    } finally {
      this.sending = false;
      this.renderToolbar();
    }
  }

  private async screenshot(): Promise<Screenshot> {
    const hidden = [...this.shadow.querySelectorAll<HTMLElement>(".rmp-toolbar,.rmp-penbar,.rmp-list,.rmp-card,.rmp-toast,.rmp-hover")];
    for (const element of hidden) element.style.visibility = "hidden";
    try {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const viewerCapture = (window as Window & { __rmpViewerCapture?: () => Promise<Screenshot> }).__rmpViewerCapture;
      return viewerCapture ? await viewerCapture() : await request<Screenshot>({ type: "rmp:capture" });
    } finally { for (const element of hidden) element.style.visibility = ""; }
  }

  private async freeze(): Promise<void> {
    if (this.capturing || this.sending || !this.active) return;
    this.capturing = true;
    try {
      const shot = await this.screenshot();
      if (this.mode !== "pen" || !this.active) return;
      this.shot = shot;
      this.still.src = shot.image;
      this.shadow.prepend(this.still);
    } catch { this.toast("撮影できませんでした。動いている画面に描きます"); }
    finally { this.capturing = false; }
  }
  private unfreeze(): void { this.still.remove(); this.still.removeAttribute("src"); this.shot = null; }
  // Esc / やめる: drop the strokes, or leave the still when nothing is drawn.
  private cancelPen(): void {
    if (this.shapes.length) { this.shapes = []; this.renderStrokes(); }
    else this.setMode("element");
  }

  private async copyText(text: string, success: string, fallback?: HTMLElement): Promise<void> {
    try { await navigator.clipboard.writeText(text); fallback?.remove(); this.toast(success); }
    catch { if (!fallback) this.toast(`手で: ${text}`, text); }
  }

  private toast(text: string, copy?: string): void {
    const host = this.shadow.querySelector<HTMLElement>(".rmp-toasts") ?? document.createElement("div");
    if (!host.isConnected) { host.className = "rmp-toasts"; this.shadow.append(host); }
    host.querySelector(".rmp-toast:not([data-rmp-ticket])")?.remove();
    const toast = document.createElement("div");
    toast.className = "rmp-toast";
    toast.setAttribute("role", "status");
    toast.textContent = text;
    if (copy) {
      toast.dataset.rmpTicket = "true";
      toast.append(this.button("コピー", () => this.copyText(copy, "コピーしました", toast)),
        this.button("閉じる", async () => { toast.remove(); }));
    }
    host.append(toast);
    if (!copy) setTimeout(() => toast.remove(), 7000);
  }

  private showHover(rect: Rect): void {
    let outline = this.shadow.querySelector<HTMLElement>(".rmp-hover");
    if (!outline) { outline = document.createElement("div"); outline.className = "rmp-hover"; this.shadow.append(outline); }
    position(outline, rect);
  }
  private hideHover(): void { this.shadow.querySelector(".rmp-hover")?.remove(); }
  private resizeCanvas(): void {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.renderStrokes();
  }

  private startPen(event: PointerEvent): void {
    if (!event.isTrusted || !this.active || this.mode !== "pen" || this.sending || this.capturing || event.button !== 0) return;
    this.saveComment(true);
    const point = this.point(event);
    this.drawing = { tool: this.penTool, color: this.penColor, points: [point, point] };
    this.canvas.setPointerCapture(event.pointerId);
  }
  private drawPen(event: PointerEvent): void {
    if (!event.isTrusted || !this.drawing) return;
    const point = this.point(event);
    if (this.drawing.tool === "pen") this.drawing.points.push(point);
    else this.drawing.points = [this.drawing.points[0]!, point];
    this.renderStrokes();
  }
  private endShape(event: PointerEvent): void {
    if (!event.isTrusted || !this.drawing) return;
    this.shapes.push(this.drawing);
    this.drawing = null;
    this.renderStrokes();
  }
  // One mark for everything drawn since the last one, framed around the drawing (cut to the visible window).
  // Enter with nothing drawn keeps the whole still as the mark (the old 撮影 button).
  private async finishPen(toElement = false): Promise<void> {
    if (this.capturing || this.sending || !this.active) return;
    if (!this.shapes.length) {
      if (!toElement || !this.shot) return;
      const dpr = devicePixelRatio || 1;
      // The still is the visible viewport in device pixels, so the mark is the whole image (not document CSS px).
      const imageRect = this.shot.imageRect ?? { x: 0, y: 0, width: Math.round(innerWidth * dpr), height: Math.round(innerHeight * dpr) };
      this.add({ kind: "capture", image: this.shot.image, imageRect,
        displayRect: { x: scrollOffset("x"), y: scrollOffset("y"), width: innerWidth, height: innerHeight } });
      this.setMode("element");
      this.leftPen = true;
      return;
    }
    const shapes = this.shapes; // still drawn (and Enter-able) until the capture is done
    const xs = shapes.flatMap((shape) => shape.points.map((p) => p.x)), ys = shapes.flatMap((shape) => shape.points.map((p) => p.y));
    const sx = scrollOffset("x"), sy = scrollOffset("y"), pad = 12;
    const left = Math.max(sx, Math.min(...xs) - pad), top = Math.max(sy, Math.min(...ys) - pad);
    const rect = { x: left, y: top, width: Math.min(sx + innerWidth, Math.max(...xs) + pad) - left,
      height: Math.min(sy + innerHeight, Math.max(...ys) + pad) - top };
    this.capturing = true;
    try {
      const viewerRangeImage = (window as Window & { __rmpViewerRangeImage?: (displayRect: Rect) => ViewerRangeImage }).__rmpViewerRangeImage;
      let image: string, imageRect: Rect;
      if (viewerRangeImage) ({ image, imageRect } = viewerRangeImage(rect));
      else if (this.shot && this.still.naturalWidth) {
        // The still plus the strokes, not a second tab capture: Chrome allows only 2 captures a second.
        const out = document.createElement("canvas");
        out.width = this.still.naturalWidth;
        out.height = this.still.naturalHeight;
        const ctx = out.getContext("2d")!;
        ctx.drawImage(this.still, 0, 0);
        ctx.drawImage(this.canvas, 0, 0, out.width, out.height);
        image = out.toDataURL("image/jpeg", 0.85);
        const scale = out.width / innerWidth;
        imageRect = { x: Math.round((rect.x - sx) * scale), y: Math.round((rect.y - sy) * scale),
          width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
      } else {
        const dpr = devicePixelRatio || 1;
        image = (await this.screenshot()).image;
        imageRect = { x: Math.round((rect.x - sx) * dpr), y: Math.round((rect.y - sy) * dpr),
          width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) };
      }
      this.capturing = false;
      this.shapes = [];
      const annotation = this.add({ kind: "pen", image, imageRect, displayRect: rect });
      if (annotation) this.inks.set(annotation, shapes);
      if (toElement) this.setMode("element");
      this.leftPen = this.mode === "element";
    } catch { this.toast("撮影できませんでした。描いた線は残しています"); }
    finally { this.capturing = false; this.renderStrokes(); }
  }
  private renderStrokes(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const dpr = devicePixelRatio || 1, sx = scrollOffset("x"), sy = scrollOffset("y");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const shapes = [...[...this.inks.values()].flat(), ...this.shapes, ...(this.drawing ? [this.drawing] : [])];
    for (const shape of shapes) {
      const [a, b] = [shape.points[0], shape.points.at(-1)].map((p) => p && { x: p.x - sx, y: p.y - sy });
      if (!a || !b) continue;
      ctx.strokeStyle = ctx.fillStyle = shape.color;
      ctx.beginPath();
      if (shape.tool === "rect") ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      else if (shape.tool === "pen") {
        for (const p of shape.points) ctx.lineTo(p.x - sx, p.y - sy);
        ctx.stroke();
      } else {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(b.x, b.y);
        for (const side of [-0.45, 0.45]) ctx.lineTo(b.x - 18 * Math.cos(angle + side), b.y - 18 * Math.sin(angle + side));
        ctx.closePath(); ctx.fill();
      }
    }
  }
}

function rectBetween(start: Point, end: Point): Rect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}
function position(element: HTMLElement, rect: Rect): void {
  element.style.left = `${rect.x - scrollOffset("x")}px`;
  element.style.top = `${rect.y - scrollOffset("y")}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}
function visibleText(element: Element): string {
  return (element instanceof HTMLElement ? element.innerText : element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}
// The caret under the pointer when it is on the characters themselves, not the blank part of their box.
function textAt(x: number, y: number): CaretPosition | null {
  const caret = document.caretPositionFromPoint(x, y), node = caret?.offsetNode, parent = node?.parentElement;
  if (node?.nodeType !== Node.TEXT_NODE || !node.textContent?.trim() || !parent || getComputedStyle(parent).userSelect === "none") return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  return [...range.getClientRects()].some((box) => box.left <= x && x <= box.right && box.top <= y && y <= box.bottom) ? caret : null;
}

const overlay = new Overlay();
(window as Window & { __rmpViewerReset?: () => Promise<void> }).__rmpViewerReset = () => overlay.replaceDocument();
(window as Window & { __rmpRemap?: (move: (point: Point) => Point) => void }).__rmpRemap = (move) => overlay.remap(move);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "rmp:toggle") {
    const active = !overlay.active;
    void (active ? overlay.activate() : Promise.resolve(overlay.hide())).then(() => reply({ active }),
      (error) => reply({ error: String(error), active: overlay.active }));
    return true;
  }
  if (message?.type === "rmp:copy-tab-id") {
    void (async () => {
      if (!overlay.active) await overlay.activate();
      await overlay.copyTabId();
    })().then(() => reply({ active: overlay.active }), (error) => reply({ error: String(error), active: overlay.active }));
    return true;
  }
});
void overlay.activate().catch((error) => console.error("Red Marker Page:", error));

function place(bar: HTMLElement, at: Point): void {
  Object.assign(bar.style, { left: `${at.x}px`, top: `${at.y}px`, right: "auto", bottom: "auto", transform: "none" });
}
