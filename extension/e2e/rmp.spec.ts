import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dragRange, fragmentedPdf, japanesePdf, RmpFixture, sids, twoPagePdf } from "./fixtures.js";

test.setTimeout(120_000);
const root = resolve("..");

async function withFixture(count: number, body: (rmp: RmpFixture) => Promise<void>): Promise<void> {
  const rmp = new RmpFixture();
  try {
    await rmp.start(count);
    await body(rmp);
  } finally {
    await rmp.stop();
  }
}

async function pixels(page: Page, image: string): Promise<{ width: number; height: number; red: number; dark: number }> {
  return page.evaluate(async (data) => {
    const imageElement = new Image();
    imageElement.src = data;
    await imageElement.decode();
    const canvas = document.createElement("canvas");
    canvas.width = imageElement.width;
    canvas.height = imageElement.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(imageElement, 0, 0);
    const rgba = context.getImageData(0, 0, imageElement.width, imageElement.height).data;
    let red = 0, dark = 0;
    for (let index = 0; index < rgba.length; index += 4) {
      if (rgba[index] > 130 && rgba[index + 1] < 120 && rgba[index + 2] < 120) red += 1;
      if (rgba[index] < 100 && rgba[index + 1] < 100 && rgba[index + 2] < 100 &&
        Math.max(rgba[index], rgba[index + 1], rgba[index + 2]) - Math.min(rgba[index], rgba[index + 1], rgba[index + 2]) < 30) dark += 1;
    }
    return { width: imageElement.width, height: imageElement.height, red, dark };
  }, image);
}

test("1 宛先3並列: 選んだ偽会話だけへ保存する", async () => {
  await withFixture(3, async (rmp) => {
    for (const sid of sids) {
      const before = await Promise.all(sids.map((value) => rmp.tickets(value)));
      const page = await rmp.open();
      await dragRange(page);
      // A drag in the element mode makes one range mark (not also an element mark) and stays in the element mode.
      await expect(page.locator("#rmp-overlay-root .rmp-mark")).toHaveCount(1);
      await expect(page.locator("#rmp-overlay-root .rmp-modes").getByRole("button", { name: "要素", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.locator("#rmp-overlay-root textarea").fill(`宛先 ${sid}`);
      await rmp.send(page, sid);
      for (const [index, value] of sids.entries()) {
        expect(await rmp.tickets(value)).toHaveLength(before[index].length + (value === sid ? 1 : 0));
      }
      if (sid === sids[sids.length - 1]) await rmp.screenshot(page, "01-selected-send");
    }
  });
});

test("2 Enter と CmdEnter: 保存だけ、欄内送信、欄外送信を分ける", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const field = overlay.locator("textarea");
    await dragRange(page);
    await field.fill("Enter保存");
    await field.press("Enter");
    await expect(field).toBeHidden();
    const waiting = Date.now();
    await expect.poll(async () => {
      expect(await rmp.tickets()).toEqual([]);
      return Date.now() - waiting >= 1_000;
    }, { timeout: 2_000 }).toBe(true);
    await overlay.getByRole("button", { name: "注釈 1 のコメント" }).click();
    await expect(overlay.locator(".rmp-modes").getByRole("button", { name: "要素", exact: true })).toHaveAttribute("aria-pressed", "true");
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(100, 220);
    await page.mouse.down();
    await page.mouse.move(box!.x + 8, box!.y + 8);
    await page.mouse.up();
    await page.mouse.move(box!.x + 8, box!.y + 8);
    await page.mouse.down();
    await page.mouse.move(500, 300);
    await page.mouse.up();
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    // The drags above may close the comment field (a press outside it), so open it again.
    if (!(await field.isVisible())) await overlay.getByRole("button", { name: "注釈 1 のコメント" }).click();
    await field.fill("Cmd未保存");
    await field.press("Meta+Enter");
    const destination = overlay.locator(`.rmp-list button[data-sid="${sids[0]}"]`);
    await expect(destination).toBeVisible({ timeout: 10_000 });
    await destination.click();
    await expect.poll(() => rmp.tickets()).toHaveLength(1);
    const first = await rmp.ticket();
    await dragRange(page, 280, 180);
    await field.fill("欄外送信");
    await overlay.locator(".rmp-state").click();
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => rmp.tickets()).toHaveLength(2);
    const second = (await rmp.tickets()).find((ticket) => ticket !== first)!;
    expect((await rmp.annotations(first) as Array<{ comment?: string }>)[0].comment).toBe("Cmd未保存");
    expect((await rmp.annotations(second) as Array<{ comment?: string }>)[0].comment).toBe("欄外送信");
    await rmp.screenshot(page, "02-keys");
  });
});

test("3 配送: now、次の入力、手で、409 と timeout を区別する", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    await dragRange(page);
    await rmp.send(page);
    await expect(overlay.locator(".rmp-toast")).toContainText("今すぐ", { timeout: 15_000 });
    expect(rmp.calls).toContain("deliver");
    rmp.rmvAvailable = false;
    await dragRange(page, 280, 180);
    await rmp.send(page);
    await expect(overlay.locator(".rmp-toast")).toContainText("次の入力", { timeout: 15_000 });
    await dragRange(page, 360, 260);
    await overlay.locator(".rmp-chip").click();
    // Headless Chromium lets the extension write the clipboard even without the permission, so the
    // copy-failure toast cannot be produced with real input here; this checks the manual route.
    await overlay.getByRole("button", { name: "宛先なし [手で]" }).click();
    await overlay.getByRole("button", { name: "送る", exact: true }).click();
    await expect(overlay.locator(".rmp-toast")).toContainText("手で: コピーしました", { timeout: 15_000 });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\/rmp \d{8}-\d{6}-\d{6}$/);
    await expect(overlay.locator(".rmp-toolbar")).not.toContainText("送信中", { timeout: 15_000 });
    rmp.rmvAvailable = true;
    const why = { draft: "書きかけがあるため", permission: "返事を待っているため", stale: "別の会話が開かれているため" };
    for (const mode of ["draft", "permission", "stale"] as const) {
      await expect(overlay.locator(".rmp-toast:not([data-rmp-ticket])")).toHaveCount(0, { timeout: 10_000 });
      rmp.mode = mode;
      const beforeCalls = rmp.calls.filter((call) => call === "deliver").length;
      const beforeTickets = await rmp.tickets();
      await dragRange(page, 430, 330);
      await rmp.send(page);
      await expect(overlay.locator(".rmp-toast")).toContainText(why[mode], { timeout: 15_000 });
      expect(rmp.calls.filter((call) => call === "deliver")).toHaveLength(beforeCalls + 1);
      const ticket = (await rmp.tickets()).find((value) => !beforeTickets.includes(value));
      expect(ticket).toBeTruthy();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`/rmp ${ticket}`);
    }
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    rmp.mode = "slow";
    await dragRange(page, 520, 400);
    await rmp.send(page);
    await expect(overlay.locator(".rmp-toast")).toContainText("配送の返事を待っています", { timeout: 15_000 });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(clipboard);
    await rmp.screenshot(page, "03-delivery");
  });
});

test("4 read ticket は既読へ移し、ページは読まれたと表示する", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    await dragRange(page);
    await rmp.send(page);
    const ticket = await rmp.ticket();
    expect(rmp.read(["--ticket", ticket])).toContain("range");
    expect(await rmp.tickets()).toEqual([]);
    expect(existsSync(join(rmp.inboxRoot, "new", sids[0], `${ticket}.json`))).toBeFalsy();
    expect(existsSync(join(rmp.inboxRoot, "read", `${ticket}.json`))).toBeTruthy();
    await expect(page.locator("#rmp-overlay-root")).toContainText("読まれた", { timeout: 8_000 });
    await rmp.screenshot(page, "04-read");
  });
});

