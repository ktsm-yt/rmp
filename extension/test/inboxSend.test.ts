import { describe, expect, it, vi } from "vitest";
import {
  buildTargetList,
  decideSendTarget,
  deliverViaRmv,
  fetchInboxSessions,
  fetchTicketStatus,
  INBOX_BASE_URL,
  INBOX_DONE_URL,
  type InboxSession,
  type LastTarget,
  lastTargetAfterSend,
  parseLastTarget,
  parsePicked,
  postAnnotationsToInbox,
  probeRmvDeliver,
  RMV_BASE_URL,
  type SessionsReply,
} from "../src/inboxSend.js";

const SID = "2c9179b5-4040-45a8-a811-897f1c8a325a";
const marks = [{ displayNumber: 1, kind: "text", comment: "fix" }];

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("postAnnotationsToInbox", () => {
  it("returns the ticket and sends the target in X-RMP-To", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(200, { ticket: "20261023-071713-735053", where: `new/${SID}` }),
    );
    const result = await postAnnotationsToInbox(marks, { to: SID, fetchImpl });
    expect(result).toEqual({
      ok: true,
      ticket: "20261023-071713-735053",
      where: `new/${SID}`,
      delivered: false,
      reason: "stored",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INBOX_DONE_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "X-RMP-To": SID });
    expect(JSON.parse(String(init.body))).toEqual(marks);
  });

  it("sends no target header without a valid session id", async () => {
    for (const to of [undefined, "", "../etc", 42, `${SID}\nX: y`]) {
      const fetchImpl = vi.fn(async () => reply(200, { ticket: "20261023-071713-735053" }));
      await postAnnotationsToInbox(marks, { to, fetchImpl });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.headers).toEqual({});
    }
  });

  it("reports a stopped inbox as unreachable instead of dropping the send silently", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await postAnnotationsToInbox(marks, { fetchImpl })).toMatchObject({
      ok: false,
      ticket: null,
      delivered: false,
      reason: "inbox_unreachable",
    });
  });

  it("gives up on an inbox that does not answer in time, without calling it stopped", async () => {
    // The inbox writes the file before it answers: a slow answer may follow a stored send, so
    // "the inbox is not running" would push the user into a resend and a duplicate.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    expect(await postAnnotationsToInbox(marks, { fetchImpl, timeoutMs: 10 })).toMatchObject({
      ok: false,
      reason: "inbox_timeout",
    });
  });

  it("accepts an inbox from before tickets (204) as stored without a ticket", async () => {
    const fetchImpl = vi.fn(async () => reply(204));
    expect(await postAnnotationsToInbox(marks, { fetchImpl })).toMatchObject({
      ok: true,
      ticket: null,
      reason: "legacy_inbox",
    });
  });

  it("separates a refused origin from other errors", async () => {
    expect(
      await postAnnotationsToInbox(marks, { fetchImpl: vi.fn(async () => reply(403)) }),
    ).toMatchObject({ ok: false, reason: "inbox_rejected" });
    expect(
      await postAnnotationsToInbox(marks, { fetchImpl: vi.fn(async () => reply(500)) }),
    ).toMatchObject({ ok: false, reason: "inbox_error" });
    expect(
      await postAnnotationsToInbox(marks, {
        fetchImpl: vi.fn(async () => reply(200, { ticket: "../x" })),
      }),
    ).toMatchObject({ ok: false, reason: "inbox_error" });
  });

  it("does not post an empty send", async () => {
    const fetchImpl = vi.fn();
    expect(await postAnnotationsToInbox([], { fetchImpl })).toMatchObject({
      ok: true,
      reason: "empty",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const session = (sid: string, over: Partial<InboxSession> = {}): InboxSession => ({
  sid,
  cwd: `/Users/x/Dev/${sid.slice(0, 1)}`,
  name: "",
  updatedAt: 0,
  match: null,
  last: false,
  ...over,
});
const pidMatch = { kind: "pid", reason: "このポート (3000) を開いた Claude" };
const cwdMatch = (length: number) => ({ kind: "cwd", reason: "このページのフォルダ", length });
const listed = (sessions: InboxSession[], def: string | null = null): SessionsReply => ({
  available: true,
  sessions,
  default: def,
  defaultReason: null,
});
const lastOf = (sid: string): LastTarget => ({ sid, cwd: "/x", label: "x" });

describe("fetchInboxSessions", () => {
  it("asks the inbox with the tab URL and the previous target", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(200, {
        sessions: [
          { sid: A, cwd: "/a", name: "alpha", updatedAt: 5, match: pidMatch, last: false },
          { sid: "not-a-uuid", cwd: "/z" },
        ],
        default: A,
        defaultReason: pidMatch.reason,
      }),
    );
    const result = await fetchInboxSessions("http://localhost:3000/a?b=1", B, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${INBOX_BASE_URL}/sessions`);
    expect(parsed.searchParams.get("url")).toBe("http://localhost:3000/a?b=1");
    expect(parsed.searchParams.get("last")).toBe(B);
    expect(result).toEqual({
      available: true,
      sessions: [
        {
          sid: A,
          cwd: "/a",
          name: "alpha",
          updatedAt: 5,
          match: { kind: "pid", reason: pidMatch.reason, length: undefined },
          last: false,
          label: undefined,
          head: undefined,
          delivery: undefined,
          deliverable: false,
        },
      ],
      default: A,
      defaultReason: pidMatch.reason,
    });
  });

  it("keeps the inbox's delivery mark (the hook registry gives next, others manual)", async () => {
    const B2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fetchImpl = vi.fn(async () =>
      reply(200, {
        sessions: [
          {
            sid: SID,
            cwd: "/a",
            name: "",
            updatedAt: 2,
            match: null,
            last: false,
            delivery: "next",
          },
          {
            sid: B2,
            cwd: "/b",
            name: "",
            updatedAt: 1,
            match: null,
            last: false,
            delivery: "manual",
          },
        ],
        default: null,
        defaultReason: null,
      }),
    );
    const result = await fetchInboxSessions("file:///a/x.html", "", { fetchImpl });
    const list = buildTargetList(result, null, null);
    expect(list.options.map((o) => [o.sid, o.delivery])).toEqual([
      [SID, "next"],
      [B2, "manual"],
    ]);
  });

  it("gives up after 800 ms by default, so Send is never held up by the list", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      );
      const pending = fetchInboxSessions("file:///x", "", { fetchImpl });
      await vi.advanceTimersByTimeAsync(799);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ available: false });
      const [url] = fetchImpl.mock.calls[0] as unknown as [string];
      expect(new URL(url).searchParams.has("last")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a stopped, refusing or garbled inbox as no list", async () => {
    const cases = [
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      vi.fn(async () => reply(403)),
      vi.fn(async () => new Response("not json", { status: 200 })),
      vi.fn(async () => reply(200, { sessions: "nope" })),
    ];
    for (const fetchImpl of cases) {
      expect(await fetchInboxSessions("file:///x", "", { fetchImpl })).toEqual({
        available: false,
      });
    }
  });
});

describe("fetchTicketStatus", () => {
  it("posts the ticket and returns new / read / missing", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(200, { ticket: "20261023-071713-735053", status: "read" }),
    );
    expect(await fetchTicketStatus("20261023-071713-735053", { fetchImpl })).toBe("read");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${INBOX_BASE_URL}/status`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ticket: "20261023-071713-735053" });
  });

  it("returns null for a bad ticket or an inbox that does not answer", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { status: "new" }));
    expect(await fetchTicketStatus("../x", { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await fetchTicketStatus("20261023-071713-735053", {
        fetchImpl: vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      }),
    ).toBeNull();
    expect(
      await fetchTicketStatus("20261023-071713-735053", {
        fetchImpl: vi.fn(async () => reply(200, { status: "weird" })),
      }),
    ).toBeNull();
  });
});

