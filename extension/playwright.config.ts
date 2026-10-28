import { defineConfig } from "@playwright/test";

export default defineConfig({ testDir: "e2e", timeout: 30_000, workers: 1, use: { headless: true, screenshot: "off", video: process.env.DEMO_NARRATE ? "on" : "off" } });
