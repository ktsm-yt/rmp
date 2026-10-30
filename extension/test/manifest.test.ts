import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const forbiddenPermissions = ["debugger", "tabs", "<all_urls>", "tabCapture", "desktopCapture", "downloads", "offscreen", "clipboardWrite"];

export function checkManifest(manifest: Record<string, unknown>) {
  const permissions = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ];
  const contentMatches = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts.flatMap((script) => typeof script === "object" && script !== null && Array.isArray((script as { matches?: unknown }).matches) ? (script as { matches: unknown[] }).matches : [])
    : [];
  return [...permissions, ...contentMatches].filter((permission) => forbiddenPermissions.includes(String(permission)) || String(permission) === "<all_urls>");
}

describe("extension boundary", () => {
  it("keeps the product manifest to the required permissions and id", async () => {
    const manifest = JSON.parse(await readFile(join(root, "dist", "manifest.json"), "utf8")) as Record<string, unknown>;
    const permissions = manifest.permissions as string[];
    const hosts = manifest.host_permissions as string[];
    console.log(`scanned ${permissions.length} permissions`);
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions).toEqual(["activeTab", "scripting", "storage", "sidePanel"]);
    expect(hosts).toEqual(["http://127.0.0.1:8766/*", "http://127.0.0.1:4310/*", "file:///*"]);
    expect(manifest.optional_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
    expect(manifest.content_scripts ?? []).toEqual([]);
    // Not Alt+Shift+C: the old extension and MarkDownload both suggest it in Dia.
    expect((manifest.commands as Record<string, { suggested_key?: unknown }>)["copy-tab-id"].suggested_key).toEqual({ default: "Alt+Shift+I", mac: "MacCtrl+Shift+C" });
    // ⌘⇧: is impossible: chrome.commands accepts only A-Z, 0-9, Comma, Period and named keys.
    expect((manifest.commands as Record<string, { suggested_key?: unknown }>)["toggle-annotate"].suggested_key).toEqual({ default: "Ctrl+Shift+Period", mac: "Command+Shift+Period" });
    expect((manifest.commands as Record<string, { suggested_key?: unknown }>)["open-rmv-panel"].suggested_key).toEqual({ default: "Ctrl+Shift+Comma", mac: "Command+Shift+Comma" });
    expect(checkManifest(manifest)).toEqual([]);
    const hex = createHash("sha256").update(Buffer.from(String(manifest.key), "base64")).digest("hex").slice(0, 32);
    const id = [...hex].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join("");
    expect(id).toBe("kgdkanfbaiakfcncpfdllehhenoplheg");
    expect(execFileSync(process.execPath, [join(root, "tools", "ext-id.mjs")], { encoding: "utf8" }).trim()).toBe(id);
  });

  it("keeps product ports fixed and replaces test build ports", async () => {
    const product = JSON.parse(await readFile(join(root, "dist", "manifest.json"), "utf8")) as { host_permissions: string[] };
    const test = JSON.parse(await readFile(join(root, "dist-test", "manifest.json"), "utf8")) as { host_permissions: string[] };
    expect(product.host_permissions).toEqual(["http://127.0.0.1:8766/*", "http://127.0.0.1:4310/*", "file:///*"]);
    expect(test.host_permissions).not.toEqual(product.host_permissions);
    const testBundle = await readFile(join(root, "dist-test", "inboxSend.js"), "utf8");
    const productBundle = await readFile(join(root, "dist", "inboxSend.js"), "utf8");
    const testBases = test.host_permissions.filter((host) => host.startsWith("http")).map((host) => host.slice(0, -2));
    const productBases = product.host_permissions.filter((host) => host.startsWith("http")).map((host) => host.slice(0, -2));
    for (const base of testBases) expect(testBundle).toContain(base);
    for (const base of productBases) expect(productBundle).toContain(base);
  });
  it("derives the Firefox manifest from the product one", async () => {
    const product = JSON.parse(await readFile(join(root, "dist", "manifest.json"), "utf8")) as Record<string, any>;
    const firefox = JSON.parse(await readFile(join(root, "dist-firefox", "manifest.json"), "utf8")) as Record<string, any>;
    expect(firefox.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(firefox.host_permissions).toEqual(product.host_permissions);
    expect(firefox.background).toEqual({ scripts: ["background.js"], type: "module" });
    expect([firefox.key, firefox.side_panel, firefox.commands["open-rmv-panel"]]).toEqual([undefined, undefined, undefined]);
    expect(firefox.commands._execute_sidebar_action).toEqual(product.commands["open-rmv-panel"]);
    expect(firefox.sidebar_action.default_panel).toBe(product.side_panel.default_path);
    expect(checkManifest(firefox)).toEqual([]);
  });
  it("catches a forbidden permission", () => {
    expect(checkManifest({ permissions: ["tabs"] })).toEqual(["tabs"]);
    expect(checkManifest({ optional_permissions: ["debugger"] })).toEqual(["debugger"]);
    expect(checkManifest({ content_scripts: [{ matches: ["<all_urls>"] }] })).toEqual(["<all_urls>"]);
  });
});
