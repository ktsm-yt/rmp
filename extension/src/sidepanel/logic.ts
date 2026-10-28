import type { LastTarget } from "../inboxSend";

/** The rmv page for the conversation the last send went to. rmv's ?s= takes rmv's own terminal
 *  key (`session` in its GET /sessions), not the Claude session id; without a match, narrow by
 *  ?repo=<folder>. */
export function rmvPanelUrl(base: string, target: LastTarget | null, sessions: unknown): string {
  const root = `${base}/`;
  if (!target) return root;
  const hit = Array.isArray(sessions)
    ? sessions.find((s) => typeof s === "object" && s !== null && s.sid === target.sid)
    : undefined;
  if (typeof hit?.session === "string") return `${root}?s=${encodeURIComponent(hit.session)}`;
  const repo = target.cwd.replace(/\/+$/, "").split("/").pop();
  return repo ? `${root}?repo=${encodeURIComponent(repo)}` : root;
}
