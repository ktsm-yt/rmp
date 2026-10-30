import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";

const root = resolve("..");

export const sids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

type Mode = "now" | "draft" | "permission" | "stale" | "slow";
type TargetInfo = { type: string; url: string; targetId: string };

// A bare browser-level CDP client. Playwright's connectOverCDP auto-attaches with
// waitForDebuggerOnStart, which can leave the extension service worker paused when it (re)starts.
class RawCdp {
  private next = 1;
  private waiting = new Map<number, { done: (value: unknown) => void; fail: (error: Error) => void }>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const entry = reply.id === undefined ? undefined : this.waiting.get(reply.id);
      if (!entry) return;
      this.waiting.delete(reply.id!);
      if (reply.error) entry.fail(new Error(reply.error.message));
      else entry.done(reply.result);
    });
  }

  static async connect(port: number): Promise<RawCdp> {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10_000) })).json() as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("CDP WebSocket did not open")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); done(undefined); });
      socket.addEventListener("error", () => { clearTimeout(timer); fail(new Error("CDP WebSocket error")); });
    });
    return new RawCdp(socket);
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.waiting.delete(id); fail(new Error(`CDP ${method} timed out`)); }, 10_000);
      this.waiting.set(id, { done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    });
  }

  close(): void { this.socket.close(); }
}

export async function dragRange(page: Page, x = 100, y = 120): Promise<void> {
  const overlay = page.locator("#rmp-overlay-root");
  // The comment card opens below a mark; save it first so the next drag does not start on the card.
  if (await overlay.locator(".rmp-card").isVisible()) await overlay.getByRole("button", { name: "保存", exact: true }).click();
  const element = overlay.locator(".rmp-modes").getByRole("button", { name: "要素", exact: true });
  await element.click();
  await expect(element).toHaveAttribute("aria-pressed", "true");
  // ⌥ draws a range even when the press lands on text.
  await page.keyboard.down("Alt");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 140, y + 55);
  await page.mouse.up();
  await page.keyboard.up("Alt");
}

export function twoPagePdf(): Buffer {
  const first = "BT /F1 24 Tf 40 430 Td (First page) Tj ET\n";
  const second = "BT /F1 24 Tf 40 430 Td (Second page) Tj ET\n";
  const stream = (content: string) => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  return pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(first),
    stream(second),
  ]);
}

// One line written in three pieces (fonts alternate, so pdf.js keeps them apart) and a far column on the same line.
export function fragmentedPdf(): Buffer {
  const content = "BT /F1 24 Tf 40 430 Td (Fra) Tj ET\nBT /F2 24 Tf 77 430 Td (gmen) Tj ET\nBT /F1 24 Tf 131 430 Td (ted) Tj ET\nBT /F1 24 Tf 300 430 Td (Far) Tj ET\n";
  return pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ]);
}

// One page whose font is not embedded (UniJIS-UCS2-H, as many Japanese PDFs): its text needs pdf.js's cMaps.
export function japanesePdf(): Buffer {
  const content = `BT /F1 24 Tf 40 430 Td <${Buffer.from("日本語", "utf16le").swap16().toString("hex")}> Tj ET\n`;
  return pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 6 0 R >>",
    "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ]);
}

function pdfFrom(objects: string[]): Buffer {
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  const table = offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${text}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "binary");
}

async function port(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const value = (server.address() as { port: number }).port;
      server.close(() => done(value));
    });
  });
}

async function wait(url: string): Promise<void> {
  for (let count = 0; count < 50; count += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error(`${url} が起動しませんでした`);
}

function lstart(pid: number): string {
  return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).toString().trim().replace(/\s+/g, " ");
}

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

async function kill(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await done;
}

async function extensionIdFromManifest(): Promise<string> {
  const { key } = JSON.parse(await readFile(join(root, "extension", "manifest.json"), "utf8")) as { key: string };
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
}

export class RmpFixture {
  readonly temp!: string;
  readonly inboxRoot!: string;
  readonly env!: NodeJS.ProcessEnv;
  readonly calls: string[] = [];
  private context: BrowserContext | undefined;
  private cdp: RawCdp | undefined;
  private extensionIdValue = "";
  private inbox: ChildProcess | undefined;
  private sleepers: ChildProcess[] = [];
  private rmv: Server | undefined;
  private site: Server | undefined;
  private debugPort!: number;
  private siteHandler = (_: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<main style='margin:80px;width:420px;height:160px'>実際の注釈対象です</main>");
  };
  mode: Mode = "now";
  rmvAvailable = true;

  constructor(private readonly videoDir?: string) {}

