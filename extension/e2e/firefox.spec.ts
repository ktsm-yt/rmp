// Firefox (or Zen) through WebDriver BiDi: Playwright's Firefox cannot load an extension. The toolbar button is
// pressed from the browser's own window (system access), as a click there would, which also grants activeTab.
// Runs only when RMP_FIREFOX names a Firefox binary, e.g. RMP_FIREFOX=/Applications/Zen.app/Contents/MacOS/zen.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RmpFixture, sids } from "./fixtures.js";

const binary = process.env.RMP_FIREFOX;
const GECKO_ID = "red-marker-page@ktsm-yt.github.io";
// Firefox gives each profile its own moz-extension UUID; this is the one the inbox lets in by default.
const UUID = "e9f3dda0-0bd4-4cb6-b23c-243a430e4c3c";

class Bidi {
  private next = 1;
  private readonly waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as { id?: number; type: string; result?: unknown; message?: string; error?: string };
      const entry = reply.id === undefined ? undefined : this.waiting.get(reply.id);
      if (!entry) return;
      this.waiting.delete(reply.id!);
      if (reply.type === "error") entry.fail(new Error(`${reply.error}: ${reply.message}`));
      else entry.done(reply.result);
    });
  }

  static async connect(port: number): Promise<Bidi> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
        await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error("BiDi WebSocket error")); });
        return new Bidi(socket);
      } catch (error) {
        if (attempt > 60) throw error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((done, fail) => this.waiting.set(id, { done, fail }));
  }

  close(): void { this.socket.close(); }
}

/** A tab driven by BiDi, with trusted mouse and key input as a person would give. */
class Tab {
  constructor(private readonly bidi: Bidi, readonly context: string) {}

  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.bidi.send("script.evaluate", { expression, target: { context: this.context }, awaitPromise: true,
      serializationOptions: { maxObjectDepth: 4 } });
    if (reply.type === "exception") throw new Error(`${expression}: ${reply.exceptionDetails.text}`);
    return deserialize(reply.result) as T;
  }

  async goto(url: string): Promise<void> {
    await this.bidi.send("browsingContext.navigate", { context: this.context, url, wait: "complete" });
  }

  async click(x: number, y: number): Promise<void> {
    await this.bidi.send("input.performActions", { context: this.context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", x: Math.round(x), y: Math.round(y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
  }

  async keys(...values: string[]): Promise<void> {
    await this.bidi.send("input.performActions", { context: this.context, actions: [{ type: "key", id: "keyboard",
      actions: values.flatMap((value) => [{ type: "keyDown", value }, { type: "keyUp", value }]) }] });
  }

  /** Clicks the middle of an element in the overlay's shadow root. */
  async clickOurs(selector: string): Promise<void> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelector("#rmp-overlay-root")?.shadowRoot?.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`rmp の ${selector} がありません`);
    await this.click(box.x, box.y);
  }

  ours(selector: string, what = "!!element"): Promise<unknown> {
    return this.evaluate(`(() => { const element = document.querySelector("#rmp-overlay-root")?.shadowRoot?.querySelector(${JSON.stringify(selector)}); return ${what}; })()`);
  }

  parent(): Promise<string | undefined> {
    return this.evaluate(`(() => { const p = document.querySelector("#rmp-overlay-root")?.parentElement; return p?.id || p?.tagName; })()`);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from((await this.bidi.send("browsingContext.captureScreenshot", { context: this.context })).data, "base64");
  }
}

function deserialize(value: any): unknown {
  if (!value || typeof value !== "object") return value;
  if (value.type === "undefined" || value.type === "null") return value.type === "null" ? null : undefined;
  if (value.type === "array") return value.value.map(deserialize);
  if (value.type === "object") return Object.fromEntries(value.value.map(([key, item]: [string, unknown]) => [key, deserialize(item)]));
  return value.value;
}

class Firefox {
  private child: ChildProcess | undefined;
  private bidi!: Bidi;
  private frames: Buffer[] = [];
  private recording: Promise<void> | undefined;
  private recordingOn = false;
  private chrome!: Tab;
  tab!: Tab;