test("5 同じ cwd の別会話は対象外の本文を読まない", async () => {
  await withFixture(2, async (rmp) => {
    const page = await rmp.open();
    await dragRange(page);
    await page.locator("#rmp-overlay-root textarea").fill("別会話だけ");
    await rmp.send(page, sids[1]);
    const output = rmp.read(["--session", sids[0]]);
    expect(output).toBe("未読の注釈はありません\n(他のセッション宛て 1 件は読んでいません。全部読むなら read --all)\n");
    expect(output).not.toContain("別会話だけ");
    await rmp.screenshot(page, "05-other-session");
  });
});

test("6 下書きは実タブ ID で表示し、未読に移さない", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    await dragRange(page);
    await page.locator("#rmp-overlay-root textarea").fill("下書き本文");
    await page.waitForTimeout(400);
    const tabId = await rmp.tabId(page);
    const before = await rmp.readTickets();
    const first = rmp.read(["--draft", String(tabId)]);
    const second = rmp.read(["--draft", String(tabId)]);
    expect(first).toContain("下書き本文");
    expect(second).toBe(first);
    expect(await rmp.readTickets()).toEqual(before);
    expect(await rmp.tickets()).toEqual([]);
    await page.locator("#rmp-overlay-root").getByRole("button", { name: "終了" }).click();
    await expect(page.locator("#rmp-overlay-root")).toHaveCount(0);
    await expect.poll(() => rmp.read(["--draft", String(tabId)])).toContain("下書きはありません");
    await rmp.screenshot(page, "06-draft");
  });
});

test("7 IME 変換中 Enter は保存せず、確定後 Enter は重複しない", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    // Copy the tab id before the mark: a toolbar click while the comment field is open moves focus away.
    const tabId = await rmp.tabId(page);
    expect(tabId).toBeGreaterThan(0);
    await dragRange(page);
    const field = page.locator("#rmp-overlay-root textarea");
    await page.evaluate(() => {
      const textarea = document.querySelector("#rmp-overlay-root")!.shadowRoot!.querySelector("textarea")!;
      (window as Window & { rmpEvents?: Array<[string, boolean]> }).rmpEvents = [];
      textarea.addEventListener("compositionstart", (event) => window.rmpEvents!.push([event.type, event.isTrusted]));
      textarea.addEventListener("compositionend", (event) => window.rmpEvents!.push([event.type, event.isTrusted]));
      textarea.addEventListener("keydown", (event) => window.rmpEvents!.push([event.key, event.isComposing]));
    });
    const cdp = await page.context().newCDPSession(page);
    await field.focus();
    await cdp.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await expect(field).toHaveValue("あ");
    await expect(field).toBeVisible();
    await page.waitForTimeout(400);
    const draft = rmp.read(["--draft", String(tabId)]);
    expect(draft).toContain(`=== 下書き タブ ${tabId} (1 件)`);
    expect(draft).not.toContain("コメント: あ");
    await page.keyboard.press("Enter");
    await expect(field).toBeHidden();
    await rmp.send(page);
    const annotations = await rmp.annotations(await rmp.ticket()) as Array<{ comment?: string }>;
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({ comment: "あ" });
    // The product guard is the composing Enter keydown (isComposing), so that must be a real
    // composition. Chromium reports compositionend with isTrusted false when the commit comes
    // from CDP key input (measured 2026-10-26). The overlay uses a trusted compositionend only to refresh the draft;
    // saving the comment is decided on keydown.
    const events = await page.evaluate(() => window.rmpEvents);
    expect(events).toEqual(expect.arrayContaining([["compositionstart", true], ["Enter", true]]));
    expect(events!.some(([type]) => type === "compositionend")).toBe(true);
    await rmp.screenshot(page, "07-ime");
  });
});

