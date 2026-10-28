import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackground } from "../src/background";

const sid = "11111111-1111-1111-1111-111111111111";
const sender = { id: "extension", tab: { id: 12, windowId: 3 }, frameId: 0 };
function fixture() {
  const api = {
    runtime: { id: "extension", getURL: (path: string) => `chrome-extension://extension/${path}`, getContexts: vi.fn().mockResolvedValue([]) },
    tabs: { sendMessage: vi.fn().mockRejectedValue(new Error("absent")), captureVisibleTab: vi.fn().mockResolvedValue("data:image/jpeg;base64,YQ=="), create: vi.fn(), query: vi.fn().mockResolvedValue([sender.tab]) },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: false }]) },
    storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn(), remove: vi.fn() } },
  };
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [{ sid, name: "会話", cwd: "/repo", updatedAt: 1, delivery: "next" }] }));
    if (input.endsWith("/ext/deliver")) return new Response("", { status: 403 });
    if (input.endsWith("/done")) return new Response(JSON.stringify({ ticket: "20261025-223344-123456", where: "new" }));
    return new Response("{}");
  });
  return { api, fetchImpl, background: createBackground(api as unknown as typeof chrome, fetchImpl as typeof fetch) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("background", () => {
  it("injects once and then asks the existing content script to toggle", async () => {
    const { api, background } = fixture();
    await background.activate({ id: 12, windowId: 3, url: "https://example.com" }, false);
    expect(api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 12 }, files: ["overlay.js"] });
    api.tabs.sendMessage.mockResolvedValue({ active: false });
    await background.activate({ id: 12, url: "https://example.com" }, false);
    expect(api.scripting.executeScript.mock.calls.filter(([arg]) => "files" in arg)).toHaveLength(1);
  });
  it("opens viewer for a PDF path without injecting the overlay", async () => {
    const { api, background } = fixture();
    const url = "https://example.com/document.PDF?q=1";
    await background.activate({ id: 12, url }, false);
    expect(api.tabs.create).toHaveBeenCalledWith({ url: `chrome-extension://extension/pdfjs/web/viewer.html?file=${encodeURIComponent(url)}` });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
  it("detects a PDF content type and routes it to viewer", async () => {
    const { api, background } = fixture();
    api.scripting.executeScript.mockResolvedValue([{ result: true }]);
    await background.activate({ id: 12, url: "https://example.com/download" }, false);
    expect(api.tabs.create).toHaveBeenCalledOnce();
    expect(api.scripting.executeScript.mock.calls.some(([arg]) => "files" in arg)).toBe(false);
  });
  it("copy command injects first without toggling an active overlay off", async () => {
    const { api, background } = fixture();
    api.tabs.sendMessage.mockRejectedValueOnce(new Error("absent")).mockResolvedValue({ active: true });
    await background.activate({ id: 12, url: "https://example.com" }, true);
    expect(api.tabs.sendMessage).toHaveBeenLastCalledWith(12, { type: "rmp:copy-tab-id" });
    expect(api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 12 }, files: ["overlay.js"] });
  });
  it("captures the sender's window with JPEG quality 80", async () => {
    const { api, background } = fixture();
    expect(await background.handle({ type: "rmp:capture" }, sender)).toEqual({ image: "data:image/jpeg;base64,YQ==" });
    expect(api.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: "jpeg", quality: 80 });
  });
  it("uses the sender tab ID for drafts and never trusts a page-supplied ID", async () => {
    const { fetchImpl, background } = fixture();
    await background.handle({ type: "rmp:draft", url: "https://example.com", title: "題", annotations: [] }, sender);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ tabId: 12, url: "https://example.com", title: "題", annotations: [] });
    await expect(background.handle({ type: "rmp:draft", tabId: 99, url: "x", title: "", annotations: [] }, sender)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses the exact viewer document context and rejects an unresolved viewer tab", async () => {
    const { api, background } = fixture();
    api.runtime.getContexts.mockResolvedValue([{ tabId: 41 }]);
    const viewer = { id: "extension", url: "chrome-extension://extension/pdfjs/web/viewer.html", documentId: "viewer-doc", frameId: 0 };
    await expect(background.handle({ type: "rmp:init", url: viewer.url }, viewer)).resolves.toMatchObject({ tabId: 41 });
    expect(api.runtime.getContexts).toHaveBeenCalledWith({ documentIds: ["viewer-doc"] });
    api.runtime.getContexts.mockResolvedValue([{ tabId: 41 }, { tabId: 42 }]);
    await expect(background.handle({ type: "rmp:init", url: viewer.url }, viewer)).rejects.toThrow("タブ ID");
    api.runtime.getContexts.mockResolvedValue([{ tabId: -1 }]);
    await expect(background.handle({ type: "rmp:init", url: viewer.url }, viewer)).rejects.toThrow("タブ ID");
  });
  it("returns a picker on first send, then stores to the explicit target and uses its hook", async () => {
    const { api, fetchImpl, background } = fixture();
    const request = { type: "rmp:send", url: "https://example.com", annotations: [{ kind: "dom", displayNumber: 1 }] };
    expect(await background.handle(request, sender)).toMatchObject({ kind: "pick", list: { decision: { action: "pick" } } });
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith("/done"))).toBe(false);
    expect(await background.handle({ ...request, picked: { sid } }, sender)).toMatchObject({ kind: "sent", result: { reason: "stored" }, route: "next" });
    expect(api.storage.local.set).toHaveBeenCalledWith({ lastTarget: { sid, cwd: "/repo", label: "会話" } });
    const done = fetchImpl.mock.calls.find(([url]) => url.endsWith("/done"));
    expect(done?.[1]?.headers).toEqual({ "X-RMP-To": sid });
  });
  it("persists an empty-mark destination choice", async () => {
    const { api, background } = fixture();
    expect(await background.handle({ type: "rmp:pick", url: "https://example.com", sid }, sender)).toEqual({ ok: true });
    expect(api.storage.local.set).toHaveBeenCalledWith({ lastTarget: { sid, cwd: "/repo", label: "会話" } });
  });
});

