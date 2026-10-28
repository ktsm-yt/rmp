// Posts the overlay's Send to the local inbox and reports
// what happened, so the overlay can tell the user instead of dropping a failed send silently.

declare const __RMP_INBOX_BASE_URL__: string | undefined;
declare const __RMP_RMV_BASE_URL__: string | undefined;

export const INBOX_BASE_URL =
  typeof __RMP_INBOX_BASE_URL__ === "string" ? __RMP_INBOX_BASE_URL__ : "http://127.0.0.1:8766";
export const INBOX_DONE_URL = `${INBOX_BASE_URL}/done`;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TICKET_RE = /^\d{8}-\d{6}-\d{6}$/;

export type InboxSendReason =
  /** Stored; the target session reads it with `/rmp <ticket>`. */
  | "stored"
  /** Nothing to send. */
  | "empty"
  /** An inbox from before tickets (204, no body): stored, but no ticket to hand out. */
  | "legacy_inbox"
  /** Nothing listens on 127.0.0.1:8766. */
  | "inbox_unreachable"
  /** No answer in time. The inbox stores the file before it answers, so the send may be stored:
   *  the overlay must not say the inbox is down (a resend would store it twice). */
  | "inbox_timeout"
  /** 403: the inbox refused this extension's origin. */
  | "inbox_rejected"
  /** Any other reply. */
  | "inbox_error";

export type InboxSendResult = {
  ok: boolean;
  ticket: string | null;
  where: string | null;
  /** True only once rmv typed `/rmp <ticket>` into the target's terminal (/ext/deliver). */
  delivered: boolean;
  reason: InboxSendReason;
  /** Set when the background asked rmv to type it: how that went (see deliverViaRmv). */
  deliver?: RmvDeliverReason;
  /** "orca" | "herdr" when delivered. */
  via?: string;
  /** True when `/rmp <ticket>` was put on the clipboard (set by the background). */
  copied?: boolean;
};

export type InboxSendOptions = {
  /** Target Claude session id (CLAUDE_CODE_SESSION_ID). Anything else is not sent. */
  to?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url?: string;
};

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function isTicket(value: unknown): value is string {
  return typeof value === "string" && TICKET_RE.test(value);
}

export async function postAnnotationsToInbox(
  annotations: unknown[],
  options: InboxSendOptions = {},
): Promise<InboxSendResult> {
  const result = (
    ok: boolean,
    reason: InboxSendReason,
    ticket: string | null = null,
    where: string | null = null,
  ): InboxSendResult => ({ ok, ticket, where, delivered: false, reason });
  if (annotations.length === 0) return result(true, "empty");
  const headers: Record<string, string> = {};
  // A header, not a body field: an older inbox ignores it and still stores the send.
  if (isSessionId(options.to)) headers["X-RMP-To"] = options.to;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.url ?? INBOX_DONE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(annotations),
      signal: controller.signal,
    });
  } catch {
    return result(false, controller.signal.aborted ? "inbox_timeout" : "inbox_unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 204) return result(true, "legacy_inbox");
  if (response.status === 403) return result(false, "inbox_rejected");
  if (response.status !== 200) return result(false, "inbox_error");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return result(false, "inbox_error");
  }
  const ticket = (body as { ticket?: unknown } | null)?.ticket;
  const where = (body as { where?: unknown } | null)?.where;
  if (!isTicket(ticket)) return result(false, "inbox_error");
  return result(true, "stored", ticket, typeof where === "string" ? where : null);
}

// ---------- Choosing the target session ----------
// The overlay is serialized into the page and cannot import, so the rules for "send now or open
// the list first" live here and the background hands the overlay a ready decision.

/** The list must not hold up ⌘Enter. */
export const SESSIONS_TIMEOUT_MS = 800;

