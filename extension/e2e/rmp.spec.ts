import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dragRange, fragmentedPdf, japanesePdf, RmpFixture, sids, twoPagePdf } from "./fixtures.js";

test.setTimeout(120_000);

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
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("main")!.firstChild!);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, middle: box.top + box.height / 2 };
    });
    await drag([line.left + 2, line.middle], [(line.left + line.right) / 2, line.middle]);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(1);
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

test("14 ペンの道具バーは中央下に出て、メインバーと道具バーは背景をドラッグして動かせる", async () => {
  await withFixture(1, async (rmp) => {
    const page = await rmp.open();
    const overlay = page.locator("#rmp-overlay-root");
    const box = async (selector: string) => (await overlay.locator(selector).boundingBox())!;
    const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
    await overlay.getByRole("button", { name: "撮影" }).click();
    await expect(overlay.locator(".rmp-still")).toBeAttached();
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
