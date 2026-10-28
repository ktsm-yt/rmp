import { describe, expect, it, vi } from "vitest";
import { DraftDebouncer, keyAction, manualToast, newAnnotation, nextMode, rangeText, selectMark, selectorFor, startDeliveryWatch, startTicketWatch } from "../src/overlay/logic.js";

const key = (over: Partial<Parameters<typeof keyAction>[0]> = {}) => keyAction({
  key: "Enter", metaKey: false, isComposing: false, keyCode: 13, isTrusted: true, inComment: false, listOpen: false, ...over,
});

describe("overlay keys", () => {
  it("keeps IME and synthetic keys out, then distinguishes comment save/send/list", () => {
    expect(key({ isComposing: true })).toBeNull();
    expect(key({ keyCode: 229 })).toBeNull();
    expect(key({ isTrusted: false })).toBeNull();
    expect(key({ inComment: true })).toBe("save");
    expect(key({ inComment: true, shiftKey: true })).toBeNull();
    expect(key({ inComment: true, key: "Escape" })).toBe("cancel");
    expect(key({ key: "Escape", selected: true })).toBe("cancel");
    expect(key({ key: "Escape" })).toBeNull();
    expect(key({ ctrlKey: true })).toBe("send");
    expect(key({ inComment: true, metaKey: true })).toBe("send");
    expect(key({ metaKey: true })).toBe("send");
    expect(key({ listOpen: true, key: "Enter" })).toBe("list");
    expect(key({ key: "Tab" })).toBe("mode");
    expect(key({ key: "Tab", inComment: true })).toBeNull();
    expect(key({ key: "Tab", shiftKey: true })).toBe("mode-back");
    expect(key({ key: "Tab", editing: true })).toBeNull();
  });

  it("deletes the selected mark only outside text fields, and gives digits and Tab to the open list", () => {
    expect(key({ key: "Backspace", selected: true })).toBe("delete");
    expect(key({ key: "Delete", selected: true })).toBe("delete");
    expect(key({ key: "Backspace" })).toBeNull();
    expect(key({ key: "Backspace", selected: true, inComment: true })).toBeNull();
    expect(key({ key: "Backspace", selected: true, editing: true })).toBeNull();
    expect(key({ key: "3", listOpen: true })).toBe("list");
    expect(key({ key: "Tab", listOpen: true })).toBe("list");
    expect(key({ key: "3" })).toBeNull();
    expect(nextMode("element", -1)).toBe("pen");
  });

  it("finishes, undoes and drops a pen drawing only while one is pending and outside text fields", () => {
    expect(key({ drawing: true })).toBe("pen-finish");
    expect(key({ drawing: true, key: "Escape", selected: true })).toBe("pen-cancel");
    expect(key({ drawing: true, key: "z", metaKey: true })).toBe("pen-undo");
    expect(key({ drawing: true, key: "Z", ctrlKey: true })).toBe("pen-undo");
    expect(key({ drawing: true, metaKey: true })).toBe("send");
    expect(key({ drawing: true, editing: true })).toBeNull();
    expect(key({ drawing: true, inComment: true })).toBe("save");
    expect(key({ key: "z", metaKey: true })).toBeNull();
  });
});

describe("overlay geometry", () => {
  it("builds a stable id-or-nth selector", () => {
    const root = { id: "main", tagName: "MAIN", previousElementSibling: null, parentElement: null } as unknown as Element;
    const second = { id: "", tagName: "P", previousElementSibling: { tagName: "P", previousElementSibling: null }, parentElement: root } as unknown as Element;
    expect(selectorFor(second)).toBe("#main > p:nth-of-type(2)");
  });

  it("collects only intersecting text and truncates it", () => {
    const element = (text: string, left: number) => ({
      childNodes: [{ nodeType: 3, textContent: text }],
      getBoundingClientRect: () => ({ left, top: 0, width: 10, height: 10 }),
      ownerDocument: { createRange: () => ({
        selectNodeContents() {}, getBoundingClientRect: () => ({ left, top: 0, width: 10, height: 10 }),
      }) },
    }) as unknown as Element;
    expect(rangeText({ x: 0, y: 0, width: 20, height: 20 }, [element("inside", 2), element("outside", 50)])).toBe("inside");
    expect(rangeText({ x: 0, y: 0, width: 20, height: 20 }, [element("abcdefgh", 2)], 4)).toBe("abcd");
  });
});

describe("mark selection", () => {
  it("replaces selection normally and extends it uniquely with Shift", () => {
    expect(selectMark([1, 2], 3, false)).toEqual([3]);
    expect(selectMark([1], 2, true)).toEqual([1, 2]);
    expect(selectMark([1, 2], 2, true)).toEqual([1, 2]);
  });

  it("numbers marks and records the current page metadata", () => {
    vi.stubGlobal("location", { href: "https://example.test/page" });
    vi.stubGlobal("document", { title: "確認ページ" });
    expect(newAnnotation([{ kind: "text", displayNumber: 1 }], { kind: "range", text: "範囲" })).toEqual({
      kind: "range", text: "範囲", displayNumber: 2, url: "https://example.test/page", title: "確認ページ",
    });
    vi.unstubAllGlobals();
  });
});