describe("decideSendTarget (⌘Enter: send now or open the list)", () => {
  it("opens the list instead of sending when the guess and the previous target disagree", () => {
    // Exact guess (the port's Claude) is B, the previous target A is still alive.
    const decision = decideSendTarget(
      listed([session(B, { match: pidMatch }), session(A, { last: true })], B),
      lastOf(A),
      null,
    );
    expect(decision).toMatchObject({ action: "pick", why: "conflict", highlight: B });
    expect(decision.action === "pick" && decision.message).toContain(pidMatch.reason);
  });

  it("does not switch silently to a cwd guess either; the previous target stays highlighted", () => {
    // The inbox puts the previous target first as the default when there is no exact match.
    const decision = decideSendTarget(
      listed([session(B, { match: cwdMatch(20) }), session(A, { last: true })], A),
      lastOf(A),
      null,
    );
    expect(decision).toMatchObject({ action: "pick", why: "conflict", highlight: A });
  });

  it("sends at once when the guess agrees with the previous target, or there is no guess", () => {
    expect(
      decideSendTarget(listed([session(A, { match: pidMatch, last: true })], A), lastOf(A), null),
    ).toEqual({ action: "send", to: A, why: "same" });
    expect(
      decideSendTarget(listed([session(B), session(A, { last: true })], A), lastOf(A), null),
    ).toEqual({ action: "send", to: A, why: "last" });
  });

  it("opens the list on the first send, highlighting the guess", () => {
    expect(
      decideSendTarget(listed([session(A), session(B, { match: pidMatch })], B), null, null),
    ).toMatchObject({ action: "pick", why: "first", highlight: B });
    expect(decideSendTarget(listed([session(A)]), null, null)).toMatchObject({
      action: "pick",
      why: "first",
      highlight: null,
    });
  });

  it("opens the list when the previous target has ended", () => {
    expect(
      decideSendTarget(listed([session(B, { match: pidMatch })], B), lastOf(A), null),
    ).toMatchObject({ action: "pick", why: "last_dead", highlight: B });
    expect(decideSendTarget(listed([]), lastOf(A), null)).toMatchObject({
      action: "pick",
      why: "last_dead",
      highlight: null,
    });
  });

  it("opens the list without a preselection when guesses tie", () => {
    // Two Claude sessions behind one port, or two cwds of the same length (one repo, parallel).
    expect(
      decideSendTarget(
        listed([session(A, { match: pidMatch }), session(B, { match: pidMatch })]),
        lastOf(A),
        null,
      ),
    ).toMatchObject({ action: "pick", why: "tie", highlight: null });
    expect(
      decideSendTarget(
        listed([session(A, { match: cwdMatch(20) }), session(B, { match: cwdMatch(20) })]),
        null,
        null,
      ),
    ).toMatchObject({ action: "pick", why: "first", highlight: null });
    // The inbox names the previous target as its default here (no exact match): a tie still
    // preselects nothing, or two ⌘Enter in a row would send to it without a choice.
    expect(
      decideSendTarget(
        listed([session(A, { match: cwdMatch(20) }), session(B, { match: cwdMatch(20) })], A),
        lastOf(A),
        null,
      ),
    ).toMatchObject({ action: "pick", why: "tie", highlight: null });
  });

  it("prefers the longest cwd over shorter ones", () => {
    expect(
      decideSendTarget(
        listed([session(A, { match: cwdMatch(30) }), session(B, { match: cwdMatch(10) })], A),
        lastOf(A),
        null,
      ),
    ).toEqual({ action: "send", to: A, why: "same" });
  });

  it("follows what was picked in this page while it is alive", () => {
    const reply = listed([session(B, { match: pidMatch }), session(A)], B);
    expect(decideSendTarget(reply, lastOf(B), { sid: A })).toEqual({
      action: "send",
      to: A,
      why: "picked",
    });
    expect(decideSendTarget(reply, lastOf(B), { sid: null })).toEqual({
      action: "send",
      to: null,
      why: "picked",
    });
    expect(decideSendTarget(reply, lastOf(B), { sid: C })).toMatchObject({
      action: "pick",
      why: "picked_dead",
    });
  });

  it("sends without a target when the list cannot be read and nothing was picked here", () => {
    // The previous target was not chosen in this page and nothing confirms it is alive.
    expect(decideSendTarget({ available: false }, lastOf(A), null)).toEqual({
      action: "send",
      to: null,
      why: "unavailable",
    });
    expect(decideSendTarget({ available: false }, null, null)).toEqual({
      action: "send",
      to: null,
      why: "unavailable",
    });
  });

  it("keeps what was picked in this page when the list cannot be read", () => {
    // The user chose alpha from the chip, then /sessions went slow: alpha still gets X-RMP-To,
    // instead of an untargeted send that any session's bare /rmp could take.
    expect(decideSendTarget({ available: false }, lastOf(B), { sid: A })).toEqual({
      action: "send",
      to: A,
      why: "picked",
    });
    expect(decideSendTarget({ available: false }, lastOf(B), { sid: null })).toEqual({
      action: "send",
      to: null,
      why: "picked",
    });
    // Anything but a session id is not a pick.
    expect(decideSendTarget({ available: false }, null, { sid: "../x" })).toEqual({
      action: "send",
      to: null,
      why: "unavailable",
    });
  });
});