/** One session as the inbox lists it. */
export type InboxSession = {
  sid: string;
  cwd: string;
  name: string;
  updatedAt: number;
  match: { kind: string; reason: string; length?: number } | null;
  last: boolean;
  /** Later stages: herdr label / first line of the request (rmv) and how a send reaches it. */
  label?: string;
  head?: string;
  delivery?: TargetDelivery;
  /** rmv can type into this session's terminal (Orca / herdr, rmv says it is live). */
  deliverable?: boolean;
};

export type SessionsReply =
  | {
      available: true;
      sessions: InboxSession[];
      default: string | null;
      defaultReason: string | null;
    }
  | { available: false };

/** now: rmv types /rmp <ticket> into the terminal (/ext/deliver, opted in on rmv's side) /
 *  next: on the next prompt (rmp's hook) / manual: the user pastes /rmp <ticket>. */
export type TargetDelivery = "now" | "next" | "manual";

/** storage.local "lastTarget": the target of the last stored targeted send. */
export type LastTarget = { sid: string; cwd: string; label: string };

/** What the overlay shows for one session (one row of the list, or the chip). */
export type TargetOption = {
  sid: string;
  label: string;
  folder: string;
  cwd: string;
  head: string;
  delivery: TargetDelivery;
  /** Why it is listed where it is: the guess's evidence, "前回の宛先", or null (newest first). */
  reason: string | null;
  guess: boolean;
  last: boolean;
};

export type PickWhy = "first" | "last_dead" | "tie" | "conflict" | "picked_dead";

export type SendDecision =
  /** to: null sends without a target (new/). */
  | { action: "send"; to: string | null; why: "same" | "last" | "picked" | "unavailable" }
  /** highlight: the row Enter confirms, null when nothing should be preselected (ties). */
  | { action: "pick"; highlight: string | null; why: PickWhy; message: string };

export type TargetList = {
  available: boolean;
  options: TargetOption[];
  decision: SendDecision;
};

const TICKET_STATUS = new Set(["new", "read", "missing"]);

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(raw: unknown): InboxSession | null {
  if (!isRecordLike(raw) || !isSessionId(raw.sid)) return null;
  const match = isRecordLike(raw.match)
    ? {
        kind: String(raw.match.kind ?? ""),
        reason: String(raw.match.reason ?? ""),
        length: typeof raw.match.length === "number" ? raw.match.length : undefined,
      }
    : null;
  const delivery =
    raw.delivery === "now" || raw.delivery === "next" || raw.delivery === "manual"
      ? raw.delivery
      : undefined;
  return {
    sid: raw.sid,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    name: typeof raw.name === "string" ? raw.name : "",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    match,
    last: raw.last === true,
    label: typeof raw.label === "string" ? raw.label : undefined,
    head: typeof raw.head === "string" ? raw.head : undefined,
    delivery,
    deliverable: raw.deliverable === true,
  };
}

/** GET /sessions?url= with an 800 ms cap. Never throws: anything but a well-formed 200 is
 *  {available:false}, and the send goes out without a target. */
export async function fetchInboxSessions(
  url: string,
  last: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; base?: string } = {},
): Promise<SessionsReply> {
  const query = new URLSearchParams({ url });
  if (isSessionId(last)) query.set("last", last);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SESSIONS_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${options.base ?? INBOX_BASE_URL}/sessions?${query}`,
      { signal: controller.signal },
    );
    if (response.status !== 200) return { available: false };
    const body: unknown = await response.json();
    if (!isRecordLike(body) || !Array.isArray(body.sessions)) return { available: false };
    const sessions = body.sessions.map(parseSession).filter((s): s is InboxSession => s !== null);
    return {
      available: true,
      sessions,
      default: isSessionId(body.default) ? body.default : null,
      defaultReason: typeof body.defaultReason === "string" ? body.defaultReason : null,
    };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/** POST /status {ticket}: "new" | "read" | "missing", or null when the inbox did not answer. */
export async function fetchTicketStatus(
  ticket: unknown,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; base?: string } = {},
): Promise<"new" | "read" | "missing" | null> {
  if (!isTicket(ticket)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${options.base ?? INBOX_BASE_URL}/status`,
      { method: "POST", body: JSON.stringify({ ticket }), signal: controller.signal },
    );
    if (response.status !== 200) return null;
    const body: unknown = await response.json();
    const status = isRecordLike(body) ? body.status : undefined;
    return typeof status === "string" && TICKET_STATUS.has(status)
      ? (status as "new" | "read" | "missing")
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parseLastTarget(value: unknown): LastTarget | null {
  if (!isRecordLike(value) || !isSessionId(value.sid)) return null;
  return {
    sid: value.sid,
    cwd: typeof value.cwd === "string" ? value.cwd.slice(0, 1000) : "",
    label: typeof value.label === "string" ? value.label.slice(0, 200) : "",
  };
}