test("8 PDF は Firefox と同じ pdf.js の画面で開き、URL とファイル選択で描画し、3 範囲と撮影を JPEG で送る", async () => {
  await withFixture(1, async (rmp) => {
    const body = twoPagePdf();
    rmp.setSite((request, response) => {
      if (request.url === "/document.pdf") {
        response.setHeader("content-type", "application/pdf");
        response.end(body);
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<main style='height:900px'>通常ページの撮影</main>");
    });
    const page = await rmp.openPdf();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 2, mobile: false });
    await expect(page.locator("#viewer .page")).toHaveCount(2);
    for (const id of ["#zoomInButton", "#pageNumber", "#viewFindButton", "#scaleSelect"]) await expect(page.locator(id)).toBeVisible();
    await dragRange(page, 100, 110);
    await dragRange(page, 280, 210);
    // The viewer scrolls its own container; marks move with it.
    const markTop = () => page.evaluate(() => document.querySelector("#rmp-overlay-root")!.shadowRoot!.querySelector("[aria-label='注釈 1 のコメント']")!.getBoundingClientRect().y);
    const before = await markTop();
    // pdf.js opens a few px down already, so compare the change in scroll.
    const scrolled = await page.evaluate(() => { const box = document.querySelector("#viewerContainer")!; const start = box.scrollTop; box.scrollTop = 850; return box.scrollTop - start; });
    expect(scrolled).toBeGreaterThan(500);
    await expect.poll(async () => Math.round(before - await markTop())).toBe(Math.round(scrolled));
    await dragRange(page, 130, 180);
    // 📷 with nothing drawn: Enter keeps the whole still as the mark.
    await page.locator("#rmp-overlay-root").getByRole("button", { name: "撮影" }).click();
    await expect(page.locator("#rmp-overlay-root .rmp-still")).toBeAttached();
    await page.keyboard.press("Enter");
    await expect(page.locator("#rmp-overlay-root").getByRole("button", { name: "注釈 4 のコメント" })).toBeVisible();
    await expect(page.locator("#rmp-overlay-root .rmp-still")).not.toBeAttached();
    await rmp.send(page);
    const ticket = await rmp.ticket();
    const annotations = await rmp.annotations(ticket) as Array<{ kind: string; image?: string; imageRect?: { x: number; y: number; width: number; height: number } }>;
    expect(annotations.filter((annotation) => annotation.kind === "range")).toHaveLength(3);
    expect(annotations).toHaveLength(4);
    for (const [index, annotation] of annotations.entries()) {
      const image = await pixels(page, annotation.image!);
      expect(annotation.image).toMatch(/^data:image\/jpeg;base64,/);
      expect(annotation.imageRect).toEqual(annotation.kind === "capture" ? { x: 0, y: 0, width: image.width, height: image.height } : { x: [200, 560, 260][index], y: [220, 420, 360][index], width: 280, height: 110 });
      expect(image.width).toBe(1800);
      expect(image.height).toBe(1400);
      expect(image.red).toBeGreaterThan(20);
      expect(image.dark).toBeGreaterThan(20);
    }
    const printed = rmp.read(["--ticket", ticket]);
    const paths = [...printed.matchAll(/^    画像: (.+?) \(印を付けた時の画面。/gm)].map((match) => match[1]);
    expect(paths).toHaveLength(4);
    paths.forEach((path) => expect(existsSync(path)).toBeTruthy());
    await page.keyboard.press("Tab");
    await expect(page.locator("#rmp-overlay-root .rmp-still")).toBeAttached();
    // On the 2x screen the pen layer is the window's size, so a stroke starts under the pointer.
    expect(await page.evaluate(() => document.querySelector("#rmp-overlay-root")!.shadowRoot!.querySelector(".rmp-canvas")!.getBoundingClientRect().width))
      .toBe(await page.evaluate(() => innerWidth));
    // The page is a still while the pen is on, so the wheel does not move it.
    const viewerTop = () => page.evaluate(() => document.querySelector("#viewerContainer")!.scrollTop);
    const topBefore = await viewerTop();
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    expect(await viewerTop()).toBe(topBefore);
    // Several strokes make one mark when the drawing is finished, framed around the drawing only.
    for (const [x, y] of [[120, 180], [200, 300]]) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 100, y + 40);
      await page.mouse.up();
    }
    await expect(page.locator("#rmp-overlay-root").getByRole("button", { name: "注釈 1 のコメント" })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.locator("#rmp-overlay-root").getByRole("button", { name: "注釈 1 のコメント" })).toBeVisible();
    await expect(page.locator("#rmp-overlay-root").getByRole("button", { name: "注釈 2 のコメント" })).toHaveCount(0);
    // After Enter: a screenshot resets the 2x screen, which would halve the image above.
    await rmp.screenshot(page, "08-pen");
    await rmp.send(page);
    const penTicket = await rmp.ticket();
    const pen = (await rmp.annotations(penTicket))[0] as { image?: string; imageRect?: { x: number; y: number; width: number; height: number } };
    expect(pen.imageRect).toEqual({ x: 216, y: 336, width: 408, height: 368 });
    expect((await pixels(page, pen.image!)).red).toBeGreaterThan(20);
    rmp.read(["--ticket", penTicket]);
    await rmp.screenshot(page, "08-pdf");
    // Zooming lays the pages out again; a range mark stays on the same spot of its page.
    await dragRange(page, 300, 300);
    const share = () => page.evaluate(() => {
      const frame = document.querySelector("#rmp-overlay-root")!.shadowRoot!.querySelector(".rmp-frame")!.getBoundingClientRect();
      const pages = [...document.querySelectorAll("#viewer .page")].map((element) => element.getBoundingClientRect());
      const index = pages.findIndex((box) => frame.top >= box.top && frame.top <= box.bottom);
      const box = pages[index]!;
      return [index, ...[(frame.left - box.left) / box.width, (frame.top - box.top) / box.height, frame.width / box.width].map((v) => Math.round(v * 100))];
    });
    const pageWidth = () => page.locator("#viewer .page").first().evaluate((element) => element.getBoundingClientRect().width);
    const [shareBefore, widthBefore] = [await share(), await pageWidth()];
    // A press by script is not taken as a mark, so it reaches the zoom button.
    await page.locator("#zoomInButton").evaluate((button: HTMLElement) => button.click());
    await expect.poll(pageWidth).toBeGreaterThan(widthBefore * 1.05);
    await expect.poll(share).toEqual(shareBefore);
    await rmp.screenshot(page, "08-pdf-zoomed");
    const normal = await rmp.open();
    await normal.locator("#rmp-overlay-root").getByRole("button", { name: "撮影" }).click();
    await expect(normal.locator("#rmp-overlay-root .rmp-still")).toBeAttached();
    await normal.keyboard.press("Enter");
    await expect(normal.locator("#rmp-overlay-root").getByRole("button", { name: "注釈 1 のコメント" })).toBeVisible();
    await rmp.send(normal);
    const captureTicket = await rmp.ticket();
    const capture = (await rmp.annotations(captureTicket))[0] as { kind: string; image?: string };
    expect(capture.kind).toBe("capture");
    expect(capture.image).toMatch(/^data:image\/jpeg;base64,/);
    expect((await pixels(normal, capture.image!)).dark).toBeGreaterThan(20);
    await rmp.screenshot(normal, "08-normal-capture");
    rmp.read(["--ticket", captureTicket]);
    await normal.keyboard.press("Tab");
    await expect(normal.locator("#rmp-overlay-root .rmp-still")).toBeAttached();
    // The still covers the window. ponytail: its pixel size is not checked; Playwright fakes the viewport, so the
    // tab capture here is the real window's size, not innerWidth x devicePixelRatio as in a real Chrome.
    expect(await normal.evaluate(() => document.querySelector("#rmp-overlay-root")!.shadowRoot!.querySelector(".rmp-still")!.getBoundingClientRect().width))
      .toBe(await normal.evaluate(() => innerWidth));
    await normal.mouse.move(100, 120);
    await normal.mouse.down();
    await normal.mouse.move(220, 200);
    await normal.mouse.up();
    await rmp.screenshot(normal, "08-pen-drawing");
    await normal.keyboard.press("Enter");
    // The first click after leaving 📷 closes the comment instead of marking the element under it.
    await expect(normal.locator("#rmp-overlay-root textarea")).toBeVisible();
    await expect(normal.locator("#rmp-overlay-root .rmp-mark")).toHaveCount(1);
    await normal.mouse.click(400, 400);
    await expect(normal.locator("#rmp-overlay-root .rmp-mark")).toHaveCount(1);
    await rmp.send(normal);
    const normalPen = (await rmp.annotations(await rmp.ticket()))[0] as { kind: string; image?: string; imageRect?: { x: number; y: number; width: number; height: number } };
    expect(normalPen.kind).toBe("pen");
    // The rect is in the image's pixels; here the tab capture is the real window's size (Playwright fakes the viewport).
    const penImage = await pixels(normal, normalPen.image!);
    const scale = penImage.width / await normal.evaluate(() => innerWidth);
    expect(normalPen.imageRect).toEqual({ x: Math.round(88 * scale), y: Math.round(108 * scale), width: Math.round(144 * scale), height: Math.round(104 * scale) });
    expect(penImage.red).toBeGreaterThan(20);
    // A file pdf.js cannot read says so on screen instead of leaving an empty page.
    const broken = await page.context().newPage();
    await broken.goto(`chrome-extension://${await rmp.extensionId()}/pdfjs/web/viewer.html?file=${encodeURIComponent(rmp.url("/not-a.pdf"))}`);
    await expect(broken.locator("#rmp-load-error")).toContainText("PDF を読めませんでした");
    await expect(broken.getByRole("button", { name: "ファイルを選ぶ" })).toBeVisible();
    await rmp.screenshot(broken, "08-pdf-load-error");
    await broken.close();
    // A PDF on disk (macOS names kana in NFD) opens through file://; this needs the file host permission, not only the toggle.
    const localName = "保守体制スライド.pdf".normalize("NFD");
    const localDir = await mkdtemp(join(tmpdir(), "rmp-local-"));
    await writeFile(join(localDir, localName), body);
    const local = await page.context().newPage();
    await local.goto(`chrome-extension://${await rmp.extensionId()}/pdfjs/web/viewer.html?file=${encodeURIComponent(`file://${localDir}/${encodeURIComponent(localName)}`)}`);
    await expect(local.locator("#viewer .page")).toHaveCount(2);
    await expect(local.locator("#rmp-load-error")).toHaveCount(0);
    await local.close();
    const picker = await page.context().newPage();
    await picker.goto(`chrome-extension://${await rmp.extensionId()}/pdfjs/web/viewer.html`);
    await picker.locator("#fileInput").setInputFiles({ name: "picked.pdf", mimeType: "application/pdf", buffer: body });
    await expect(picker.locator("#viewer .page")).toHaveCount(2);
    // Fonts not embedded in the PDF still give text, and a 2x screen gets a 2x canvas.
    await (await picker.context().newCDPSession(picker)).send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 2, mobile: false });
    await picker.locator("#fileInput").setInputFiles({ name: "ja.pdf", mimeType: "application/pdf", buffer: japanesePdf() });
    await expect(picker.locator("#viewer .page")).toHaveCount(1);
    await expect(picker.locator(".textLayer")).toHaveText("日本語");
    expect(await picker.locator("#viewer .page canvas").first().evaluate((c: HTMLCanvasElement) => c.width / c.clientWidth)).toBeCloseTo(2, 1);
    expect(await picker.locator("#viewer .page canvas").first().evaluate((c: HTMLCanvasElement) => {
      const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      let dark = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark += 1;
      return dark;
    })).toBeGreaterThan(50);
  });
});