describe("buildTargetList", () => {
  it("orders guesses, then the previous target, then newest, and shows the evidence", () => {
    const list = buildTargetList(
      listed(
        [
          session(C, { updatedAt: 9, name: "newest" }),
          session(A, { updatedAt: 1, cwd: "/Users/x/Dev/rmv/" }),
          session(B, { updatedAt: 2, match: cwdMatch(12), name: "page-folder" }),
        ],
        A,
      ),
      lastOf(A),
      null,
    );
    expect(list.available).toBe(true);
    expect(list.options.map((o) => o.sid)).toEqual([B, A, C]);
    expect(list.options[0]).toMatchObject({
      label: "page-folder",
      reason: "このページのフォルダ",
      guess: true,
      last: false,
      delivery: "manual",
    });
    expect(list.options[1]).toMatchObject({
      label: A.slice(0, 8),
      folder: "rmv",
      reason: "前回の宛先",
      last: true,
    });
    expect(list.options[2]).toMatchObject({ label: "newest", reason: null });
    expect(list.decision).toMatchObject({ action: "pick", why: "conflict" });
  });

  it("returns no rows and a send-without-target decision when the list is unavailable", () => {
    expect(buildTargetList({ available: false }, lastOf(A), null)).toEqual({
      available: false,
      options: [],
      decision: { action: "send", to: null, why: "unavailable" },
    });
    expect(buildTargetList({ available: false }, lastOf(B), { sid: A })).toEqual({
      available: false,
      options: [],
      decision: { action: "send", to: A, why: "picked" },
    });
  });
});