/** The overlay's own choice in this page: {sid} or {sid: null} for "no target". */
export function parsePicked(value: unknown): { sid: string | null } | null {
  if (!isRecordLike(value)) return null;
  if (value.sid === null) return { sid: null };
  return isSessionId(value.sid) ? { sid: value.sid } : null;
}

const folderOf = (cwd: string) => cwd.replace(/\/+$/, "").split("/").pop() ?? "";

const isGuess = (s: InboxSession) => s.match !== null;
const isExact = (s: InboxSession) => s.match !== null && s.match.kind !== "cwd";

/** List order: guesses (exact, then longest cwd) → the previous target → newest. */
export function orderSessions(sessions: InboxSession[], last: string | null): InboxSession[] {
  const rank = (s: InboxSession) =>
    isExact(s) ? 0 : isGuess(s) ? 1 : s.sid === last || s.last ? 2 : 3;
  return [...sessions].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.match?.length ?? 0) - (a.match?.length ?? 0) ||
      (b.updatedAt || 0) - (a.updatedAt || 0),
  );
}

/** The guess from the tab URL: one exact match, else one longest cwd match. Several exact
 *  matches, or several cwds of the same length, are a tie (parallel work in one repo). */
export function guessTarget(sessions: InboxSession[]): { sid: string | null; tie: boolean } {
  const exact = sessions.filter(isExact);
  if (exact.length > 1) return { sid: null, tie: true };
  if (exact.length === 1) return { sid: exact[0]?.sid ?? null, tie: false };
  const prefix = sessions.filter((s) => s.match?.kind === "cwd");
  if (prefix.length === 0) return { sid: null, tie: false };
  const top = Math.max(...prefix.map((s) => s.match?.length ?? 0));
  const tops = prefix.filter((s) => (s.match?.length ?? 0) === top);
  return tops.length === 1 ? { sid: tops[0]?.sid ?? null, tie: false } : { sid: null, tie: true };
}

/**
 * ⌘Enter (誤配の防止). Send at once only when the target is settled:
 *  - picked in this page and still alive (or "no target") → send to it,
 *  - else the previous target is alive and the guess either agrees with it or there is none.
 * Open the list instead when: this is the first send, the previous target has ended, the guess
 * is a tie, or the guess points elsewhere than the previous target. A stopped or slow inbox list
 * keeps a target the user picked in this page (sending to an ended session is safe: the inbox
 * lets every session read it); without one it sends without a target, since nothing confirms
 * the previous target is alive, and new/ is readable by all.
 */