  async start(rmp: RmpFixture): Promise<void> {
    const inboxPort = rmp.env.RMP_INBOX_PORT!, rmvPort = new URL(rmp.env.RMP_RMV_URL!).port;
    execFileSync("node", ["build.mjs", "--test", "--firefox"], { env: { ...rmp.env, RMP_TEST_INBOX_PORT: inboxPort, RMP_TEST_RMV_PORT: rmvPort } });
    const profile = await mkdtemp(join(rmp.temp, "firefox-profile-"));
    await writeFile(join(profile, "user.js"), [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [GECKO_ID]: UUID }))});`,
      `user_pref("browser.shell.checkDefaultBrowser", false);`,
    ].join("\n"));
    const port = 9300 + Math.floor(Math.random() * 600);
    this.child = spawn(binary!, ["--headless", "-no-remote", "-profile", profile, "--remote-debugging-port", String(port), "--width", "1280", "--height", "800"],
      { stdio: "ignore", env: { ...rmp.env, MOZ_HEADLESS_WIDTH: "1280", MOZ_HEADLESS_HEIGHT: "800", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } });
    this.bidi = await Bidi.connect(port);
    await this.bidi.send("session.new", { capabilities: {} });
    await this.bidi.send("webExtension.install", { extensionData: { type: "path", path: join(process.cwd(), "dist-test-firefox") } });
    // A tab of our own: Zen's first tab is its "empty tab", which extensions are not given (the click passes no tab).
    const created = await this.bidi.send("browsingContext.create", { type: "tab" });
    this.tab = new Tab(this.bidi, created.context);
    const windows = await this.bidi.send("browsingContext.getTree", { "moz:scope": "chrome" });
    this.chrome = new Tab(this.bidi, windows.contexts[0].context);
    await this.bidi.send("browsingContext.setViewport", { context: this.tab.context, viewport: { width: 1280, height: 720 } });
  }

  /** Presses the toolbar button of rmp for the selected tab. */
  async press(): Promise<void> {
    await this.chrome.evaluate(`(() => { const extension = WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)}).extension;
      extension.apiManager.global.browserActionFor(extension).triggerAction(window); })()`);
    await expect.poll(() => this.tab.evaluate(`!!document.querySelector("#rmp-overlay-root")`)).toBe(true);
  }

  record(): void {
    this.recordingOn = true;
    this.recording = (async () => {
      while (this.recordingOn) {
        this.frames.push(await this.tab.screenshot().catch(() => this.frames.at(-1) ?? Buffer.alloc(0)));
        await new Promise((done) => setTimeout(done, 150));
      }
    })();
  }

  /** Stops recording and writes the frames as an mp4 (about 5 frames a second, as captured). */
  async saveVideo(path: string): Promise<void> {
    this.recordingOn = false;
    await this.recording;
    const dir = await mkdtemp(join(path, "..", "frames-"));
    await Promise.all(this.frames.filter((frame) => frame.length).map((frame, index) => writeFile(join(dir, `${String(index).padStart(5, "0")}.png`), frame)));
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-framerate", "5", "-i", join(dir, "%05d.png"),
      "-vf", "scale=1280:-2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
  }

  async stop(): Promise<void> {
    this.recordingOn = false;
    await this.recording?.catch(() => {});
    this.bidi?.close();
    if (this.child && this.child.exitCode === null) {
      const exited = new Promise((done) => this.child!.once("exit", done));
      this.child.kill();
      await exited;
    }
  }
}

const ESCAPE = "\uE00C";
const pause = () => new Promise((done) => setTimeout(done, 700));

test.describe("Firefox", () => {
  test.skip(!binary, "RMP_FIREFOX に Firefox の実行ファイルを指定した時だけ走る");
  test.setTimeout(180_000);

  test("F1 showModal のダイアログの上でもバーが押せ、Esc はコメント欄だけ閉じ、中の要素に印を付けて送れ、閉じると戻る", async () => {
    const rmp = new RmpFixture();
    const firefox = new Firefox();
    try {
      await rmp.start(1);
      rmp.setSite((_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<main style='margin:80px'>裏のページ</main>
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
      });
      await firefox.start(rmp);
      const tab = firefox.tab;
      const open = () => tab.evaluate<boolean>(`document.getElementById("d").open`);
      const data = (name: string) => tab.evaluate<string>(`document.getElementById("d").dataset.${name}`);
      await tab.goto(rmp.url("/"));
      expect(await open()).toBe(true);
      await firefox.press();
      await expect.poll(() => tab.parent()).toBe("d");
      expect(await tab.evaluate(`(() => { const r = document.querySelector("#rmp-overlay-root").shadowRoot.querySelector(".rmp-toolbar").getBoundingClientRect();
        return document.elementFromPoint(r.left + 20, r.top + r.height / 2)?.id; })()`)).toBe("rmp-overlay-root");
      await tab.clickOurs('.rmp-modes button[aria-label="要素"]');
      expect(await open()).toBe(true);
      const inside = await tab.evaluate<{ x: number; y: number }>(`(() => { const r = document.getElementById("inside").getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; })()`);
      await tab.click(inside.x, inside.y);
      await expect.poll(() => tab.ours("textarea")).toBe(true);
      await tab.keys(..."abc");
      expect(await tab.ours("textarea", "element.value")).toBe("abc");
      expect(await data("keys")).toBe("0");
      await tab.keys(ESCAPE);
      await expect.poll(() => tab.ours("textarea")).toBe(false);
      expect(await open()).toBe(true);
      expect(await data("cancels")).toBe("0");
      await tab.clickOurs(".rmp-chip");
      await expect.poll(() => tab.ours(`.rmp-list button[data-sid="${sids[0]}"]`), { timeout: 10_000 }).toBe(true);
      await tab.clickOurs(`.rmp-list button[data-sid="${sids[0]}"]`);
      await tab.clickOurs(".rmp-primary");
      await expect.poll(() => rmp.tickets(), { timeout: 15_000 }).toHaveLength(1);
      expect(await open()).toBe(true);
      const annotations = await rmp.annotations(await rmp.ticket()) as Array<{ comment?: string; element?: { selector?: string } }>;
      expect(annotations.map((a) => [a.element?.selector, a.comment])).toEqual([["#inside", "abc"]]);
      await tab.evaluate(`document.getElementById("d").close()`);
      await expect.poll(() => tab.parent()).toBe("HTML");
      await tab.evaluate(`document.getElementById("d").showModal()`);
      await expect.poll(() => tab.parent()).toBe("d");
      // With nothing of ours open, Esc is the page's: its dialog closes and the bar goes back. A click first, as a
      // person's would: headless, BiDi's keys stop reaching the page some runs after our comment card took the focus.
      await tab.clickOurs('.rmp-modes button[aria-label="要素"]');
      await tab.keys(ESCAPE);
      await expect.poll(open).toBe(false);
      await expect.poll(() => tab.parent()).toBe("HTML");
    } finally {
      await firefox.stop();
      await rmp.stop();
    }
  });

  // Local only: records bdui's issue dialog (http://127.0.0.1:3077) when RMP_BDUI_VIDEO names the mp4 to write.
  test("F2 bdui の issue 詳細モーダルの上でバーを押して送る (録画)", async () => {
    test.skip(!process.env.RMP_BDUI_VIDEO, "RMP_BDUI_VIDEO に録画の保存先を指定した時だけ走る");
    const rmp = new RmpFixture();
    const firefox = new Firefox();
    try {
      await rmp.start(1);
      await firefox.start(rmp);
      const tab = firefox.tab;
      await tab.goto("http://127.0.0.1:3077/");
      firefox.record();
      await expect.poll(() => tab.evaluate(`document.querySelector("tr.issue-row button.id-copy")?.textContent?.trim()`)).toBeTruthy();
      await pause();
      await tab.evaluate(`location.hash = "#/issues?issue=" + encodeURIComponent(document.querySelector("tr.issue-row button.id-copy").textContent.trim())`);
      await expect.poll(() => tab.evaluate(`document.querySelectorAll("dialog:modal").length`)).toBe(1);
      await pause();
      await firefox.press();
      await expect.poll(() => tab.parent()).toBe("issue-dialog");
      await pause();
      await tab.clickOurs('.rmp-modes button[aria-label="要素"]');
      await pause();
      const title = await tab.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector("dialog:modal .issue-dialog__title").getBoundingClientRect(); return { x: r.left + 10, y: r.top + 5 }; })()`);
      await tab.click(title.x, title.y);
      await expect.poll(() => tab.ours("textarea")).toBe(true);
      await tab.keys(..."from Firefox");
      await pause();
      await tab.clickOurs(".rmp-chip");
      await expect.poll(() => tab.ours(`.rmp-list button[data-sid="${sids[0]}"]`), { timeout: 10_000 }).toBe(true);
      await pause();
      await tab.clickOurs(`.rmp-list button[data-sid="${sids[0]}"]`);
      await tab.clickOurs(".rmp-primary");
      await expect.poll(() => rmp.tickets(), { timeout: 15_000 }).toHaveLength(1);
      expect(await tab.evaluate(`document.querySelectorAll("dialog:modal").length`)).toBe(1);
      await pause();
      await pause();
      await firefox.saveVideo(process.env.RMP_BDUI_VIDEO!);
      console.log("sent", JSON.stringify(await rmp.annotations(await rmp.ticket())).slice(0, 300));
    } finally {
      await firefox.stop();
      await rmp.stop();
    }
  });
});