describe("lastTarget after a send", () => {
  const stored = { reason: "stored" as const };
  it("remembers a stored targeted send", () => {
    expect(lastTargetAfterSend(stored, { to: A, toCwd: "/a", toLabel: "alpha" })).toEqual({
      set: { sid: A, cwd: "/a", label: "alpha" },
    });
  });

  it("forgets the previous target when no target was picked in the list", () => {
    expect(lastTargetAfterSend(stored, { noTarget: true })).toBe("clear");
  });

  it("keeps it for an untargeted send only because the list could not be read, or a failure", () => {
    expect(lastTargetAfterSend(stored, {})).toBeNull();
    expect(lastTargetAfterSend({ reason: "inbox_timeout" }, { noTarget: true })).toBeNull();
    expect(lastTargetAfterSend({ reason: "inbox_unreachable" }, { to: A })).toBeNull();
    expect(lastTargetAfterSend(stored, { to: "../x", noTarget: "yes" })).toBeNull();
  });
});

describe("stored and passed-in targets", () => {
  it("accepts only session ids", () => {
    expect(parseLastTarget({ sid: A, cwd: "/a", label: "alpha" })).toEqual({
      sid: A,
      cwd: "/a",
      label: "alpha",
    });
    expect(parseLastTarget({ sid: "x" })).toBeNull();
    expect(parseLastTarget(undefined)).toBeNull();
    expect(parsePicked({ sid: null })).toEqual({ sid: null });
    expect(parsePicked({ sid: A })).toEqual({ sid: A });
    expect(parsePicked({ sid: "../etc" })).toBeNull();
    expect(parsePicked(undefined)).toBeNull();
  });
});