test("9 印のある要素をもう一度押すと、新しい印を作らずその印のコメント欄を開く", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const field = overlay.locator("textarea");
    await expect(overlay.locator(".rmp-modes").getByRole("button", { name: "要素", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.mouse.click(460, 225);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    await field.fill("最初のコメント");
    await overlay.locator(".rmp-state").click();
    await page.mouse.click(460, 225);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    await expect(field).toHaveValue("最初のコメント");
  });
});

test("13 PDF の要素モードは、分かれた文字の部品を 1 行にまとめて印にし、大きく離れた段と ⌘ では分ける", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const viewer = await page.context().newPage();
    await viewer.goto(`chrome-extension://${await rmp.extensionId()}/pdfjs/web/viewer.html`);
    await viewer.locator("#fileInput").setInputFiles({ name: "fragments.pdf", mimeType: "application/pdf", buffer: fragmentedPdf() });
    const piece = (text: string) => viewer.locator(".textLayer span", { hasText: new RegExp(`^${text}$`) });
    await expect(piece("Fra")).toHaveCount(1);
    await expect(piece("gmen")).toHaveCount(1);
    const overlay = viewer.locator("#rmp-overlay-root");
    const centre = async (text: string) => { const box = (await piece(text).boundingBox())!; return [box.x + box.width / 2, box.y + box.height / 2] as const; };
    await viewer.mouse.click(...await centre("Fra"));
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    await overlay.locator("textarea").fill("行");
    await overlay.locator(".rmp-state").click();
    await viewer.mouse.click(...await centre("ted"));
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    await viewer.keyboard.down("Meta");
    await viewer.mouse.click(...await centre("gmen"));
    await viewer.keyboard.up("Meta");
    await expect(overlay.locator(".rmp-mark")).toHaveCount(2);
    await overlay.locator(".rmp-state").click();
    await viewer.mouse.click(...await centre("Far"));
    await expect(overlay.locator(".rmp-mark")).toHaveCount(3);
    // Away from the text the page itself is under the pointer: no hover box over the whole page, no mark.
    const pageBox = (await viewer.locator("#viewer .page").first().boundingBox())!;
    await viewer.mouse.move(pageBox.x + pageBox.width / 2, pageBox.y + pageBox.height * 0.7);
    await expect(overlay.locator(".rmp-hover")).toHaveCount(0);
    await viewer.mouse.click(pageBox.x + pageBox.width / 2, pageBox.y + pageBox.height * 0.7);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(3);
    await rmp.screenshot(viewer, "13-pdf-line");
    await rmp.send(viewer);
    const marks = await rmp.annotations(await rmp.ticket()) as Array<{ kind: string; text?: string; element?: { text: string } }>;
    expect(marks.map((mark) => mark.text ?? mark.element?.text)).toEqual(["Fragmented", "gmen", "Far"]);
    expect(marks[0]!.kind).toBe("text");
  });
});

test("10 段落の中の太字を押すと段落に印、⌘ を押すと太字だけに印", async () => {
  await withFixture(1, async (rmp) => {
    rmp.setSite((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<p id='para' style='margin:200px 100px;font:20px sans-serif'>段落の文 <b id='bold'>太字</b> の続き</p>");
    });
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const bold = await page.locator("#bold").boundingBox();
    await page.mouse.click(bold!.x + 5, bold!.y + 5);
    await overlay.locator("textarea").fill("段落");
    await page.keyboard.press("Enter");
    await page.keyboard.down("Meta");
    await page.mouse.click(bold!.x + 5, bold!.y + 5);
    await page.keyboard.up("Meta");
    await overlay.locator("textarea").fill("太字");
    await rmp.send(page);
    const annotations = await rmp.annotations(await rmp.ticket()) as Array<{ element?: { selector?: string } }>;
    expect(annotations.map((a) => a.element?.selector)).toEqual(["#para", "#bold"]);
    await rmp.screenshot(page, "10-pick");
  });
});

test("11 キー: Esc で空の印を消す、Backspace で選んだ印を消す、Shift+Tab で逆順、一覧の 0 で宛先なし", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const marks = overlay.locator(".rmp-mark");
    const mode = (name: string) => overlay.getByRole("group", { name: "モード (Tab で切り替え)" }).getByRole("button", { name, exact: true });
    // The main bar keeps one width whichever mode it is in.
    const widths = [];
    for (const name of ["撮影", "要素"]) {
      await mode(name).click();
      widths.push(await overlay.locator(".rmp-toolbar").evaluate((bar) => Math.round(bar.getBoundingClientRect().width)));
    }
    expect(widths).toEqual([widths[0], widths[0]]);
    await page.mouse.click(460, 225);
    await expect(marks).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(marks).toHaveCount(0);
    await page.mouse.click(460, 225);
    await overlay.locator("textarea").fill("消す");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    await expect(marks).toHaveCount(0);
    await page.keyboard.press("Shift+Tab");
    await expect(mode("撮影")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(mode("要素")).toHaveAttribute("aria-pressed", "true");
    await page.mouse.click(460, 225);
    await overlay.locator("textarea").fill("宛先なしで送る");
    await page.keyboard.press("Enter");
    await overlay.locator(".rmp-chip").click();
    await expect(overlay.locator(".rmp-list")).toBeVisible();
    await page.keyboard.press("0");
    // Picking from the chip only sets the destination: the mark stays until ⌘Enter.
    await expect(overlay.locator(".rmp-toast")).toContainText("宛先を決めました");
    await expect(marks).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(overlay.locator(".rmp-toast")).toContainText("手で: コピーしました", { timeout: 15_000 });
    await expect(marks).toHaveCount(0);
  });
});

test("12 rmv のサイドパネルは最後に送った会話の rmv を出す", async () => {
  await withFixture(2, async (rmp) => {
    const page = await rmp.open();
    await dragRange(page);
    await page.locator("#rmp-overlay-root textarea").fill("パネル");
    await rmp.send(page, sids[1]);
    const panel = await rmp.openExtensionPage("sidepanel.html");
    await expect(panel.locator("#rmv")).toHaveAttribute("src", /\/\?s=term%201$/, { timeout: 10_000 });
  });
});

test("15 要素モードで文字の上から押すと文字を選び、余白から押すと矩形になる", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const drag = async ([x, y]: number[], [toX, toY]: number[]) => {
      await page.mouse.move(x!, y!);
      await page.mouse.down();
      await page.mouse.move(toX!, toY!, { steps: 5 });
      await page.mouse.up();
    };
    const line = await page.evaluate(() => {
      // A page that focuses its own field on mouseup must not take the focus from the comment.
      const field = document.body.appendChild(document.createElement("input"));
      addEventListener("mouseup", () => field.focus());
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("main")!.firstChild!);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, middle: box.top + box.height / 2 };
    });
    await drag([line.left + 2, line.middle], [(line.left + line.right) / 2, line.middle]);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    await expect(overlay.locator("textarea")).toBeFocused();
    await overlay.locator("textarea").fill("文字");
    // Shift adds the next selection to the open comment, as with elements.
    await page.keyboard.down("Shift");
    await drag([(line.left + line.right) / 2 + 2, line.middle], [line.right - 2, line.middle]);
    await page.keyboard.up("Shift");
    await expect(overlay.locator(".rmp-mark")).toHaveCount(2);
    await expect(overlay.locator(".rmp-card strong")).toHaveText("注釈 1, 2");
    await page.keyboard.press("Enter");
    // From the blank part of the same box, the drag still draws a range.
    await drag([line.left + 2, line.middle + 50], [line.left + 150, line.middle + 100]);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(3);
    await expect(overlay.locator("textarea")).toBeFocused();
    await overlay.locator("textarea").fill("矩形");
    await page.keyboard.press("Enter");
    await rmp.screenshot(page, "15-text-first");
    await rmp.send(page);
    const annotations = await rmp.annotations(await rmp.ticket()) as { kind: string; text?: string; comment?: string }[];
    expect(annotations.map((a) => a.kind)).toEqual(["text", "text", "range"]);
    expect(annotations[0]!.text).toMatch(/^実際の/);
    expect(annotations[1]!.text).toMatch(/です$/);
    expect(annotations.map((a) => a.comment)).toEqual(["文字", "文字", "矩形"]);
  });
});