describe("delivery route", () => {
  it("uses next only for a registered hook when no immediate attempt failed", async () => {
    const { deliveryRoute } = await import("../src/background");
    const session = { sid, name: "", cwd: "", updatedAt: 0, match: null, last: false, delivery: "next" as const };
    expect(deliveryRoute({ delivered: true }, session)).toBe("now");
    expect(deliveryRoute({ delivered: false }, session)).toBe("next");
    expect(deliveryRoute({ delivered: false })).toBe("manual");
    for (const deliver of ["stale", "permission_pending", "draft", "unverified", "not_live", "not_enabled", "rmv_unreachable"] as const) {
      expect(deliveryRoute({ delivered: false, deliver }, session)).toBe("manual");
    }
    expect(deliveryRoute({ delivered: false, deliver: "rmv_timeout" }, session)).toBe("pending");
  });
});


describe("stored-send delivery integration", () => {
  const request = { type: "rmp:send", url: "https://example.com", picked: { sid }, annotations: [{ kind: "dom", displayNumber: 1 }] };
  it.each([
    [200, '{"ok":true,"via":"orca"}', "now", "delivered"],
    [409, "stale", "manual", "stale"],
    [409, "permission pending", "manual", "permission_pending"],
    [409, "draft", "manual", "draft"],
    [409, "unverified", "manual", "unverified"],
    [409, "not live", "manual", "not_live"],
    [403, "forbidden", "manual", "not_enabled"],
  ])("stores before rmv delivery: %s %s", async (status, body, route, deliver) => {
    const { background, fetchImpl } = fixture();
    const calls: string[] = [];
    fetchImpl.mockImplementation(async (url, init) => {
      calls.push(url.endsWith("/ext/deliver") ? (init?.body === "{}" ? "probe" : "deliver") : url.split("/").pop()!);
      if (url.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [{ sid, deliverable: true, delivery: "next" }] }));
      if (url.endsWith("/done")) return new Response(JSON.stringify({ ticket: "20261025-223344-123456" }));
      return new Response(init?.body === "{}" ? "" : String(body), { status: init?.body === "{}" ? 400 : Number(status) });
    });
    expect(await background.handle(request, sender)).toMatchObject({ kind: "sent", result: { ok: true, deliver }, route });
    expect(calls.indexOf("done")).toBeLessThan(calls.indexOf("deliver"));
  });
  it("returns pending after eight seconds, never retries the send", async () => {
    vi.useFakeTimers();
    const { background, fetchImpl } = fixture();
    fetchImpl.mockImplementation(async (url, init) => {
      if (url.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [{ sid, deliverable: true }] }));
      if (url.endsWith("/done")) return new Response(JSON.stringify({ ticket: "20261025-223344-123456" }));
      if (init?.body === "{}") return new Response("", { status: 400 });
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort"))));
    });
    const pending = background.handle(request, sender);
    await vi.advanceTimersByTimeAsync(7999);
    let finished = false;
    void pending.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ route: "pending", result: { ok: true, deliver: "rmv_timeout" } });
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/done"))).toHaveLength(1);
  });
  it("an inbox timeout preserves uncertainty and does not call rmv delivery or retry", async () => {
    vi.useFakeTimers();
    const { background, fetchImpl, api } = fixture();
    fetchImpl.mockImplementation(async (url, init) => {
      if (url.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [{ sid }] }));
      if (url.endsWith("/ext/deliver")) return new Response("", { status: 403 });
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort"))));
    });
    const pending = background.handle(request, sender);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ result: { ok: false, reason: "inbox_timeout" } });
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/done"))).toHaveLength(1);
    expect(api.storage.local.set).not.toHaveBeenCalled();
  });
});
