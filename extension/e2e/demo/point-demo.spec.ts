import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Video } from "@playwright/test";
import { RmpFixture } from "../fixtures.js";
import { initNarration, narrate } from "./narrate.js";

// A real page and a real Claude: the spec sends "where is it?" and waits while Claude reads the read output
// written to RMP_POINT_DEMO_DIR/read.txt and answers with `rmp-inbox.py point` (env in point-env.sh there).
const url = process.env.RMP_POINT_DEMO_URL;
const question = process.env.RMP_POINT_DEMO_QUESTION ?? "この設定どこ?";
test.skip(!process.env.DEMO_NARRATE || !url, "DEMO_NARRATE=1 と RMP_POINT_DEMO_URL がある時だけ録画する");

test("Claude がページを調べて、ここですと赤枠で示す", async ({}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const output = testInfo.outputPath(".");
  const handoff = process.env.RMP_POINT_DEMO_DIR ?? output;
  mkdirSync(handoff, { recursive: true });
  const rmp = new RmpFixture(output);
  let page: Page | undefined;
  let video: Video | null = null;
  try {
    await rmp.start(1);
    initNarration(output, "web");
    page = await rmp.open(url);
    video = page.video();
    const overlay = page.locator("#rmp-overlay-root");
    await narrate(page, "どこを見ればいいか分からない時は、画面全体に印を付けて聞きます。");
    await overlay.getByRole("button", { name: "撮影" }).click();
    await expect(overlay.locator(".rmp-still")).toBeAttached();
    await page.keyboard.press("Enter");
    await overlay.locator("textarea").fill(question);
    await narrate(page, "送ると、ページの見出しやボタンの一覧も一緒に届きます。");
    await rmp.send(page);
    await rmp.closeSidePanel();
    const ticket = await rmp.ticket();
    writeFileSync(join(handoff, "point-env.sh"), `export RMP_INBOX_ROOT='${rmp.inboxRoot}' RMP_INBOX_NO_NOTIFY=1 TICKET='${ticket}'\n`);
    writeFileSync(join(handoff, "read.txt"), rmp.read(["--ticket", ticket]));
    await narrate(page, "Claude は一覧から番号を選んで返します。");
    await expect(page.locator("#rmp-point-root .label")).toBeVisible({ timeout: 10 * 60_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(handoff, "point.png") });
    await narrate(page, "赤枠が出て、その場所までスクロールしました。押すか、バツで消すまで残ります。");
    await page.locator("#rmp-point-root").getByRole("button", { name: "赤枠を消す" }).click();
    await expect(page.locator("#rmp-point-root")).not.toBeAttached();
    await page.waitForTimeout(800);
  } finally {
    await rmp.stop();
    if (video) writeFileSync(join(output, "videos.json"), JSON.stringify([{ file: await video.path(), segments: "segments-web.json" }], null, 2));
    if (!existsSync(join(handoff, "read.txt"))) writeFileSync(join(handoff, "read.txt"), "(送る前に止まりました)\n");
  }
});
