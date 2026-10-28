import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// e2e デモ録画用ナレーション helper (DEMO_NARRATE=1 のときだけ動く)。
// 仕組み: say (Mac 標準 TTS) で音声を生成し、その再生長ぶんテストを待たせる。
// 動画は待機中の画面をそのまま録るので、後段の ffmpeg 合成 (scripts/e2e-demo-video.sh)
// で timestamp どおりに音声を重ねればナレーションと画面が同期する。
// shortcut: t0 は newPage 直前の近似。Playwright の録画開始順が変わったら frame で較正する。

type Segment = { t: number; file: string; dur: number; text: string };

let t0 = 0;
let audioDir = "";
let segmentFile = "";
let segments: Segment[] = [];

export function initNarration(outDir: string, name: string): void {
  t0 = Date.now();
  // 音声だけ tmp に逃がす。outDir は Playwright のテスト名を含み、
  // 日本語テスト名だと `say -o <そのパス>` が失敗する。segments は outDir に
  // 置いたまま (e2e-demo-video.sh が videos.json から読む)。
  // aiff の在り処は segments[].file の絶対パスで伝わる。
  segmentFile = join(outDir, `segments-${name}.json`);
  audioDir = mkdtempSync(join(tmpdir(), "rmp-narrate-"));
  mkdirSync(outDir, { recursive: true });
  segments = [];
}

export async function narrate(page: Page, text: string): Promise<void> {
  if (!process.env.DEMO_NARRATE) return;
  const file = join(audioDir, `seg-${segments.length}.aiff`);
  execFileSync("say", ["-v", process.env.DEMO_VOICE ?? "Kyoko", "-o", file, text]);
  const dur = Number.parseFloat(
    execFileSync("ffprobe", [
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ])
      .toString()
      .trim(),
  );
  // t は say 生成完了後 = 音声再生を開始すべき動画内時刻
  segments.push({ t: (Date.now() - t0) / 1000, file, dur, text });
  writeFileSync(segmentFile, JSON.stringify(segments, null, 2));
  // ナレーション再生長 + 間 300ms ぶん画面を止める
  await page.waitForTimeout(dur * 1000 + 300);
}