test("16 ショートカットで引っ込めても送る前の注釈は残り、× で閉じると消える", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    await dragRange(page);
    await overlay.locator("textarea").fill("残す");
    await rmp.trigger(page);
    await expect(overlay).not.toBeAttached();
    // While hidden, a click is the page's own.
    await page.evaluate(() => document.querySelector("main")!.addEventListener("click", () => document.body.dataset.clicked = "yes"));
    await page.mouse.click(150, 200);
    await expect(page.locator("body")).toHaveAttribute("data-clicked", "yes");
    await rmp.trigger(page);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    await overlay.locator(".rmp-mark").click();
    await expect(overlay.locator("textarea")).toHaveValue("残す");
    await overlay.getByRole("button", { name: "終了" }).click();
    await rmp.trigger(page);
    await expect(overlay.locator(".rmp-toolbar")).toBeVisible();
    await expect(overlay.locator(".rmp-mark")).toHaveCount(0);
  });
});

// The page area where a wheel waits for a blocking handler, read from Chrome's compositor layers.
async function wheelWaitArea(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  type Layer = { scrollRects?: Array<{ type: string; rect: { width: number; height: number } }> };
  const layers = new Promise<Layer[]>((done) => cdp.on("LayerTree.layerTreeDidChange", (event) => { if (event.layers) done(event.layers as Layer[]); }));
  await cdp.send("LayerTree.enable");
  // A frame with a change in it, so the layers are sent.
  await page.evaluate(() => new Promise((done) => { document.body.style.outline = document.body.style.outline ? "" : "0 solid transparent"; requestAnimationFrame(() => requestAnimationFrame(done)); }));
  const area = (await layers).flatMap((layer) => layer.scrollRects ?? []).filter((rect) => rect.type === "WheelEventHandler")
    .reduce((sum, { rect }) => sum + rect.width * rect.height, 0);
  await cdp.detach();
  return area;
}

test("14 ペンの道具バーは中央下に出て、メインバーと道具バーは背景をドラッグして動かせる", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const box = async (selector: string) => (await overlay.locator(selector).boundingBox())!;
    const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
    // Outside the pen no wheel waits for us: a window-wide blocking handler let Chrome scroll fixed bars away (kirara).
    expect(await wheelWaitArea(page)).toBe(0);
    await overlay.getByRole("button", { name: "撮影" }).click();
    await expect(overlay.locator(".rmp-still")).toBeAttached();
    expect(await wheelWaitArea(page)).toBeGreaterThan(0);
    const pen = await box(".rmp-penbar");
    expect(Math.round(pen.x + pen.width / 2)).toBe(Math.round(width / 2));
    expect(Math.round(pen.y + pen.height)).toBe(height - 24);
    for (const [selector, by] of [[".rmp-penbar", { x: -200, y: -300 }], [".rmp-toolbar", { x: -300, y: 200 }]] as const) {
      const before = await box(selector);
      // Grab the bar's own padding, not a button.
      await page.mouse.move(before.x + 3, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + 3 + by.x, before.y + before.height / 2 + by.y, { steps: 5 });
      await page.mouse.up();
      const after = await box(selector);
      expect([Math.round(after.x - before.x), Math.round(after.y - before.y)]).toEqual([by.x, by.y]);
    }
    // The pen bar keeps its spot when it is drawn again (a tool change re-renders it).
    const moved = await box(".rmp-penbar");
    await overlay.getByRole("button", { name: "矢印", exact: true }).click();
    expect(await box(".rmp-penbar")).toEqual(moved);
    await overlay.getByRole("button", { name: "やめる" }).click();
    await expect(overlay.locator(".rmp-still")).not.toBeAttached();
    expect(await wheelWaitArea(page)).toBe(0);
  });
});

test("17 コメント欄で打った j / k はページの近道キーに届かない", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    // Like GitHub: a page shortcut on document that skips keys typed in a field of its own.
    await page.evaluate(() => document.addEventListener("keydown", (event) => {
      if ("jk".includes(event.key) && !(event.target instanceof HTMLTextAreaElement)) document.body.dataset.shortcut = event.key;
    }));
    await dragRange(page);
    await overlay.locator("textarea").focus();
    await page.keyboard.type("jk");
    await expect(overlay.locator("textarea")).toHaveValue("jk");
    await expect(page.locator("body")).not.toHaveAttribute("data-shortcut");
  });
});

test("18 コメント欄は背景をドラッグして動かせ、再描画でも印の横へ戻らず、そのまま打てる", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const card = overlay.locator(".rmp-card");
    await dragRange(page);
    await overlay.locator("textarea").fill("前");
    const before = (await card.boundingBox())!;
    // Grab the card's own padding, not the field or a button.
    await page.mouse.move(before.x + 4, before.y + 4);
    await page.mouse.down();
    await page.mouse.move(before.x + 4 + 150, before.y + 4 + 60, { steps: 5 });
    await page.mouse.up();
    const after = (await card.boundingBox())!;
    expect([Math.round(after.x - before.x), Math.round(after.y - before.y)]).toEqual([150, 60]);
    await page.evaluate(() => dispatchEvent(new Event("resize")));
    expect(await card.boundingBox()).toEqual(after);
    await overlay.locator("textarea").focus();
    await page.keyboard.type("後");
    await expect(overlay.locator("textarea")).toHaveValue("前後");
  });
});

test("19 保存したコメントは印の下に 1 行だけ出て、長いものは省略され、押すとコメント欄が開く", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const field = overlay.locator("textarea");
    const note = overlay.locator(".rmp-note");
    await dragRange(page);
    await field.fill("とても長いコメントの 1 行目".repeat(6));
    await field.press("Shift+Enter");
    await field.pressSequentially("2 行目");
    // The note of the comment being written is not shown.
    await expect(note).toHaveCount(0);
    await field.press("Enter");
    await expect(field).toBeHidden();
    await expect(note).toHaveCount(1);
    await expect(note).toHaveText(/1 行目 …$/);
    expect(await note.evaluate((el) => el.scrollWidth > el.clientWidth && el.getBoundingClientRect().height < 30)).toBe(true);
    await note.click();
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(/2 行目$/);
    await expect(note).toHaveCount(0);
  });
});