export function decideSendTarget(
  reply: SessionsReply,
  lastTarget: LastTarget | null,
  picked: { sid: string | null } | null,
): SendDecision {
  if (!reply.available) {
    if (picked?.sid === null) return { action: "send", to: null, why: "picked" };
    if (picked && isSessionId(picked.sid)) return { action: "send", to: picked.sid, why: "picked" };
    return { action: "send", to: null, why: "unavailable" };
  }
  const alive = new Set(reply.sessions.map((s) => s.sid));
  const guess = guessTarget(reply.sessions);
  const last = lastTarget?.sid ?? null;
  // A tie preselects nothing, not even the inbox's default: the inbox offers the previous target
  // when no exact match exists, also when cwds of the same length tie (a tie gets no
  // default: parallel work in one repo is where a wrong preselection hurts most).
  const highlight = guess.tie
    ? null
    : reply.default && alive.has(reply.default)
      ? reply.default
      : (guess.sid ?? (last && alive.has(last) ? last : null));
  const pick = (why: PickWhy, message: string): SendDecision => ({
    action: "pick",
    highlight,
    why,
    message,
  });
  if (picked) {
    if (picked.sid === null) return { action: "send", to: null, why: "picked" };
    if (alive.has(picked.sid)) return { action: "send", to: picked.sid, why: "picked" };
    return pick("picked_dead", "選んだ宛先のセッションが終わっている。選び直して");
  }
  if (!last) return pick("first", "初めての送信。宛先を選んで");
  if (!alive.has(last))
    return pick("last_dead", "前回の宛先のセッションが終わっている。選び直して");
  if (guess.tie) return pick("tie", "候補が同じ強さで並んでいる。選んで");
  if (guess.sid && guess.sid !== last) {
    const reason = reply.sessions.find((s) => s.sid === guess.sid)?.match?.reason ?? "推測";
    return pick("conflict", `推測 (${reason}) が前回の宛先と違う。選んで`);
  }
  return { action: "send", to: last, why: guess.sid ? "same" : "last" };
}

/** extDeliver: rmv accepts /ext/deliver from this extension (probeRmvDeliver). Only then does a
 *  deliverable session show "now"; otherwise the inbox's own mark (next / manual) stays. */
