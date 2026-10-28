import { describe, expect, it } from "vitest";
import { validMessage } from "../src/messages";

const sender = { id: "extension", tab: { id: 12, windowId: 3 }, frameId: 0 };
const annotation = { kind: "dom", displayNumber: 1, element: { selector: "#target", text: "本文" } };

describe("runtime message boundary", () => {
  it.each([
    { type: "rmp:init", url: "https://example.com" },
    { type: "rmp:targets", url: "https://example.com", picked: { sid: null } },
    { type: "rmp:pick", url: "https://example.com", sid: null },
    { type: "rmp:send", url: "https://example.com", annotations: [annotation] },
    { type: "rmp:draft", url: "https://example.com", title: "題", annotations: [] },
    { type: "rmp:capture" },
    { type: "rmp:status", ticket: "20261025-223344-123456" },
  ])("accepts a known well-shaped message: $type", (message) => {
    expect(validMessage(message, sender, "extension")).toBe(true);
  });
  it.each([
    null, {}, { type: "fetch", url: "https://evil.com" },
    { type: "rmp:draft", tabId: 22, url: "x", annotations: [] },
    { type: "rmp:pick", url: "x", sid: "wrong" },
    { type: "rmp:send", url: "x", annotations: [{ ...annotation, kind: "unknown" }] },
    { type: "rmp:send", url: "x", annotations: [{ ...annotation, image: "data:image/png;base64,aaa" }] },
    { type: "rmp:send", url: "x", annotations: [{ ...annotation, imageRect: { x: 0, y: 0, width: NaN, height: 1 } }] },
    { type: "rmp:send", url: "x", annotations: [{ ...annotation, comment: {} }] },
    { type: "rmp:send", url: "x", annotations: Array(201).fill(annotation) },
    { type: "rmp:status", ticket: "anything" },
  ])("rejects malformed requests %#", (message) => {
    expect(validMessage(message, sender, "extension")).toBe(false);
  });
  it("rejects another extension, absent tabs, subframes and forged tab IDs", () => {
    const message = { type: "rmp:capture" };
    for (const bad of [{ ...sender, id: "other" }, { id: "extension" }, { ...sender, frameId: 1 }, { ...sender, tab: { id: -1 } }]) {
      expect(validMessage(message, bad, "extension")).toBe(false);
    }
    expect(validMessage({ type: "rmp:draft", url: "x", title: "", annotations: [], tabId: 999 }, sender, "extension")).toBe(false);
  });
  it("allows only the exact viewer extension page when there is no sender tab", () => {
    const message = { type: "rmp:init", url: "chrome-extension://extension/pdfjs/web/viewer.html" };
    expect(validMessage(message, { id: "extension", url: "chrome-extension://extension/pdfjs/web/viewer.html" }, "extension")).toBe(true);
    expect(validMessage(message, { id: "extension", url: "chrome-extension://extension/other.html" }, "extension")).toBe(false);
    expect(validMessage(message, { id: "extension", url: "chrome-extension://other/pdfjs/web/viewer.html" }, "extension")).toBe(false);
  });
});