// Like bdui: a press on the dialog itself (its backdrop) closes it, Esc closes it; and like other sites, a click whose
// point is outside the dialog's box closes it too. The bar sits outside the box, so its clicks must not get there.
// #early comes first in the document but is opened later, on top of #d.
function modalSite(_request: unknown, response: import("node:http").ServerResponse): void {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<main style='margin:80px'>裏のページ</main>
    <dialog id='early' style='width:200px;height:100px'>前の dialog</dialog>
    <dialog id='d' style='width:300px;height:160px;overflow:hidden'><p id='inside' style='font:20px sans-serif'>ダイアログの中の文</p></dialog>
    <script>
      const d = document.getElementById("d");
      d.dataset.cancels = "0";
      d.dataset.keys = "0";
      d.addEventListener("cancel", () => { d.dataset.cancels = String(Number(d.dataset.cancels) + 1); });
      d.addEventListener("keydown", () => { d.dataset.keys = String(Number(d.dataset.keys) + 1); });
      d.addEventListener("mousedown", (e) => { if (e.target === d) d.close(); });
      d.addEventListener("click", (e) => { const r = d.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); });
      d.showModal();
    </script>`);
}

test("20 ページが showModal で出したダイアログの上でもバーが押せ、印を付けて送れ、閉じると元に戻る", async () => {
  await withFixture(1, async (rmp) => {
    rmp.setSite(modalSite);
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const dialog = page.locator("#d");
    const reachable = async () => page.evaluate(() => {
      const bar = document.querySelector("#rmp-overlay-root")!.shadowRoot!.querySelector(".rmp-toolbar")!.getBoundingClientRect();
      return document.elementFromPoint(bar.left + 20, bar.top + bar.height / 2)?.id;
    });
    const parent = () => page.evaluate(() => document.querySelector("#rmp-overlay-root")?.parentElement?.id || document.querySelector("#rmp-overlay-root")?.parentElement?.tagName);
    // The modal was open before the bar came up.
    await expect(dialog).toHaveAttribute("open", "");
    expect(await reachable()).toBe("rmp-overlay-root");
    await overlay.locator(".rmp-modes").getByRole("button", { name: "要素", exact: true }).click({ timeout: 3_000 });
    await expect(dialog).toHaveAttribute("open", "");
    // A mark on the text inside the dialog, and Esc in its comment closes the comment only.
    const inside = (await page.locator("#inside").boundingBox())!;
    await page.mouse.click(inside.x + 5, inside.y + 5);
    await overlay.locator("textarea").fill("中の文");
    await overlay.locator("textarea").press("Escape");
    await expect(overlay.locator("textarea")).toBeHidden();
    await expect(dialog).toHaveAttribute("open", "");
    await expect(dialog).toHaveAttribute("data-cancels", "0");
    await rmp.send(page);
    await expect(dialog).toHaveAttribute("open", "");
    const annotations = await rmp.annotations(await rmp.ticket()) as Array<{ comment?: string; element?: { selector?: string } }>;
    expect(annotations.map((a) => [a.element?.selector, a.comment])).toEqual([["#inside", "中の文"]]);
    // Closed: the bar goes back under <html>; opened again after the bar: it follows into the dialog.
    await page.evaluate(() => (document.getElementById("d") as HTMLDialogElement).close());
    await expect.poll(parent).toBe("HTML");
    await page.evaluate(() => (document.getElementById("d") as HTMLDialogElement).showModal());
    await expect.poll(parent).toBe("d");
    expect(await reachable()).toBe("rmp-overlay-root");
    // With nothing of ours open, Esc is the page's: its dialog closes (so the 0 above was rmp keeping it).
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveAttribute("data-cancels", "1");
    await expect.poll(parent).toBe("HTML");
    await page.evaluate(() => (document.getElementById("d") as HTMLDialogElement).showModal());
    await expect.poll(parent).toBe("d");
    // The page drops the open dialog from the document: the bar stays.
    await page.evaluate(() => document.getElementById("d")!.remove());
    await expect.poll(parent).toBe("HTML");
    await overlay.locator(".rmp-modes").getByRole("button", { name: "要素", exact: true }).click({ timeout: 3_000 });
  });
});

test("21 ダイアログの中で打った文字はダイアログに届かず、移動でコメント欄のフォーカスが外れず、後から開いた上のダイアログへ移り、背景を押して閉じても印は残る", async () => {
  await withFixture(1, async (rmp) => {
    rmp.setSite(modalSite);
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const field = overlay.locator("textarea");
    const dialog = page.locator("#d");
    const parent = () => page.evaluate(() => document.querySelector("#rmp-overlay-root")?.parentElement?.id || document.querySelector("#rmp-overlay-root")?.parentElement?.tagName);
    const focused = () => page.evaluate(() => document.querySelector("#rmp-overlay-root")!.shadowRoot!.activeElement?.tagName);
    await expect.poll(parent).toBe("d");
    const inside = (await page.locator("#inside").boundingBox())!;
    await page.mouse.click(inside.x + 5, inside.y + 5);
    await field.pressSequentially("ab");
    await expect(field).toHaveValue("ab");
    await expect(dialog).toHaveAttribute("data-keys", "0");
    // A dialog earlier in the document, opened later, is the one on top.
    await page.evaluate(() => (document.getElementById("early") as HTMLDialogElement).showModal());
    await expect.poll(parent).toBe("early");
    expect(await focused()).toBe("TEXTAREA");
    await page.evaluate(() => (document.getElementById("early") as HTMLDialogElement).close());
    await expect.poll(parent).toBe("d");
    expect(await focused()).toBe("TEXTAREA");
    await page.keyboard.type("c");
    await expect(field).toHaveValue("abc");
    await field.press("Enter");
    // In the element mode a press on the backdrop is still the page's: its dialog closes, the bar goes back, the mark stays.
    await page.mouse.click(5, 5);
    await expect(dialog).not.toHaveAttribute("open");
    await expect.poll(parent).toBe("HTML");
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
  });
});

test("22 PDF の要素モードは、折り返して続く行を 1 段落にまとめて印にし、見出し・次の段落・表の別の行では分ける", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    // The PDF is printed from HTML by Chromium, as the documents this was made for. The table is indented so that
    // only the step between its rows (not the short first row) keeps them apart.
    const paragraph = "この段落は二行以上に折り返すほどの文章です。要素モードで押すと、折り返した行も含めて段落の全体が一つの印になり、送る注釈にも段落の全文が入ることを確かめるために置いています。";
    const maker = await page.context().newPage();
    await maker.setContent(`<body style="margin:0;padding:24px;width:480px;font:14px/1.4 sans-serif">
      <h2 style="margin:0 0 12px;padding:4px 8px;background:#1e3a5f;color:#fff;font-size:16px">職務要約</h2>
      <p style="margin:0 0 4px">${paragraph}</p>
      <p style="margin:0 0 12px">次の段落は短い。</p>
      <table style="margin-left:80px;border-collapse:collapse"><tr><td style="padding:6px 8px">2024/04</td><td style="padding:6px 8px">受託開発</td></tr>
      <tr><td style="padding:6px 8px">2025/01</td><td style="padding:6px 8px">保守契約</td></tr></table></body>`);
    const pdf = await maker.pdf({ width: "560px", height: "420px" });
    await maker.close();
    const viewer = await page.context().newPage();
    await viewer.goto(`chrome-extension://${await rmp.extensionId()}/pdfjs/web/viewer.html`);
    await viewer.locator("#fileInput").setInputFiles({ name: "paragraph.pdf", mimeType: "application/pdf", buffer: pdf });
    const overlay = viewer.locator("#rmp-overlay-root");
    const first = viewer.locator(".textLayer span", { hasText: /^この段落は/ });
    await expect(first).toHaveCount(1);
    const line = (await first.boundingBox())!;
    // The start of the paragraph's next line: the leftmost piece one line further down.
    const next = await viewer.evaluate(({ top, height }) => [...document.querySelectorAll(".textLayer span")].map((span) => span.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.top > top + height / 2 && box.top < top + 2 * height).sort((a, b) => a.left - b.left)[0]!.toJSON() as DOMRect, { top: line.y, height: line.height });
    const at = (text: RegExp) => viewer.locator(".textLayer span", { hasText: text }).first().boundingBox().then((box) => [box!.x + box!.width / 2, box!.y + box!.height / 2] as const);
    await viewer.mouse.click(next.x + 4, next.y + next.height / 2);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    const frame = (await overlay.locator(".rmp-frame").boundingBox())!;
    expect(frame.height).toBeGreaterThan(2 * line.height);
    await overlay.locator("textarea").fill("段落");
    await overlay.locator(".rmp-state").click();
    // The first line is the same paragraph: its mark opens again instead of a second one.
    await viewer.mouse.click(line.x + 4, line.y + line.height / 2);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
    await expect(overlay.locator("textarea")).toHaveValue("段落");
    await overlay.locator(".rmp-state").click();
    for (const [text, count] of [[/^職務要約/, 2], [/^次の段落/, 3], [/^2024\/04/, 4], [/^2025\/01/, 5]] as const) {
      await viewer.mouse.click(...await at(text));
      await expect(overlay.locator(".rmp-mark")).toHaveCount(count);
      await overlay.locator("textarea").fill("別");
      // The card opens below the mark, over the next lines; saving closes it.
      await overlay.getByRole("button", { name: "保存", exact: true }).click();
    }
    await viewer.mouse.move(line.x + 4, line.y + line.height / 2);
    await rmp.screenshot(viewer, "22-pdf-paragraph");
    await rmp.send(viewer);
    const marks = await rmp.annotations(await rmp.ticket()) as Array<{ kind: string; text?: string }>;
    // pdf.js gives some kanji as radicals (⼈ for 人; NFKC maps these back, not ⻑ for 長, which the text avoids).
    expect(marks.map((mark) => mark.text?.normalize("NFKC"))).toEqual([paragraph, "職務要約", "次の段落は短い。", "2024/04 受託開発", "2025/01 保守契約"]);
  });
});