export function targetOption(
  s: InboxSession,
  last: string | null,
  extDeliver = false,
): TargetOption {
  const reason = s.match?.reason ?? (s.sid === last ? "前回の宛先" : null);
  return {
    sid: s.sid,
    label: (s.label || s.name || s.sid.slice(0, 8)).slice(0, 80),
    folder: folderOf(s.cwd).slice(0, 80),
    cwd: s.cwd.slice(0, 1000),
    head: (s.head ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
    delivery: extDeliver && s.deliverable ? "now" : (s.delivery ?? "manual"),
    reason,
    guess: isGuess(s),
    last: s.sid === last,
  };
}

/** The background's reply to the session list request. */
export function buildTargetList(
  reply: SessionsReply,
  lastTarget: LastTarget | null,
  picked: { sid: string | null } | null,
  extDeliver = false,
): TargetList {
  const decision = decideSendTarget(reply, lastTarget, picked);
  if (!reply.available) return { available: false, options: [], decision };
  const last = lastTarget?.sid ?? null;
  return {
    available: true,
    options: orderSessions(reply.sessions, last).map((s) => targetOption(s, last, extDeliver)),
    decision,
  };
}

// ---------- Typing /rmp <ticket> into the target's terminal ----------
// rmv (127.0.0.1:4310) types it only when its RMV_EXT_ORIGINS lists this extension's origin
// (opt-in on rmv's side). The extension sends the session id and the ticket only; rmv builds
// the text itself, checks that the terminal still runs that conversation (409 stale) and never
// switches the terminal tab.

export const RMV_BASE_URL =
  typeof __RMP_RMV_BASE_URL__ === "string" ? __RMP_RMV_BASE_URL__ : "http://127.0.0.1:4310";
/** The probe runs beside GET /sessions, which ⌘Enter waits for at most 800 ms. */
export const RMV_PROBE_TIMEOUT_MS = 600;

export type RmvDeliverReason =
  /** Typed into the terminal. */
  | "delivered"
  /** 409 stale: that terminal now runs another conversation. */
  | "stale"
  /** 409 "permission pending": the target Claude waits on a permission / question dialog, where
   *  the ticket's leading digit would pick an option. */
  | "permission_pending"
  /** 409 "draft": the target's input box holds half-typed text; /rmp + Enter would send both as one prompt. */
  | "draft"
  /** 409 "unverified": rmv could not tell which conversation the terminal runs now, or read its input box. */
  | "unverified"
  /** 409 otherwise: the terminal is closed or not live, or herdr's pane has no Claude. */
  | "not_live"
  /** 403: rmv does not list this extension in RMV_EXT_ORIGINS (or is older than v0.18.1). */
  | "not_enabled"
  /** 404: rmv does not know the session. */
  | "unknown_session"
  /** rmv is not running. */
  | "rmv_unreachable"
  /** No answer in time. rmv may still type it after the wait is cut (its /ext/deliver does not stop
   *  when the caller goes away), so this is "not known", not "not typed": no clipboard copy now. */
  | "rmv_timeout"
  /** Anything else (400, 502, a malformed reply). */
  | "rmv_error";

/** POST /ext/deliver {sid, ticket}. Never throws. */
export async function deliverViaRmv(
  sid: unknown,
  ticket: unknown,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; base?: string } = {},
): Promise<{ delivered: boolean; reason: RmvDeliverReason; via?: string }> {
  if (!isSessionId(sid) || !isTicket(ticket)) return { delivered: false, reason: "rmv_error" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${options.base ?? RMV_BASE_URL}/ext/deliver`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sid, ticket }),
        signal: controller.signal,
      },
    );
    if (response.status === 200) {
      const body: unknown = await response.json().catch(() => null);
      if (!isRecordLike(body) || body.ok !== true) return { delivered: false, reason: "rmv_error" };
      return {
        delivered: true,
        reason: "delivered",
        via: typeof body.via === "string" ? body.via.slice(0, 20) : undefined,
      };
    }
    if (response.status === 409) {
      const text = await response.text().catch(() => "");
      // rmv's own checks start the body with a word; /send's "別の会話が開かれている" (herdr pane)
      // is also stale.
      if (text.startsWith("permission")) return { delivered: false, reason: "permission_pending" };
      if (text.startsWith("draft")) return { delivered: false, reason: "draft" };
      if (text.startsWith("unverified")) return { delivered: false, reason: "unverified" };
      const stale = text.startsWith("stale") || text.includes("別の会話");
      return { delivered: false, reason: stale ? "stale" : "not_live" };
    }
    if (response.status === 403) return { delivered: false, reason: "not_enabled" };
    if (response.status === 404) return { delivered: false, reason: "unknown_session" };
    return { delivered: false, reason: "rmv_error" };
  } catch {
    return {
      delivered: false,
      reason: controller.signal.aborted ? "rmv_timeout" : "rmv_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** What a finished annotation send does to storage.local "lastTarget": set it after a stored
 *  targeted send, clear it after a stored send the user sent with "no target" picked in the list
 *  (so the next send asks instead of going to an older target), and leave it otherwise (a failed
 *  send, or an untargeted send only because the list could not be read). */
export function lastTargetAfterSend(
  result: Pick<InboxSendResult, "reason">,
  message: { to?: unknown; toCwd?: unknown; toLabel?: unknown; noTarget?: unknown },
): { set: LastTarget } | "clear" | null {
  if (result.reason !== "stored") return null;
  if (isSessionId(message.to)) {
    const set = parseLastTarget({ sid: message.to, cwd: message.toCwd, label: message.toLabel });
    return set ? { set } : null;
  }
  return message.noTarget === true ? "clear" : null;
}

/** Whether rmv takes /ext/deliver from this extension, without typing anything: an empty body
 *  is refused with 400 after the origin check (403 = not opted in, or an older rmv). POST, as
 *  the inbox confirmed a service-worker POST carries Origin (GET is unconfirmed). */
export async function probeRmvDeliver(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; base?: string } = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RMV_PROBE_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${options.base ?? RMV_BASE_URL}/ext/deliver`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      },
    );
    return response.status === 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
