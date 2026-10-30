import { isSessionId, isTicket } from "./inboxSend";
import type { Annotation } from "./types";

// The vendored pdf.js viewer (public/pdfjs); PDFs open here instead of Chrome's own viewer.
export const VIEWER = "pdfjs/web/viewer.html";

export type PageMessage =
  | { type: "rmp:init"; url: string }
  | { type: "rmp:targets"; url: string; picked?: { sid: string | null } }
  | { type: "rmp:pick"; url: string; sid: string | null }
  | { type: "rmp:send"; url: string; annotations: Annotation[]; picked?: { sid: string | null } }
  | { type: "rmp:draft"; url: string; title: string; annotations: Annotation[] }
  | { type: "rmp:capture" }
  | { type: "rmp:status"; ticket: string };

const kinds = new Set(["dom", "range", "text", "pen", "capture"]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string";
const optionalText = (value: unknown) => value === undefined || text(value);
const picked = (value: unknown) => value === undefined ||
  (record(value) && (value.sid === null || isSessionId(value.sid)));

function validRect(value: unknown): boolean {
  return record(value) && ["x", "y", "width", "height"].every((key) => Number.isFinite(value[key])) &&
    Number(value.width) >= 0 && Number(value.height) >= 0;
}

export function validAnnotations(value: unknown): value is Annotation[] {
  return Array.isArray(value) && value.length <= 200 && value.every((a) => {
    if (!record(a) || !kinds.has(String(a.kind)) || !Number.isInteger(a.displayNumber) ||
        Number(a.displayNumber) < 1) return false;
    if (![a.comment, a.text, a.url, a.title].every(optionalText)) return false;
    if (a.element !== undefined && (!record(a.element) ||
        ![a.element.selector, a.element.text].every(optionalText))) return false;
    if (a.image !== undefined && (typeof a.image !== "string" ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(a.image))) return false;
    if (a.imageRect !== undefined && !validRect(a.imageRect)) return false;
    return true;
  });
}

export function validMessage(
  value: unknown,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
  // Firefox pages live at moz-extension://<per-profile UUID>/, not at the extension ID.
  viewerUrl = `chrome-extension://${extensionId}/${VIEWER}`,
): value is PageMessage {
  let extensionPage = false;
  try {
    const url = new URL(sender.url ?? "");
    extensionPage = `${url.protocol}//${url.host}${url.pathname}` === viewerUrl;
  } catch { /* page messages still require a tab */ }
  if (sender.id !== extensionId || (!extensionPage && (!Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0)) ||
      (sender.frameId !== undefined && sender.frameId !== 0) || !record(value) || "tabId" in value) return false;
  switch (value.type) {
    case "rmp:init": return text(value.url);
    case "rmp:targets": return text(value.url) && picked(value.picked);
    case "rmp:pick": return text(value.url) && (value.sid === null || isSessionId(value.sid));
    case "rmp:send": return text(value.url) && picked(value.picked) && validAnnotations(value.annotations);
    case "rmp:draft": return text(value.url) && text(value.title) && validAnnotations(value.annotations);
    case "rmp:capture": return true;
    case "rmp:status": return isTicket(value.ticket);
    default: return false;
  }
}
