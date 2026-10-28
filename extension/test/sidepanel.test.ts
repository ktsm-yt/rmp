import { describe, expect, it } from "vitest";
import { rmvPanelUrl } from "../src/sidepanel/logic";

const base = "http://127.0.0.1:4310";
const target = { sid: "11111111-1111-4111-8111-111111111111", cwd: "/Users/x/Dev/red-marker-page/", label: "" };

describe("rmv side panel url", () => {
  it("opens rmv's own terminal key, else the folder, else the top", () => {
    expect(rmvPanelUrl(base, target, [{ sid: "other", session: "x" }, { sid: target.sid, session: "w1 t2" }])).toBe(`${base}/?s=w1%20t2`);
    expect(rmvPanelUrl(base, target, null)).toBe(`${base}/?repo=red-marker-page`);
    expect(rmvPanelUrl(base, { ...target, cwd: "" }, [])).toBe(`${base}/`);
    expect(rmvPanelUrl(base, null, [])).toBe(`${base}/`);
  });
});
