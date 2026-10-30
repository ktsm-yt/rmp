import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const test = process.argv.includes("--test");
const inboxPort = test ? process.env.RMP_TEST_INBOX_PORT ?? "18766" : "8766";
const rmvPort = test ? process.env.RMP_TEST_RMV_PORT ?? "14310" : "4310";
const firefox = process.argv.includes("--firefox");
const outdir = `${test ? "dist-test" : "dist"}${firefox ? "-firefox" : ""}`;
let manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.host_permissions = [
  `http://127.0.0.1:${inboxPort}/*`,
  `http://127.0.0.1:${rmvPort}/*`,
  // The viewer page reads a local PDF by XHR; the file-access toggle alone does not grant that without a file host (2026-10-26, headless: 0 pages without, 15 with).
  "file:///*",
];
if (firefox) {
  // Firefox runs an event page instead of a service worker, and shows rmv in its sidebar.
  const { key, side_panel, commands: { "open-rmv-panel": panel, ...commands }, ...rest } = manifest;
  manifest = {
    ...rest,
    permissions: rest.permissions.filter((name) => name !== "sidePanel"),
    background: { scripts: ["background.js"], type: "module" },
    commands: { ...commands, _execute_sidebar_action: panel },
    sidebar_action: { default_panel: side_panel.default_path, default_title: "rmv", open_at_install: false },
    browser_specific_settings: {
      gecko: { id: "red-marker-page@ktsm-yt.github.io", strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } },
    },
  };
}
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("icons", `${outdir}/icons`, { recursive: true });
await cp("public", outdir, { recursive: true });
await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
await build({
  entryPoints: ["src/background.ts", "src/inboxSend.ts"],
  bundle: true,
  format: "esm",
  outdir,
  define: {
    __RMP_INBOX_BASE_URL__: JSON.stringify(`http://127.0.0.1:${inboxPort}`),
    __RMP_RMV_BASE_URL__: JSON.stringify(`http://127.0.0.1:${rmvPort}`),
  },
});

// Glue for the vendored pdf.js viewer (public/pdfjs, scripts/vendor-pdfjs.sh); a classic script in its page.
await build({ entryPoints: { viewer: "src/viewer/index.ts" }, bundle: true, format: "iife", outdir });

await build({
  entryPoints: { sidepanel: "src/sidepanel/index.ts" },
  bundle: true,
  format: "esm",
  outdir,
  define: { __RMP_RMV_BASE_URL__: JSON.stringify(`http://127.0.0.1:${rmvPort}`) },
});

await build({
  entryPoints: { overlay: "src/overlay/index.ts" },
  bundle: true,
  format: "iife",
  outdir,
});
