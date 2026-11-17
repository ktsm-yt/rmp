// "Where is X?": a send carries the page's parts list, Claude answers with numbers (`rmp-inbox.py point`),
// and the page frames those parts until the user presses one or ×.
import type { Part, PointReply } from "../types";

const PARTS = "h1,h2,h3,h4,h5,h6,a[href],button,input:not([type=hidden]),select,textarea,summary," +
  "[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio]";
// ponytail: measured on real pages (PR body); raise it when a page's answer sits past the cut.
const PARTS_LIMIT = 300;
const TEXT_LIMIT = 80;

export type Parts = { list: Part[]; total: number; elements: Element[] };

const squash = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

function kindOf(element: Element): string {
  const role = element.getAttribute("role");
  if (role) return role;
  if (element instanceof HTMLInputElement) return `input:${element.type}`;
  return element.localName === "a" ? "link" : element.localName;
}

// Never a field's value: what the user typed is not the page's, and a password must not leave the page.
function textOf(element: Element): string {
  const named = squash(element.getAttribute("aria-label")) || squash(element.getAttribute("title"));
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    const label = squash([...element.labels ?? []].map((item) => item.innerText).join(" "));
    return named || label || squash(element.getAttribute("placeholder")) || squash(element.getAttribute("name"));
  }
  const inner = element instanceof HTMLElement ? squash(element.innerText) : squash(element.textContent);
  return inner || named || squash(element.querySelector("img[alt]")?.getAttribute("alt"));
}

/** The page's headings and controls in document order, the hidden and the nameless left out, numbered from 1. */
export function collectParts(limit = PARTS_LIMIT): Parts {
  const found: { element: Element; kind: string; text: string }[] = [];
  for (const element of document.querySelectorAll(PARTS)) {
    if (!element.checkVisibility({ visibilityProperty: true }) || !element.getClientRects().length) continue;
    const text = textOf(element).slice(0, TEXT_LIMIT);
    if (text) found.push({ element, kind: kindOf(element), text });
  }
  const kept = found.slice(0, limit);
  return {
    list: kept.map(({ kind, text }, index) => ({ n: index + 1, kind, text })),
    total: found.length,
    elements: kept.map(({ element }) => element),
  };
}

// The frames live in their own host: the annotation bar's host leaves the page when the bar is hidden.
export const pointHost = document.createElement("div");
pointHost.id = "rmp-point-root";
const shadow = pointHost.attachShadow({ mode: "open" });
shadow.innerHTML = `<style>
  :host{all:initial!important;position:static!important}
  .frame{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #e5484d;border-radius:6px;box-shadow:0 0 0 4px #e5484d40}
  .label{position:fixed;z-index:2147483647;display:flex;gap:6px;align-items:center;max-width:min(360px,calc(100vw - 16px));padding:4px 6px 4px 10px;border-radius:8px;background:#e5484d;color:#fff;font:600 13px/1.4 system-ui,-apple-system,"Hiragino Sans",sans-serif;box-shadow:0 2px 8px #00000040}
  .label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .label button{flex:none;border:0;border-radius:6px;padding:2px 7px;background:#ffffff33;color:#fff;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer}
  .label button:hover{background:#ffffff59}
</style>`;

let shown: { element: Element; frame: HTMLElement; label?: HTMLElement }[] = [];
let raf = 0;

export function clearPoint(): void {
  cancelAnimationFrame(raf);
  for (const { frame, label } of shown) { frame.remove(); label?.remove(); }
  shown = [];
  pointHost.remove();
}

// Re-read every frame: images loading, menus opening and scrolled boxes move parts without a scroll of the window.
function follow(): void {
  for (const { element, frame, label } of shown) {
    const box = element.getBoundingClientRect();
    Object.assign(frame.style, { left: `${box.left - 4}px`, top: `${box.top - 4}px`, width: `${box.width + 8}px`, height: `${box.height + 8}px` });
    if (label) {
      // Beside the part when there is room, so it does not cover the heading above it; else above, else below.
      const beside = box.right + 12 + label.offsetWidth <= innerWidth - 4;
      const above = box.top - 4 - label.offsetHeight - 4;
      Object.assign(label.style, beside
        ? { left: `${box.right + 12}px`, top: `${box.top + box.height / 2 - label.offsetHeight / 2}px` }
        : { left: `${Math.max(4, box.left - 4)}px`, top: `${above >= 4 ? above : box.bottom + 8}px` });
    }
  }
  raf = requestAnimationFrame(follow);
}

/** Frames the parts the point names and scrolls the first into view; a part the page dropped is looked up again by its kind and text. */
export function showPoint(point: PointReply, parts: Parts): void {
  clearPoint();
  let fresh: Parts | undefined;
  const missing: number[] = [];
  for (const n of point.numbers) {
    let element = parts.elements[n - 1];
    const part = parts.list[n - 1];
    if (element && !element.isConnected && part) {
      fresh ??= collectParts(Infinity);
      element = fresh.elements[fresh.list.findIndex((item) => item.kind === part.kind && item.text === part.text)];
    }
    if (!element?.isConnected) { missing.push(n); continue; }
    const frame = document.createElement("div");
    frame.className = "frame";
    shown.push({ element, frame });
  }
  const label = document.createElement("div");
  label.className = "label";
  label.setAttribute("role", "status");
  const text = document.createElement("span");
  const gone = missing.length ? `#${missing.join(", #")} はページから無くなっています` : "";
  text.textContent = [`Claude: ${point.note || "ここです"}`, gone].filter(Boolean).join(" · ");
  label.title = text.textContent;
  const close = document.createElement("button");
  close.textContent = "×";
  close.setAttribute("aria-label", "赤枠を消す");
  close.addEventListener("click", clearPoint);
  label.append(text, close);
  if (shown[0]) shown[0].label = label;
  else Object.assign(label.style, { right: "12px", top: "12px" });
  shadow.append(...shown.map(({ frame }) => frame), label);
  document.documentElement.append(pointHost);
  shown[0]?.element.scrollIntoView({ behavior: "smooth", block: "center" });
  follow();
}

// Pressing a framed part is the user having found it.
addEventListener("click", (event) => {
  if (shown.some(({ element }) => event.composedPath().includes(element))) clearPoint();
}, true);
