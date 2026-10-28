// Runs inside the vendored pdf.js viewer page (public/pdfjs/web/viewer.html), next to overlay.js.
import { scrollOffset } from "../overlay/logic.js";
import { compositeRect, movePoint, normalizeRect } from "./logic.js";
import type { Rect } from "../types.js";

type Options = { set(name: string, value: unknown): void };
type App = { initializedPromise: Promise<void>; eventBus: { on(name: string, listener: (event: { message?: string; reason?: string | null }) => void): void } };
const page = window as Window & {
  PDFViewerApplicationOptions?: Options; PDFViewerApplication?: App; __rmpScrollRoot?: Element;
  __rmpViewerReset?: () => Promise<void>;
  __rmpRemap?: (move: (point: { x: number; y: number }) => { x: number; y: number }) => void;
  __rmpViewerCapture?: () => Promise<{ image: string; imageRect: Rect }>;
  __rmpViewerRangeImage?: (displayRect: Rect) => { image: string; imageRect: Rect };
};

// The overlay measures marks against this container's scroll, and keeps its bar below the viewer's.
page.__rmpScrollRoot = document.querySelector("#viewerContainer") ?? undefined;

// Zoom, the sidebar and window size lay the pages out again; range, text and pen marks move with their page.
// ponytail: rotating pages is not followed (the share of the page would need turning too).
let boxes: Rect[] = [];
const pageBoxes = () => [...document.querySelectorAll("#viewer .page")].map((element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + scrollOffset("x"), y: rect.top + scrollOffset("y"), width: rect.width, height: rect.height };
});
const relayout = new ResizeObserver(() => {
  const before = boxes;
  boxes = pageBoxes();
  if (before.length && before.length === boxes.length) page.__rmpRemap?.((point) => movePoint(point, before, boxes));
});
for (const selector of ["#viewer", "#viewerContainer"]) {
  const element = document.querySelector(selector);
  if (element) relayout.observe(element);
}
document.documentElement.style.setProperty("--rmp-top", "32px");

document.addEventListener("webviewerloaded", () => {
  // No sample PDF without ?file=; pdf.js warnings (e.g. odd fonts) would read as a broken extension.
  page.PDFViewerApplicationOptions?.set("defaultUrl", "");
  page.PDFViewerApplicationOptions?.set("verbosity", 0);
  void page.PDFViewerApplication?.initializedPromise.then(() => {
    let opened = false;
    // Marks belong to the document they were made on; opening another file drops them.
    page.PDFViewerApplication!.eventBus.on("documentloaded", () => {
      document.querySelector("#rmp-load-error")?.remove();
      if (opened) void page.__rmpViewerReset?.();
      opened = true;
    });
    // pdf.js only logs a failed load, which leaves an empty dark page; say why and offer the file picker.
    page.PDFViewerApplication!.eventBus.on("documenterror", (event) => showLoadError(event.message, event.reason));
  });
});

function showLoadError(message?: string, reason?: string | null): void {
  document.querySelector("#rmp-load-error")?.remove();
  const file = new URLSearchParams(location.search).get("file") ?? "";
  const box = document.createElement("div");
  box.id = "rmp-load-error";
  box.setAttribute("role", "alert");
  box.style.cssText = "position:fixed;z-index:2147483640;left:50%;top:40%;transform:translate(-50%,-50%);width:min(520px,calc(100vw - 32px));" +
    "padding:18px 20px;background:#fff;color:#18181b;border:1px solid #e4e4e7;border-radius:14px;box-shadow:0 10px 32px #00000040;font:14px/1.6 system-ui,sans-serif";
  const line = (text: string, color = "#18181b") => {
    const p = document.createElement("p");
    p.style.cssText = `margin:0 0 8px;color:${color};overflow-wrap:anywhere`;
    p.textContent = text;
    box.append(p);
  };
  line(`PDF を読めませんでした: ${message ?? ""}`);
  if (file.startsWith("file:")) line("手元のファイルは、拡張機能の詳細画面で『ファイルの URL へのアクセスを許可する』が ON の時だけ読めます。ON なら、このタブを再読み込みしてください。", "#52525b");
  if (reason) line(reason, "#71717a");
  const pick = document.createElement("button");
  pick.textContent = "ファイルを選ぶ";
  pick.style.cssText = "margin-top:4px;padding:6px 14px;border:0;border-radius:8px;background:#18181b;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer";
  pick.onclick = () => document.querySelector<HTMLInputElement>("#fileInput")?.click();
  box.append(pick);
  document.body.append(box);
}

function viewportRect(rect: Rect): Rect {
  const x = rect.x - scrollOffset("x"), y = rect.y - scrollOffset("y");
  return normalizeRect({ x, y }, { x: x + rect.width, y: y + rect.height });
}

function composite(extra?: Rect): HTMLCanvasElement {
  const scale = devicePixelRatio || 1;
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(innerWidth * scale));
  output.height = Math.max(1, Math.round(innerHeight * scale));
  const context = output.getContext("2d")!;
  context.fillStyle = "white"; context.fillRect(0, 0, output.width, output.height);
  const draw = (canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight) {
      context.drawImage(canvas, rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
    }
  };
  // ponytail: pages only, not the viewer's toolbar or sidebar; the image is what was marked, not the whole screen.
  document.querySelectorAll<HTMLCanvasElement>("#viewer .page canvas").forEach(draw);
  const shadow = document.querySelector<HTMLElement>("#rmp-overlay-root")?.shadowRoot;
  shadow?.querySelectorAll<HTMLCanvasElement>(".rmp-canvas").forEach(draw);
  context.strokeStyle = "#dc2626"; context.lineWidth = 2 * scale;
  for (const frame of shadow?.querySelectorAll<HTMLElement>(".rmp-frame") ?? []) {
    const rect = frame.getBoundingClientRect();
    context.strokeRect(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
  }
  if (extra) context.strokeRect(extra.x * scale, extra.y * scale, extra.width * scale, extra.height * scale);
  return output;
}

// The overlay calls this instead of captureVisibleTab on extension pages.
page.__rmpViewerCapture = async () => {
  const image = composite();
  return { image: image.toDataURL("image/jpeg", 0.85), imageRect: { x: 0, y: 0, width: image.width, height: image.height } };
};
page.__rmpViewerRangeImage = (displayRect) => {
  const rect = viewportRect(displayRect);
  const scale = devicePixelRatio || 1;
  return { image: composite(rect).toDataURL("image/jpeg", 0.85), imageRect: compositeRect(rect, scale, { x: 0, y: 0 }) };
};