  async start(sessionCount = 1): Promise<void> {
    const inboxPort = await port();
    const rmvPort = await port();
    this.debugPort = await port();
    await mkdir(join(root, "extension/e2e-results"), { recursive: true }); // a fresh clone has no e2e-results yet
    (this as { temp: string }).temp = await mkdtemp(join(root, "extension/e2e-results/case-"));
    (this as { inboxRoot: string }).inboxRoot = join(this.temp, "inbox");
    const sessions = join(this.temp, "sessions");
    const tmpdir = join(this.temp, "tmp");
    await mkdir(sessions, { recursive: true });
    await mkdir(tmpdir, { recursive: true });
    const { RMP_INBOX_ORIGINS: _origins, CLAUDE_PID: _pid, ...inherited } = process.env;
    (this as { env: NodeJS.ProcessEnv }).env = {
      ...inherited,
      HOME: join(this.temp, "home"),
      TMPDIR: tmpdir,
      RMP_INBOX_PORT: String(inboxPort),
      RMP_INBOX_ROOT: this.inboxRoot,
      RMP_INBOX_NO_NOTIFY: "1",
      RMP_CLAUDE_SESSIONS: sessions,
      RMP_RMV_URL: `http://127.0.0.1:${rmvPort}`,
    };
    await mkdir(this.env.HOME!, { recursive: true });
    for (let index = 0; index < sessionCount; index += 1) {
      const child = spawn("/bin/sleep", ["600"], { env: this.env });
      this.sleepers.push(child);
      await new Promise((done) => setTimeout(done, 20));
      await writeFile(join(sessions, `${child.pid}.json`), JSON.stringify({
        pid: child.pid,
        sessionId: sids[index],
        kind: "interactive",
        procStart: lstart(child.pid!),
        cwd: root,
      }));
      execFileSync("python3", [join(root, "inbox/rmp-inbox.py"), "hook-session"], {
        env: this.env,
        input: JSON.stringify({ session_id: sids[index], cwd: root, hook_event_name: "SessionStart" }),
      });
    }
    this.rmv = createServer((request, response) => {
      if (request.url === "/sessions") {
        if (!this.rmvAvailable) {
          response.statusCode = 503;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.setHeader("x-rmv-live", "ok");
        response.end(JSON.stringify(sids.slice(0, sessionCount).map((sid, index) => ({ sid, session: `term ${index}`, live: true, deliverable: true }))));
        return;
      }
      if (request.url === "/ext/deliver" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          this.calls.push(body === "{}" ? "probe" : "deliver");
          if (body === "{}") {
            response.statusCode = 400;
            response.end("probe");
            return;
          }
          if (this.mode === "slow") {
            setTimeout(() => response.end(JSON.stringify({ ok: true })), 8500);
            return;
          }
          if (this.mode === "draft" || this.mode === "permission" || this.mode === "stale") {
            response.statusCode = 409;
            response.end(this.mode);
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((done) => this.rmv!.listen(rmvPort, "127.0.0.1", done));
    this.inbox = spawn("python3", [join(root, "inbox/rmp-inbox.py"), "serve"], { env: this.env, stdio: "ignore" });
    execFileSync("node", ["build.mjs", "--test"], {
      cwd: join(root, "extension"),
      env: { ...this.env, RMP_TEST_INBOX_PORT: String(inboxPort), RMP_TEST_RMV_PORT: String(rmvPort) },
    });
    await wait(`http://127.0.0.1:${inboxPort}/sessions?url=http://example.test/`);
    this.context = await chromium.launchPersistentContext(await mkdtemp(join(this.temp, "profile-")), {
      channel: "chromium",
      headless: true,
      env: this.env,
      ignoreDefaultArgs: ["--disable-extensions"],
      recordVideo: this.videoDir ? { dir: this.videoDir } : undefined,
      args: [
        "--use-mock-keychain",
        "--password-store=basic",
        "--enable-unsafe-extension-debugging",
        `--remote-debugging-port=${this.debugPort}`,
        `--disable-extensions-except=${resolve("dist-test")}`,
        `--load-extension=${resolve("dist-test")}`,
      ],
    });
    this.extensionIdValue = await extensionIdFromManifest();
    this.cdp = await RawCdp.connect(this.debugPort);
    // Poll instead of waitForEvent: a worker that started before the listener never fires the event.
    await expect.poll(() => this.context!.serviceWorkers().length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(new URL(this.context.serviceWorkers()[0].url()).host).toBe(this.extensionIdValue);
    this.site = createServer((request, response) => this.siteHandler(request, response));
    await new Promise<void>((done) => this.site!.listen(0, "127.0.0.1", done));
  }

  url(path = "/"): string {
    return `http://127.0.0.1:${(this.site!.address() as { port: number }).port}${path}`;
  }

  setSite(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void): void {
    this.siteHandler = handler;
  }

  async extensionId(): Promise<string> {
    return this.extensionIdValue;
  }

  private async actionTarget(page: Page): Promise<TargetInfo> {
    const targets = await this.cdp!.send("Target.getTargets", { filter: [{}] }) as { targetInfos: TargetInfo[] };
    const target = targets.targetInfos.find((entry) => entry.type === "tab" && entry.url === page.url());
    if (!target) {
      throw new Error(`対象タブがありません: ${JSON.stringify(targets.targetInfos.map((entry) => [entry.type, entry.url]))}`);
    }
    return target;
  }

  async trigger(page: Page): Promise<void> {
    const target = await this.actionTarget(page);
    await this.cdp!.send("Extensions.triggerAction", { id: this.extensionIdValue, targetId: target.targetId });
  }

  /** An extension page (sidepanel.html...) opened as a plain tab. */
  async openExtensionPage(path: string): Promise<Page> {
    const page = await this.context!.newPage();
    await page.goto(`chrome-extension://${this.extensionIdValue}/${path}`);
    return page;
  }

  async open(path = "/"): Promise<Page> {
    const context = this.context!;
    await Promise.all(context.pages().map((page) => page.close()));
    const page = await context.newPage();
    const origin = this.url("").replace(/\/$/, "");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.goto(this.url(path));
    // ponytail: the service worker may not listen yet right after launch, so press the toolbar
    // button again (at most 6 times) only while no overlay appeared; evaluating inside the worker hung.
    for (let attempt = 1; ; attempt += 1) {
      await this.trigger(page);
      try {
        await expect(page.locator("#rmp-overlay-root")).toBeAttached({ timeout: 4_000 });
        return page;
      } catch (error) {
        if (attempt < 6) continue;
        const targets = await this.cdp!.send("Target.getTargets", { filter: [{}] }) as { targetInfos: TargetInfo[] };
        throw new Error(`注釈 overlay が起動しませんでした: targets=${JSON.stringify(targets.targetInfos.map((target) => [target.type, target.url]))}`, { cause: error });
      }
    }
  }

  async openPdf(path = "/document.pdf"): Promise<Page> {
    const context = this.context!;
    await Promise.all(context.pages().map((page) => page.close()));
    const source = await context.newPage();
    const opened = context.waitForEvent("page");
    await source.goto(this.url(path));
    await this.trigger(source);
    const viewer = await opened;
    await viewer.waitForLoadState();
    await expect(viewer.locator("#rmp-overlay-root")).toBeAttached();
    return viewer;
  }

  async send(page: Page, sid = sids[0]): Promise<void> {
    const overlay = page.locator("#rmp-overlay-root");
    const before = await this.tickets(sid);
    const destination = overlay.locator(`.rmp-list button[data-sid="${sid}"]`);
    await overlay.locator(".rmp-chip").click();
    await expect(overlay.locator(".rmp-list")).toBeVisible();
    await expect(destination).toBeVisible({ timeout: 10_000 });
    await destination.click();
    await overlay.getByRole("button", { name: "送る", exact: true }).click();
    await expect.poll(() => this.tickets(sid), { timeout: 15_000 }).toHaveLength(before.length + 1);
    await expect(overlay.locator(".rmp-mark")).toHaveCount(0, { timeout: 15_000 });
    await expect(overlay.locator(".rmp-toast")).toContainText(/届けました|コピーしました|知らせます|待っています/, { timeout: 15_000 });
    // The overlay ignores toolbar and list clicks until the previous send has fully finished.
    await expect(overlay.locator(".rmp-toolbar")).not.toContainText("送信中", { timeout: 15_000 });
  }

  async tickets(sid = sids[0]): Promise<string[]> {
    try {
      return (await readdir(join(this.inboxRoot, "new", sid))).filter((value) => value.endsWith(".json")).map((value) => value.slice(0, -5));
    } catch {
      return [];
    }
  }

  async ticket(sid = sids[0]): Promise<string> {
    const ticket = (await this.tickets(sid))[0];
    if (!ticket) throw new Error("送信 ticket がありません");
    return ticket;
  }

  async annotations(ticket: string, sid = sids[0]): Promise<unknown[]> {
    return JSON.parse(await readFile(join(this.inboxRoot, "new", sid, `${ticket}.json`), "utf8"));
  }

  async readTickets(): Promise<string[]> {
    try {
      return (await readdir(join(this.inboxRoot, "read"))).filter((value) => value.endsWith(".json"));
    } catch {
      return [];
    }
  }

  read(args: string[]): string {
    return execFileSync("python3", [join(root, "inbox/rmp-inbox.py"), "read", ...args], { env: this.env }).toString();
  }

  async screenshot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: `e2e-results/screenshots/${name}.png` });
  }

  async tabId(page: Page): Promise<number> {
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.locator("#rmp-overlay-root").getByRole("button", { name: "タブ ID" }).click();
    // The copy finishes after a round trip to the service worker, so wait for the clipboard to change.
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\d+$/);
    return Number(await page.evaluate(() => navigator.clipboard.readText()));
  }

  async stop(): Promise<void> {
    this.cdp?.close();
    await this.context?.close();
    await close(this.site);
    await close(this.rmv);
    await kill(this.inbox);
    await Promise.all(this.sleepers.map(kill));
  }
}
