import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The browser loads dist/, while e2e only builds dist-test/; a stale dist means asking for a reload that changes nothing.
const newest = (dir: string): number => Math.max(0, ...readdirSync(dir, { withFileTypes: true }).map((entry) =>
  entry.isDirectory() ? newest(join(dir, entry.name)) : statSync(join(dir, entry.name)).mtimeMs));

describe("dist", () => {
  it.skipIf(!existsSync("dist/overlay.js"))("is built from the current src (run node build.mjs)", () => {
    expect(statSync("dist/overlay.js").mtimeMs).toBeGreaterThanOrEqual(Math.max(newest("src"), newest("public"), statSync("manifest.json").mtimeMs));
  });
});
