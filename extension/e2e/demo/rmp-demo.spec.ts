import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type Video } from "@playwright/test";
import { dragRange, RmpFixture, twoPagePdf } from "../fixtures.js";
import { initNarration, narrate } from "./narrate.js";

test.skip(!process.env.DEMO_NARRATE, "DEMO_NARRATE=1 の時だけ録画する");

test("赤入れ、送信、既読の流れ", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const output = testInfo.outputPath(".");
  const rmp = new RmpFixture(output);
  const recordings: Array<{ file: string; segments: string }> = [];
  let page: Page | undefined;
  let pageVideo: Video | null = null;
  let viewer: Page | undefined;
  let viewerVideo: Video | null = null;
  try {
    await rmp.start(1);
    // open() の newPage 直前に時刻を置き、通常ページの録画開始との差を含める。
    initNarration(output, "web");
    page = await rmp.open();
    pageVideo = page.video();
    await narrate(page, "範囲をドラッグして、赤い印とコメントを付けます。");
    await page.keyboard.press("Tab");
    await page.mouse.move(110, 110);
    await page.mouse.down();
    await page.mouse.move(270, 165);
    await page.mouse.up();
    await expect(page.locator("#rmp-overlay-root textarea")).toBeVisible();
    await page.locator("#rmp-overlay-root textarea").fill("確認してください");
    await narrate(page, "日本語入力を確定して、コメントを保存します。");
    const cdp = await page.context().newCDPSession(page);
    await page.locator("#rmp-overlay-root textarea").focus();
    await cdp.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "あ" });
    await page.keyboard.press("Enter");
    await expect(page.locator("#rmp-overlay-root textarea")).toBeHidden();
    await narrate(page, "宛先を選んで送ると、ローカル受信箱に保存されます。");
    await rmp.send(page);
    const ticket = await rmp.ticket();
    await narrate(page, "受信箱で読むと、画面にも読まれたことが表示されます。");
    expect(rmp.read(["--ticket", ticket])).toContain("確認してください");
    await expect(page.locator("#rmp-overlay-root")).toContainText("読まれた", { timeout: 8_000 });
    const pdf = twoPagePdf();
    rmp.setSite((request, response) => {
      if (request.url === "/document.pdf") {
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader("content-type", "application/pdf");
        response.end(pdf);
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<main>Red Marker Page</main>");
    });
    let pdfNarrationStarted = false;
    const context = page.context();
    const viewerStarted = new Promise<void>((resolve) => {
      context.on("page", (candidate) => {
        void candidate.waitForURL(/viewer\.html/).then(() => {
          if (pdfNarrationStarted) return;
          pdfNarrationStarted = true;
          initNarration(output, "pdf");
          resolve();
        }).catch(() => {});
      });
    });
    viewer = await rmp.openPdf();
    await viewerStarted;
    viewerVideo = viewer.video();
    await narrate(viewer, "PDF でも二ページに三つの範囲印を付けて、画像付きで送れます。");
    await expect(viewer.locator("#viewer .page")).toHaveCount(2);
    await dragRange(viewer, 100, 110);
    await dragRange(viewer, 280, 210);
    await viewer.evaluate(() => { document.querySelector("#viewerContainer")!.scrollTop = 850; });
    await dragRange(viewer, 130, 180);
    await viewer.locator("#rmp-overlay-root").getByRole("button", { name: "撮影" }).click();
    await expect(viewer.locator("#rmp-overlay-root .rmp-still")).toBeAttached();
    await viewer.keyboard.press("Enter");
    await expect(viewer.locator("#rmp-overlay-root").getByRole("button", { name: "注釈 4 のコメント" })).toBeVisible();
    await rmp.send(viewer);
    expect(rmp.read(["--ticket", await rmp.ticket()])).toContain("画像:");
  } finally {
    await rmp.stop();
    if (pageVideo) recordings.push({ file: await pageVideo.path(), segments: "segments-web.json" });
    if (viewerVideo) recordings.push({ file: await viewerVideo.path(), segments: "segments-pdf.json" });
    writeFileSync(join(output, "videos.json"), JSON.stringify(recordings, null, 2));
  }
});