test("22 コメント欄が開いている時に文字キーが欄の外へ届くか、なぞった直後にページから焦点が抜けると、焦点の記録を下書きの注釈に付ける", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const field = overlay.locator("textarea");
    const tabId = await rmp.tabId(page);
    const logs = async () => {
      try {
        const draft = JSON.parse(await readFile(join(rmp.inboxRoot, "drafts", `${tabId}.json`), "utf8")) as { annotations: { focusLog?: string[] }[] };
        return draft.annotations.map((a) => a.focusLog?.join("\n") ?? "");
      } catch { return []; }
    };
    await page.mouse.click(460, 225);
    // Keys that reach the comment leave no record.
    await page.keyboard.type("ab");
    await expect(field).toHaveValue("ab");
    await expect.poll(logs).toEqual([""]);
    // The card stays open but the focus is gone, as the user saw: the next character key is recorded once.
    await field.evaluate((element) => element.blur());
    await page.keyboard.type("cd");
    await expect(overlay.locator(".rmp-toast")).toContainText("焦点の記録を取りました");
    await expect.poll(async () => (await logs())[0]).toContain("文字キーがコメント欄の外に届いた");
    const first = (await logs())[0]!;
    expect(first).toContain("key 文字キー → body");
    expect(first.match(/コメント欄の外に届いた/g)).toHaveLength(1);
    await page.keyboard.press("Escape");
    // A text drag, then the page itself loses the focus (to a side panel, the address bar).
    const line = await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("main")!.firstChild!);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, middle: box.top + box.height / 2 };
    });
    await page.mouse.move(line.left + 2, line.middle);
    await page.mouse.down();
    await page.mouse.move((line.left + line.right) / 2, line.middle, { steps: 5 });
    await page.mouse.up();
    await expect(field).toBeFocused();
    await page.evaluate(() => dispatchEvent(new Event("blur")));
    await expect.poll(async () => (await logs()).at(-1)).toContain("なぞった直後にページから焦点が抜けた");
  });
});