describe("rmv /ext/deliver (今すぐ)", () => {
  const T = "20261023-071713-735053";

  it("sends only {sid, ticket} and reports the terminal it went to", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, via: "herdr" }));
    expect(await deliverViaRmv(SID, T, { fetchImpl })).toEqual({
      delivered: true,
      reason: "delivered",
      via: "herdr",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RMV_BASE_URL}/ext/deliver`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sid: SID, ticket: T });
  });

  it("never asks rmv with a malformed session id or ticket", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true }));
    for (const [sid, ticket] of [
      ["term_a", T],
      [SID, "/rmp 20261023-071713-735053"],
      [SID, `${T}\n`],
      [SID, 42],
    ]) {
      expect(await deliverViaRmv(sid, ticket, { fetchImpl })).toEqual({
        delivered: false,
        reason: "rmv_error",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps rmv's refusals so the overlay can say why it fell back to the clipboard", async () => {
    const cases: [Response | Error, string][] = [
      [new Response("stale: この端末では別の会話が開かれている", { status: 409 }), "stale"],
      [new Response("herdr pane wF:p1 では別の会話が開かれている", { status: 409 }), "stale"],
      [
        new Response(
          "stale: この端末では別の会話が開かれている (/clear・/resume の後、まだ依頼が無い)",
          { status: 409 },
        ),
        "stale",
      ],
      [
        new Response("permission pending: 宛先の Claude が許可を待っているので打ち込まない", {
          status: 409,
        }),
        "permission_pending",
      ],
      [
        new Response("unverified: Claude (pid 101) の記録が読めない。打ち込まない", {
          status: 409,
        }),
        "unverified",
      ],
      [
        new Response("draft: 宛先の端末の入力欄に書きかけがあるので打ち込まない", { status: 409 }),
        "draft",
      ],
      [new Response("session not live", { status: 409 }), "not_live"],
      [new Response("forbidden origin", { status: 403 }), "not_enabled"],
      [new Response("unknown session", { status: 404 }), "unknown_session"],
      [new Response("herdr exit 1", { status: 502 }), "rmv_error"],
      [new Response("bad ticket", { status: 400 }), "rmv_error"],
      [reply(200, { ok: false }), "rmv_error"],
      [new TypeError("Failed to fetch"), "rmv_unreachable"],
    ];
    for (const [answer, reason] of cases) {
      const fetchImpl = vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      expect(await deliverViaRmv(SID, T, { fetchImpl })).toEqual({ delivered: false, reason });
    }
  });

  it("says a cut wait is not known, not 'rmv is down': rmv may still type it", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    expect(await deliverViaRmv(SID, T, { fetchImpl, timeoutMs: 10 })).toEqual({
      delivered: false,
      reason: "rmv_timeout",
    });
  });

  it("probes the opt-in with an empty body: 400 is enabled, 403 / no rmv is not", async () => {
    const ask = async (answer: Response | Error) => {
      const fetchImpl = vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const enabled = await probeRmvDeliver({ fetchImpl });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${RMV_BASE_URL}/ext/deliver`);
      expect(init.method).toBe("POST");
      expect(init.body).toBe("{}");
      return enabled;
    };
    expect(await ask(new Response("bad ticket", { status: 400 }))).toBe(true);
    expect(await ask(new Response("forbidden origin", { status: 403 }))).toBe(false);
    expect(await ask(new Response("not found", { status: 404 }))).toBe(false);
    expect(await ask(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("marks a session 今すぐ only when rmv can reach it and has opted in", async () => {
    const B2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const C2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchImpl = vi.fn(async () =>
      reply(200, {
        sessions: [
          { sid: SID, cwd: "/a", updatedAt: 3, match: null, delivery: "next", deliverable: true },
          { sid: B2, cwd: "/b", updatedAt: 2, match: null, delivery: "next", deliverable: false },
          { sid: C2, cwd: "/c", updatedAt: 1, match: null, delivery: "manual", deliverable: "yes" },
        ],
        default: null,
        defaultReason: null,
      }),
    );
    const result = await fetchInboxSessions("file:///a/x.html", "", { fetchImpl });
    const marks = (on: boolean) =>
      buildTargetList(result, null, null, on).options.map((o) => o.delivery);
    expect(marks(true)).toEqual(["now", "next", "manual"]);
    expect(marks(false)).toEqual(["next", "next", "manual"]);
    expect(buildTargetList(result, null, null).options[0]?.delivery).toBe("next");
  });
});