describe("draft and ticket timing", () => {
  it("debounces draft changes and serializes the final empty draft", async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const drafts = new DraftDebouncer(globalThis, async (annotations) => { writes.push(annotations.length); });
    drafts.schedule([{ kind: "text", displayNumber: 1 }]);
    drafts.schedule([{ kind: "text", displayNumber: 1 }, { kind: "text", displayNumber: 2 }]);
    await vi.advanceTimersByTimeAsync(300);
    await drafts.clear();
    expect(writes).toEqual([2, 0]);
    vi.useRealTimers();
  });

  it("continues after a failed draft write and snapshots the scheduled value", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const drafts = new DraftDebouncer(globalThis, write);
    const mark = { kind: "text" as const, displayNumber: 1, comment: "first" };
    drafts.schedule([mark]); mark.comment = "later";
    await vi.advanceTimersByTimeAsync(300);
    await expect(drafts.clear()).resolves.toBeUndefined();
    expect(write.mock.calls).toEqual([[[{ kind: "text", displayNumber: 1, comment: "first" }]], [[]]]);
    vi.useRealTimers();
  });

  it("checks at 60 seconds only when the delayed ticket is still new", async () => {
    vi.useFakeTimers();
    const read = vi.fn(); const pending = vi.fn(); const status = vi.fn(async () => "new" as const);
    startTicketWatch("20261025-010101-000001", status, read, pending, globalThis);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps a pending ticket out of the clipboard until 60 seconds, then copies only an unread one", async () => {
    vi.useFakeTimers();
    const copy = vi.fn();
    startDeliveryWatch("20261025-010101-000001", "pending", async () => "new", vi.fn(), copy, globalThis);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(copy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenLastCalledWith("/rmp 20261025-010101-000001", "手で: 未読のためコピーしました");
    const readCopy = vi.fn();
    startDeliveryWatch("20261025-010101-000002", "pending", async () => "read", vi.fn(), readCopy, globalThis);
    const nowCopy = vi.fn();
    startDeliveryWatch("20261025-010101-000003", "now", async () => "new", vi.fn(), nowCopy, globalThis);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readCopy).not.toHaveBeenCalled();
    expect(nowCopy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("stops both polling and the delayed fallback after a read", async () => {
    vi.useFakeTimers();
    const read = vi.fn(); const pending = vi.fn();
    startTicketWatch("20261025-010101-000001", async () => "read", read, pending, globalThis);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1); expect(pending).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});


describe("key decision table", () => {
  it.each(["Enter", "ArrowUp", "ArrowDown", "Escape"])("list consumes %s before send", (keyName) => {
    expect(key({ key: keyName, listOpen: true, metaKey: true, inComment: true })).toBe("list");
  });
  it.each([false, true])("ignores IME and untrusted CmdEnter (inComment=%s)", (inComment) => {
    for (const over of [{ isComposing: true }, { keyCode: 229 }, { isTrusted: false }]) {
      expect(key({ metaKey: true, inComment, listOpen: true, ...over })).toBeNull();
    }
  });
  it("cycles the two modes and leaves ordinary Enter outside comments alone", () => {
    expect(["element", "pen"].map(mode => nextMode(mode as Parameters<typeof nextMode>[0]))).toEqual(["pen", "element"]);
    expect(key()).toBeNull();
  });
});

describe("ticket watcher cancellation", () => {
  it("survives a failed status request, never copies an unknown status, and stops by ten minutes", async () => {
    vi.useFakeTimers();
    const pending = vi.fn(); const read = vi.fn();
    const status = vi.fn().mockRejectedValue(new Error("offline"));
    startTicketWatch("20261025-010101-000001", status, read, pending, globalThis);
    await vi.advanceTimersByTimeAsync(600_000);
    const calls = status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status.mock.calls.length).toBe(calls);
    expect(calls).toBeGreaterThan(1);
    expect(pending).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("does not report an in-flight read after being stopped", async () => {
    vi.useFakeTimers();
    let finish!: (value: "read") => void;
    const read = vi.fn();
    const stop = startTicketWatch("20261025-010101-000001", () => new Promise(resolve => { finish = resolve; }), read, vi.fn(), globalThis);
    await vi.advanceTimersByTimeAsync(3000);
    stop(); finish("read");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("clears a pending unsaved draft without writing it back after exit", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const drafts = new DraftDebouncer(globalThis, write);
    drafts.schedule([{ kind: "text", displayNumber: 1 }]);
    await drafts.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write.mock.calls).toEqual([[[]]]);
    vi.useRealTimers();
  });
});

describe("manual copy toast", () => {
  it("says why rmv did not type the ticket, and stays short when there is no reason", () => {
    expect(manualToast("draft")).toBe("手で: 宛先の入力欄に書きかけがあるためコピーしました");
    expect(manualToast("stale")).toContain("別の会話");
    expect(manualToast(undefined)).toBe("手で: コピーしました");
    expect(manualToast("rmv_timeout")).toBe("手で: コピーしました");
  });
});