test("24 送ると部品一覧が付き、point の番号に赤枠が出てその部品までスクロールし、× か部品を押すまで残る", async () => {
  await withFixture(1, async (rmp) => {
    rmp.setSite((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<title>設定</title><main style="margin:80px;width:420px;height:160px">実際の注釈対象です</main>
        <h2>アカウント</h2><a href="#profile">プロフィール</a>
        <label>パスワード <input type="password" value="秘密の値"></label>
        <label>メモ <textarea>秘密のメモ</textarea></label><label>色 <select><option>選んだ色</option></select></label>
        <input type="submit" value="送信する" onclick="return false">
        <button style="display:none">隠れた部品</button><button aria-label="閉じる">×</button>
        <div style="height:2400px"></div>
        <h2>通知の設定</h2><button id="save" onclick="document.body.dataset.saved=Number(document.body.dataset.saved||0)+1">通知を保存</button>`);
    });
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    await dragRange(page);
    await overlay.locator("textarea").fill("通知の設定どこ?");
    await rmp.send(page);
    // The side panel the send opened narrows what a capture sees; close it so the capture below shows the frame's place.
    await rmp.closeSidePanel();
    const ticket = await rmp.ticket();
    const [first] = await rmp.annotations(ticket) as Array<{ parts: { n: number; kind: string; text: string }[]; partsTotal: number }>;
    expect(first.parts).toEqual([
      { n: 1, kind: "h2", text: "アカウント" }, { n: 2, kind: "link", text: "プロフィール" },
      { n: 3, kind: "input:password", text: "パスワード" }, { n: 4, kind: "textarea", text: "メモ" },
      { n: 5, kind: "select", text: "色" }, { n: 6, kind: "input:submit", text: "送信する" },
      { n: 7, kind: "button", text: "×" }, { n: 8, kind: "h2", text: "通知の設定" }, { n: 9, kind: "button", text: "通知を保存" },
    ]);
    expect(first.partsTotal).toBe(9);
    for (const secret of ["秘密の値", "秘密のメモ", "選んだ色"]) expect(JSON.stringify(first)).not.toContain(secret);
    expect(rmp.read(["--ticket", ticket])).toContain("#9 button 「通知を保存」");
    const point = (numbers: string, note: string) => execFileSync("python3", [join(root, "inbox/rmp-inbox.py"), "point", ticket, numbers, note], { env: rmp.env });
    const frames = page.locator("#rmp-point-root");

    // A capture taken while a frame is out does not show it (#1 is in view: a capture right after a scroll comes out blank headless).
    point("1", "");
    await expect(frames.locator(".frame")).toBeVisible({ timeout: 8_000 });
    await overlay.getByRole("button", { name: "撮影" }).click();
    await expect(overlay.locator(".rmp-still")).toBeAttached();
    await page.keyboard.press("Enter");
    await overlay.locator("textarea").fill("撮影");
    await rmp.send(page);
    const captureTicket = (await rmp.tickets()).find((value) => value !== ticket)!;
    const [capture] = await rmp.annotations(captureTicket) as Array<{ kind: string; image: string }>;
    expect(capture.kind).toBe("capture");
    expect((await pixels(page, capture.image)).red).toBeLessThan(100);

    point("9", "保存はここです");
    await expect(frames.locator(".label")).toContainText("Claude: 保存はここです", { timeout: 8_000 });
    await expect(page.locator("#save")).toBeInViewport();
    await expect.poll(async () => {
      const [frame, target] = await Promise.all([frames.locator(".frame").boundingBox(), page.locator("#save").boundingBox()]);
      return frame && target ? Math.abs(frame.x + 4 - target.x) + Math.abs(frame.y + 4 - target.y) : Infinity;
    }).toBeLessThan(2);
    await rmp.screenshot(page, "24-point");
    // × with the bar out removes the frame and does not become a mark.
    await expect(frames.locator(".frame")).toBeVisible();
    await frames.getByRole("button", { name: "赤枠を消す" }).click();
    await expect(frames).not.toBeAttached();
    await expect(overlay.locator(".rmp-mark")).toHaveCount(0);

    // With the bar out, pressing the framed part reaches the page instead of marking it.
    await overlay.locator(".rmp-modes").getByRole("button", { name: "要素", exact: true }).click();
    point("9", "");
    await expect(frames.locator(".frame")).toBeVisible({ timeout: 8_000 });
    await page.locator("#save").click();
    await expect(page.locator("body")).toHaveAttribute("data-saved", "1");
    await expect(frames).not.toBeAttached();
    await expect(overlay.locator(".rmp-mark")).toHaveCount(0);

    // A newer point while the bar is hidden; pressing the part itself is the user having found it.
    await rmp.trigger(page);
    await expect(overlay).not.toBeAttached();
    point("8,9", "");
    await expect(frames.locator(".frame")).toHaveCount(2, { timeout: 8_000 });
    await page.locator("#save").click();
    await expect(page.locator("body")).toHaveAttribute("data-saved", "2");
    await expect(frames).not.toBeAttached();
  });
});

test("25 ページが拡張に問い合わせられない時は、赤枠の代わりに理由を出し、point はページが受け取っていないと返す", async () => {
  await withFixture(1, async (rmp) => {
    rmp.setSite((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<main style='margin:80px;width:420px;height:160px'>実際の注釈対象です</main><button>保存</button>");
    });
    const page = await rmp.open();
    await dragRange(page);
    await rmp.send(page);
    const ticket = await rmp.ticket();
    const point = () => execFileSync("python3", [join(root, "inbox/rmp-inbox.py"), "point", ticket, "1"],
      { env: { ...rmp.env, RMP_POINT_WAIT: "5" } }).toString();
    // The page's asks reach the extension: point hears that the page took it.
    expect(point()).toContain("ページが受け取りました");
    // The extension alone is reloaded (as when its service worker is older or newer than the page's script).
    await rmp.reloadExtension();
    const notice = page.locator("#rmp-point-root .label", { hasText: "Claude の赤枠を受け取れません" });
    await expect(notice).toBeVisible({ timeout: 8_000 });
    await expect(notice).toContainText("拡張を再読み込みしてから、このタブも再読み込みしてください");
    // The frame already out stays (it goes only on a press or its ×).
    await expect(page.locator("#rmp-point-root .frame")).toBeVisible();
    await rmp.screenshot(page, "25-point-notice");
    expect(point()).toContain("ページがまだ受け取っていません");
    await notice.getByRole("button", { name: "案内を消す" }).click();
    await expect(notice).not.toBeAttached();
    await expect(page.locator("#rmp-point-root .frame")).toBeVisible();
  });
});

test("26 スクロールせず絵ごと動くページ (地図) でも、要素・文字・範囲・ペンの注釈が付いてきて、画面外では何も残らない", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    await page.evaluate(() => {
      document.body.innerHTML = `<div id="view" style="position:fixed;inset:0;overflow:hidden"><div id="world" style="position:absolute;left:0;top:0;transform-origin:0 0">
        <p id="a" style="position:absolute;left:120px;top:100px;width:260px;margin:0">要素の注釈を付ける段落</p>
        <p id="b" style="position:absolute;left:120px;top:200px;width:260px;margin:0">文字をなぞる<b>ための段落</b>です</p>
        <div style="position:absolute;left:120px;top:320px;width:300px;height:120px;background:#eee"><span>範囲を囲む部品</span></div>
        <svg style="position:absolute;left:600px;top:120px" width="200" height="160"><rect width="200" height="160" fill="#ddd"/></svg></div></div>`;
    });
    const drag = async (from: number[], to: number[]) => {
      await page.mouse.move(from[0]!, from[1]!);
      await page.mouse.down();
      await page.mouse.move(to[0]!, to[1]!, { steps: 5 });
      await page.mouse.up();
    };
    const comment = async (text: string) => { await page.keyboard.type(text); await page.keyboard.press("Enter"); };
    await page.mouse.click(370, 108);
    await comment("a");
    await drag([124, 208], [280, 208]);
    await comment("b");
    // On a part, then on the blank between the parts (nothing of the map under it).
    await drag([300, 380], [400, 430]);
    await comment("c");
    await drag([470, 350], [560, 420]);
    await comment("d");
    await overlay.getByRole("button", { name: "撮影" }).click();
    await expect(overlay.locator(".rmp-still")).toBeAttached();
    await drag([630, 150], [740, 230]);
    await page.keyboard.press("Enter");
    await expect(overlay.locator(".rmp-mark")).toHaveCount(5);
    await comment("e");
    const look = () => page.evaluate(() => {
      const shadow = document.querySelector("#rmp-overlay-root")!.shadowRoot!;
      const frames = [...shadow.querySelectorAll(".rmp-frame")].map((frame) => { const { x, y, width, height } = frame.getBoundingClientRect(); return [x, y, width, height]; });
      const canvas = shadow.querySelector<HTMLCanvasElement>(".rmp-canvas")!, dpr = devicePixelRatio;
      const { data, width, height } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      let [l, t, r, b] = [Infinity, Infinity, -1, -1];
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 128) { const x = (i >> 2) % width, y = Math.floor((i >> 2) / width); l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); }
      const shown = [...shadow.querySelectorAll<HTMLElement>(".rmp-frame,.rmp-mark,.rmp-note")].filter((part) => {
        const box = part.getBoundingClientRect();
        return box.width && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
      }).length;
      // The stroke is 4px wide at any zoom: its middle, not its edge, is what moves.
      return { frames, ink: r < 0 ? null : [l / dpr + 2, t / dpr + 2, (r + 1) / dpr - 2, (b + 1) / dpr - 2], shown };
    });
    const move = async (x: number, y: number, k: number) => {
      await page.evaluate(([x, y, k]) => { document.querySelector<HTMLElement>("#world")!.style.transform = `translate(${x}px,${y}px) scale(${k})`; }, [x, y, k]);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      return look();
    };
    const start = await look();
    expect(start.frames).toHaveLength(5);
    expect(start.shown).toBe(15);
    for (const [x, y, k] of [[150, 90, 1], [-60, -50, 1], [40, 30, 0.6], [-100, -80, 1.3], [0, 0, 1]] as const) {
      const now = await move(x, y, k);
      start.frames.forEach(([left, top, width, height], index) => {
        [x + left! * k, y + top! * k, width! * k, height! * k].forEach((value, side) =>
          expect(Math.abs(now.frames[index]![side]! - value), `注釈 ${index + 1} の ${"xywh"[side]} (${x},${y} ×${k})`).toBeLessThan(2));
      });
      start.ink!.forEach((value, side) => expect(Math.abs(now.ink![side]! - ((side % 2 ? y : x) + value * k)), `ペンの線 ${side} (${x},${y} ×${k})`).toBeLessThan(2));
      if (k === 0.6) await rmp.screenshot(page, "26-map-zoomed-out");
    }
    for (const [x, y] of [[-1500, 0], [2500, 0], [0, -1500], [0, 2500]] as const) expect((await move(x, y, 1)).shown).toBe(0);
    expect((await move(0, 0, 1)).shown).toBe(15);
    // Pressing a mark while the map keeps moving still opens its comment.
    await page.evaluate(() => { let n = 0; setInterval(() => { document.querySelector<HTMLElement>("#world")!.style.transform = `translate(${(n += 1) % 2}px,0)`; }, 16); });
    await overlay.locator(".rmp-mark").nth(2).click({ force: true, delay: 120 });
    await expect(overlay.locator("textarea")).toHaveValue("c");
    await page.keyboard.press("Enter");
    await rmp.send(page);
    const annotations = await rmp.annotations(await rmp.ticket()) as { kind: string; comment?: string }[];
    expect(annotations.map((a) => `${a.kind} ${a.comment}`)).toEqual(["dom a", "text b", "range c", "range d", "pen e"]);
  });
});
