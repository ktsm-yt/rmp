#!/usr/bin/env python3
"""Red Marker Page の注釈を受け取るローカル受信箱。

  rmp-inbox.py serve                 # resident (launchd): store each send under ~/.rmp-inbox/new, notify
  rmp-inbox.py read                  # untargeted sends + sends whose target session is surely gone
  rmp-inbox.py read --session <sid>  # the same + sends for this Claude session
  rmp-inbox.py read --ticket <T>     # exactly one send
  rmp-inbox.py read --all            # everything unread (rescue)
  rmp-inbox.py read --draft <tabId>  # tab's unsent draft, without changing it
  rmp-inbox.py hook-session          # Claude Code SessionStart hook: register this session
  rmp-inbox.py hook-prompt           # Claude Code UserPromptSubmit hook: register + tell of unread sends

A send may name its target Claude session in the X-RMP-To header (session UUID, the same
value as CLAUDE_CODE_SESSION_ID). Targeted sends land in new/<sid>/, untargeted ones in new/.
Reading moves the file to read/ (flat), so a send is read once. When it cannot be told whether
a target session is alive (ps or ~/.claude/sessions broken), plain read leaves targeted sends alone.

HTTP (127.0.0.1 only, extension origin only):
  POST /done      body: annotation array -> 200 {ticket, where}
  POST /draft     body: {tabId, url, title, annotations} -> 200 {tabId}
  POST /status    body: {"ticket": T}    -> 200 {ticket, status: new|read|missing}
  GET  /sessions?url=<tab url>[&last=<sid>] -> live Claude sessions + a guess at the target

Hooks read the hook JSON on stdin (session_id, cwd) and keep a registry
~/.rmp-inbox/sessions/<sid>.json. GET /sessions lists a registered session with delivery "next"
(its next prompt mentions the send), any other with "manual" (the user pastes /rmp <ticket>).
When rmv (127.0.0.1:4310) is running, GET /sessions lays its own GET /sessions over that list:
label (herdr pane name), head (first 40 chars of the latest reply) and deliverable
(rmv can reach its terminal). rmv only adds to sessions already listed here, never adds a session,
and is given 0.6 s: when it is stopped or slow the list is the same as without it (deliverable false).
hook-prompt only mentions unread sends in new/<sid>/ ("あなた宛ての赤ペン N 件: /rmp <ticket>", plus a
note not to read them until the user types /rmp) and never marks them read. A hook exits 0 and prints nothing else once Python runs it. That alone does
not keep a prompt unblocked: `python3 <missing file>` exits 2, which blocks a UserPromptSubmit
prompt, so install.sh prints the wiring as `[ -f <this file> ] && /usr/bin/python3 <this file> ... || true`.

Only the Red Marker Page extension origins may talk to it: any web page can reach 127.0.0.1, and what
lands here is read into Claude's context, so a page must not be able to forge annotations.

Environment (tests): RMP_INBOX_PORT, RMP_INBOX_ROOT, RMP_CLAUDE_SESSIONS, RMP_INBOX_NO_NOTIFY=1,
RMP_RMV_URL (rmv's base URL, default http://127.0.0.1:4310), RMP_INBOX_ORIGINS (comma-separated
extension origins, overriding the two built-in extension IDs).
Keep this file runnable by the macOS system python3 (3.9).
"""
import base64
import binascii
import calendar
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

PORT = int(os.environ.get("RMP_INBOX_PORT") or 8766)
MAX_BODY = 30 * 1024 * 1024  # pen screenshots ride along as JPEG data URLs
DEFAULT_ORIGINS = (
    "chrome-extension://kgdkanfbaiakfcncpfdllehhenoplheg",
)
ALLOWED_ORIGINS = frozenset(
    origin.strip() for origin in os.environ.get("RMP_INBOX_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",") if origin.strip()
)
ROOT = Path(os.environ.get("RMP_INBOX_ROOT") or Path.home() / ".rmp-inbox")
NEW, READ, IMAGES, DRAFTS = ROOT / "new", ROOT / "read", ROOT / "images", ROOT / "drafts"
REGISTRY = ROOT / "sessions"  # <sid>.json written by the hooks
CLAUDE_SESSIONS = Path(os.environ.get("RMP_CLAUDE_SESSIONS") or Path.home() / ".claude" / "sessions")
RMV_PORT = 4310
RMV_URL = (os.environ.get("RMP_RMV_URL") or f"http://127.0.0.1:{RMV_PORT}").rstrip("/")
# The extension gives the whole GET /sessions 0.8 s. rmv's first answer after 5 s idle (its cache
# cold, no viewer open) measured 0.24 s; later ones 0.01 s. 0.6 s leaves room for a busy Mac.
RMV_TIMEOUT = 0.6

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TICKET_RE = re.compile(r"^\d{8}-\d{6}-\d{6}$")
SID_PATH_RE = re.compile(
    r"^/private/tmp/claude-\d+/[^/]+/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(/|$)"
)
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def notify(message):
    if os.environ.get("RMP_INBOX_NO_NOTIFY") == "1":
        return
    message = message.replace("\\", "\\\\").replace('"', '\\"')
    script = f'display notification "{message}" with title "Red Marker Page" sound name "Glass"'
    subprocess.run(["osascript", "-e", script], check=False)


# ---------- Claude sessions (~/.claude/sessions/<pid>.json) ----------


def _process_table():
    """pid -> (ppid, start time in the C locale and UTC, the format of procStart)."""
    try:
        out = subprocess.run(
            ["/bin/ps", "-axo", "pid=,ppid=,lstart="],
            capture_output=True,
            text=True,
            check=False,
            env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
        ).stdout
    except OSError:
        return {}
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), " ".join(parts[2].split()))
    return table


LSTART_RE = re.compile(r"^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$")


def _lstart(text):
    """procStart / ps lstart (C locale, UTC) as epoch seconds, or None for any other format."""
    if not LSTART_RE.match(text):
        return None
    try:
        return calendar.timegm(time.strptime(text, "%a %b %d %H:%M:%S %Y"))
    except (ValueError, OverflowError):
        return None


def _session_files():
    """[(path, data)] for every <pid>.json; data is None when the file does not parse.
    Raises OSError when the folder cannot be listed."""
    out = []
    for f in CLAUDE_SESSIONS.iterdir():
        if not re.fullmatch(r"\d+\.json", f.name):
            continue
        try:
            out.append((f, json.loads(f.read_text())))
        except (OSError, ValueError):
            out.append((f, None))
    return out


def _file_state(f, data, procs):
    """(sid, pid, state) for one session file. state:
      live    kind "interactive", the pid is alive and is the process that wrote the file
      dead    the pid is not running
      reused  procStart is in the known format (ps lstart) and the running pid started later
      unknown the pid is alive but the file cannot be read as above (kind renamed, procStart
              reformatted, sessionId missing; the format is not public)
    """
    data = data if isinstance(data, dict) else {}
    try:
        pid = int(data.get("pid") or f.stem)
    except (ValueError, TypeError):
        pid = int(f.stem)
    sid = str(data.get("sessionId") or "").lower()
    sid = sid if UUID_RE.match(sid) else ""
    if pid not in procs:
        return sid, pid, "dead"
    started = " ".join(str(data.get("procStart") or "").split())
    running = procs[pid][1]
    if started and started != running:
        was, now = _lstart(started), _lstart(running)
        # A reused pid always belongs to a process that started after the file was written.
        if was is not None and now is not None and now > was:
            return sid, pid, "reused"
        return sid, pid, "unknown"
    if data.get("kind") == "interactive" and sid:
        return sid, pid, "live"
    return sid, pid, "unknown"


def _live_from(files, procs):
    """{sid: session} for the interactive sessions among files whose process wrote the file."""
    sessions = {}
    for f, data in files:
        sid, pid, state = _file_state(f, data, procs)
        if state != "live":
            continue
        sessions[sid] = {
            "sid": sid,
            "pid": pid,
            "cwd": data.get("cwd") or "",
            "name": data.get("name") or "",
            "status": data.get("status") or "",
            "updatedAt": data.get("updatedAt") or data.get("startedAt") or 0,
        }
    return sessions


def live_sessions(procs=None):
    """Interactive Claude sessions whose process is still the one that wrote the file."""
    procs = _process_table() if procs is None else procs
    try:
        files = _session_files()
    except OSError:
        return {}
    return _live_from(files, procs)


def ended_targets(sids, me=""):
    """(ended, unsure): which of sids clearly ended, and which could not be checked.

    Fails closed. A send meant for another session must not be read here just because this
    check broke, so every sid is unsure unless all of these hold:
      - ps worked (the table lists this very process),
      - the sessions folder could be listed and every <pid>.json in it parsed,
      - at least one session passed the pid + procStart test. read runs inside a live Claude
        session, so a working check always finds one; finding none means ps or the file format
        changed (procStart reformatted, kind renamed), not that everyone exited,
      - the reader's own session (--session / CLAUDE_CODE_SESSION_ID), if known, is among them.
    Then, one sid at a time (another Claude version may be running next to this one and write
    its files differently, so one readable file says nothing about the others):
      - a sid that some file names counts as ended only when every such file points at a dead
        pid or at a pid reused by a later process. A live pid with an unknown kind or procStart
        format makes the sid unsure, never ended,
      - a sid that no file names counts as ended (Claude deletes <pid>.json on exit) unless some
        file with a live pid has no readable sessionId: that file may be the target's.
    The hooks' registry is laid over this with the same rule GET /sessions lists by
    (session_view), so a sid the list offers is never ended here: a listed sid is live, and a sid
    whose registered process is still running is unsure unless that process has clearly moved on
    to another sid (its (b) file and its latest hook both name the other one).
    """
    sids = set(sids)
    procs = _process_table()
    if os.getpid() not in procs:
        return set(), sids
    try:
        files = _session_files()
    except OSError:
        return set(), sids
    if any(data is None for _, data in files):
        return set(), sids  # unreadable or half-written: it may be the target's file
    states = [_file_state(f, data, procs) for f, data in files]
    listed, held = session_view(procs, files)
    live = {sid for sid, _, state in states if state == "live"} | set(listed)
    me = me or str(os.environ.get("CLAUDE_CODE_SESSION_ID") or "").strip().lower()
    if not live or (UUID_RE.match(me) and me not in live):
        return set(), sids
    opaque = any(not sid and state not in ("dead", "reused") for sid, _, state in states)
    ended, unsure = set(), set()
    for target in sids:
        named = [state for sid, _, state in states if sid == target]
        if target in listed or "live" in named:
            continue  # alive: GET /sessions offers it, or its (b) file vouches for it
        if target in held:
            unsure.add(target)
        elif named:
            if all(state in ("dead", "reused") for state in named):
                ended.add(target)
            else:
                unsure.add(target)
        elif opaque:
            unsure.add(target)
        else:
            ended.add(target)
    return ended, unsure


# ---------- The hooks' registry (~/.rmp-inbox/sessions/<sid>.json) ----------


def registry_entries():
    """[entry] for every well-formed registry file; anything unreadable is skipped."""
    out = []
    try:
        files = list(REGISTRY.glob("*.json"))
    except OSError:
        return out
    for f in files:
        try:
            data = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or data.get("sid") != f.stem or not UUID_RE.match(f.stem):
            continue
        pid = data.get("pid")
        out.append(
            {
                "sid": f.stem,
                "cwd": data.get("cwd") if isinstance(data.get("cwd"), str) else "",
                "pid": pid if isinstance(pid, int) and pid > 1 else None,
                "procStart": str(data.get("procStart") or ""),
                "updatedAt": data.get("updatedAt") if isinstance(data.get("updatedAt"), int) else 0,
            }
        )
    return out


def _entry_alive(entry, procs):
    """The registered pid is still the process that ran the hook (the hook wrote ps's own lstart)."""
    pid = entry["pid"]
    return pid is not None and pid in procs and bool(entry["procStart"]) and procs[pid][1] == entry["procStart"]


def session_view(procs, files=None):
    """(listed, held): the one liveness rule shared by GET /sessions and read's ended check.

    listed: live sessions, ~/.claude/sessions (b) with the registry (a) laid over it,
    - a sid the registry knows gets delivery "next" (the hooks are wired for it) unless the entry's
      process has ended, others "manual",
    - a registered pid that is alive (pid + the ps start time the hook wrote) is listed even when
      its (b) file cannot vouch for it (procStart reformatted, sessionId missing), but only while
      that file exists and says kind "interactive": hooks also run in `claude -p` and other
      headless processes, which must not show up as targets,
    - when one Claude process shows up under two sids, the sid its hook reported last wins: the
      hooks run on every SessionStart (/clear, /resume) and prompt, so they follow the conversation.
    Each item carries "cwds" (the (b) cwd and the hook's cwd) for the cwd guess.

    held: sids not listed whose registered process is still running, except a sid whose process
    has clearly moved on (the sid listed for that pid is both its latest hook's and its (b) file's).
    read must not count these as ended: a send to them may still be wanted there.
    """
    if files is None:
        try:
            files = _session_files()
        except OSError:
            files = []
    from_files = _live_from(files, procs)
    sessions = {sid: {**s, "cwds": [s["cwd"]] if s["cwd"] else [], "delivery": "manual"}
                for sid, s in from_files.items()}
    entries = registry_entries()
    by_sid = {}
    for e in entries:
        if e["updatedAt"] >= by_sid.get(e["sid"], {"updatedAt": -1})["updatedAt"]:
            by_sid[e["sid"]] = e
    alive = [e for e in by_sid.values() if _entry_alive(e, procs)]
    latest_by_pid = {}
    for e in alive:
        if e["updatedAt"] >= latest_by_pid.get(e["pid"], {"updatedAt": -1})["updatedAt"]:
            latest_by_pid[e["pid"]] = e
    interactive = {int(f.stem) for f, data in files if isinstance(data, dict) and data.get("kind") == "interactive"}
    sid_by_pid = {s["pid"]: sid for sid, s in sessions.items()}
    for pid, e in latest_by_pid.items():
        old = sid_by_pid.get(pid)
        if old == e["sid"] or e["sid"] in sessions or (not old and pid not in interactive):
            continue
        base = sessions.pop(old) if old else {"pid": pid, "name": "", "status": "", "updatedAt": 0, "cwd": "", "cwds": []}
        sessions[e["sid"]] = {**base, "sid": e["sid"], "cwd": base["cwd"] or e["cwd"]}
    for sid, s in sessions.items():
        e = by_sid.get(sid)
        if not e:
            continue
        # An entry whose registered process has ended was left by an earlier process (the session was
        # resumed in a new one): wired hooks would have rewritten it at that SessionStart, so nothing
        # says the next prompt will bring the notice. A pid not known yet (SessionStart ran before
        # the (b) file was written) still counts: the hooks did run for this session.
        if e["pid"] is None or _entry_alive(e, procs):
            s["delivery"] = "next"
        if e["cwd"] and e["cwd"] not in s["cwds"]:
            s["cwds"].append(e["cwd"])
        s["updatedAt"] = max(s["updatedAt"] or 0, e["updatedAt"])
    held = set()
    for e in alive:
        if e["sid"] in sessions:
            continue
        winner = latest_by_pid[e["pid"]]["sid"]
        moved_on = winner in sessions and from_files.get(winner, {}).get("pid") == e["pid"]
        if not moved_on:
            held.add(e["sid"])
    return sessions, held


def listed_sessions(procs):
    """Live sessions for GET /sessions (see session_view)."""
    return session_view(procs)[0]


def session_label(sid):
    info = live_sessions().get(sid)
    if info and info["name"]:
        return info["name"]
    return sid[:8]


# ---------- Guessing the target from the tab URL ----------

_LISTEN_MEMO = {}  # port -> (time, [pid, ...])
_MEMO_LOCK = threading.Lock()


def listener_pids(port):
    now = time.monotonic()
    with _MEMO_LOCK:
        hit = _LISTEN_MEMO.get(port)
        if hit and now - hit[0] < 10:
            return hit[1]
    try:
        out = subprocess.run(
            ["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
    except OSError:
        out = ""
    pids = sorted({int(p) for p in out.split() if p.isdigit()})  # IPv4 and IPv6 give the same pid
    with _MEMO_LOCK:
        _LISTEN_MEMO[port] = (now, pids)
    return pids


def process_cwd(pid):
    try:
        out = subprocess.run(
            ["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
    except OSError:
        return ""
    for line in out.splitlines():
        if line.startswith("n"):
            return line[1:]
    return ""


def realpath(p):
    try:
        return os.path.realpath(p)
    except (OSError, ValueError):
        return p


def url_target(url):
    """('file', path) / ('port', n) / ('external', None) / (None, None) for a tab URL."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None, None
    if parts.scheme == "file":
        return "file", unquote(parts.path)
    if parts.scheme not in ("http", "https"):
        return None, None
    host = (parts.hostname or "").lower()
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return None, None
    if host in LOCAL_HOSTS:
        if port == RMV_PORT and parts.path == "/file":
            p = (parse_qs(parts.query).get("p") or [""])[0]
            return ("file", p) if p.startswith("/") else (None, None)
        return "port", port
    return "external", None


def cwd_matches(path, sessions, reason):
    """Sessions whose cwd contains path, as (cwd length, sid, reason); '/' is never a match."""
    path = realpath(path)
    found = []
    for s in sessions.values():
        best = 0
        for raw in s.get("cwds") or [s["cwd"]]:
            cwd = realpath(raw) if raw else ""
            if not cwd or cwd == "/":
                continue
            if path == cwd or path.startswith(cwd.rstrip("/") + "/"):
                best = max(best, len(cwd))
        if best:
            found.append((best, s["sid"], reason))
    return found


def guess(url, sessions, procs):
    """Exact matches ([(sid, kind, reason)]) and cwd prefix matches ([(len, sid, reason)])."""
    exact, prefix = [], []
    kind, value = url_target(url)
    if kind == "file":
        m = SID_PATH_RE.match(realpath(value))
        if m and m.group(1) in sessions:
            exact.append((m.group(1), "sid-path", "このページは Claude セッションの作業フォルダにある"))
        prefix += cwd_matches(value, sessions, "このページのフォルダ")
    elif kind == "port":
        by_pid = {s["pid"]: s["sid"] for s in sessions.values()}
        for pid in listener_pids(value):
            cur, hit = pid, None
            for _ in range(10):
                if cur in by_pid:
                    hit = by_pid[cur]
                    break
                nxt = procs.get(cur, (0, ""))[0]
                if nxt <= 1:
                    break
                cur = nxt
            if hit:
                exact.append((hit, "pid", f"このポート ({value}) を開いた Claude"))
                continue
            cwd = process_cwd(pid)
            if cwd and cwd != "/":
                prefix += cwd_matches(cwd, sessions, f"このポート ({value}) を開いたプロセスのフォルダ")
    # External URLs carry nothing to match on; the list stays newest first.
    seen, uniq = set(), []
    for item in exact:
        if item[0] not in seen:
            seen.add(item[0])
            uniq.append(item)
    return uniq, prefix


# ---------- rmv's session list (rmv v0.18.0+) ----------

_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def rmv_sessions():
    """{sid: {label, head, deliverable}} from rmv's GET /sessions; {} when rmv is stopped, slow,
    too old to have the route, or answers anything unexpected. deliverable needs rmv's own
    x-rmv-live: ok (rmv v0.18 以前は x-rmx-live): with "unknown" rmv could not check its terminals and live is a guess."""
    try:
        with _NO_PROXY.open(f"{RMV_URL}/sessions", timeout=RMV_TIMEOUT) as r:
            checked = (r.headers.get("x-rmv-live") or r.headers.get("x-rmx-live")) == "ok"  # x-rmx-live は rmv v0.18 以前
            data = json.loads(r.read(2_000_000))
    except Exception:  # noqa: BLE001 - any failure means "no overlay"
        return {}
    out = {}
    for e in data if isinstance(data, list) else []:
        sid = e.get("sid") if isinstance(e, dict) else None
        if not isinstance(sid, str) or not UUID_RE.match(sid.lower()) or sid.lower() in out:
            continue
        label, head = e.get("label"), e.get("head")
        out[sid.lower()] = {
            "label": label[:200] if isinstance(label, str) else "",
            "head": head[:200] if isinstance(head, str) else "",
            "deliverable": checked and e.get("live") is True and e.get("deliverable") is True,
        }
    return out


def rmv_sessions_within(seconds):
    """Start rmv_sessions() beside the caller's own work. The returned function waits for it until
    `seconds` after the start and gives {} if it is not back by then."""
    box = []
    deadline = time.monotonic() + seconds
    t = threading.Thread(target=lambda: box.append(rmv_sessions()), daemon=True)
    t.start()

    def result():
        t.join(max(0.0, deadline - time.monotonic()))
        return box[0] if box else {}

    return result


def sessions_for(url, last=""):
    rmv = rmv_sessions_within(RMV_TIMEOUT)
    procs = _process_table()
    sessions = listed_sessions(procs)
    exact, prefix = guess(url, sessions, procs) if url else ([], [])
    match = {}
    for sid, kind, reason in exact:
        match.setdefault(sid, {"kind": kind, "reason": reason})
    best_prefix = {}
    for length, sid, reason in prefix:
        if sid not in match and length > best_prefix.get(sid, (0, ""))[0]:
            best_prefix[sid] = (length, reason)
    for sid, (length, reason) in best_prefix.items():
        match[sid] = {"kind": "cwd", "reason": reason, "length": length}
    # Default target: 1. a single exact match, 2. the previous target if alive,
    # 3. a single longest cwd match. Ties give no default (parallel work in one repo is the
    # case where a wrong guess hurts most).
    default, default_reason = None, None
    if len(exact) == 1:
        default, default_reason = exact[0][0], match[exact[0][0]]["reason"]
    elif not exact and last in sessions:
        default, default_reason = last, "前回の宛先"
    elif not exact and best_prefix:
        top = max(length for length, _ in best_prefix.values())
        tops = [sid for sid, (length, _) in best_prefix.items() if length == top]
        if len(tops) == 1:
            default, default_reason = tops[0], match[tops[0]]["reason"]

    def order(s):
        sid = s["sid"]
        rank = 0 if sid in match and match[sid]["kind"] != "cwd" else 1 if sid in match else 2
        if rank == 2 and sid == last:
            rank = 1.5
        return (rank, -match.get(sid, {}).get("length", 0), -(s["updatedAt"] or 0))

    over = rmv()
    items = []
    for s in sorted(sessions.values(), key=order):
        item = {k: v for k, v in s.items() if k != "cwds"}
        extra = over.get(s["sid"], {})
        # rmv adds to a listed session only; an empty label / head leaves the name to the extension.
        for key in ("label", "head"):
            if extra.get(key):
                item[key] = extra[key]
        item["deliverable"] = bool(extra.get("deliverable"))
        items.append({**item, "match": match.get(s["sid"]), "last": s["sid"] == last})
    return {"sessions": items, "default": default, "defaultReason": default_reason}


# ---------- Store / status ----------


_TICKET_LOCK = threading.Lock()  # POST /done runs on several threads (ThreadingHTTPServer)


def ticket_stem(ns):
    """YYYYMMDD-HHMMSS-NNNNNN from one clock reading (ns since the epoch, local time)."""
    return f"{time.strftime('%Y%m%d-%H%M%S', time.localtime(ns // 10**9))}-{ns // 1000 % 10**6:06d}"


def new_ticket():
    """A stem no stored send uses. Call it under _TICKET_LOCK and store the file before releasing it,
    or two threads can pick the same stem and the second rename replaces the first send."""
    while True:
        stem = ticket_stem(time.time_ns())
        if find_ticket(stem) == (None, None):
            return stem


def find_ticket(ticket):
    """('new', path) / ('read', path) / (None, None)."""
    if not TICKET_RE.match(ticket or ""):
        return None, None
    name = f"{ticket}.json"
    for path in [NEW / name, *NEW.glob(f"*/{name}")]:
        if path.is_file():
            return "new", path
    if (READ / name).is_file():
        return "read", READ / name
    return None, None


def store(annotations, sid):
    folder = NEW / sid if sid else NEW
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / f".send-{os.getpid()}-{threading.get_ident()}.json"
    tmp.write_text(json.dumps(annotations, ensure_ascii=False))
    # The name is picked and taken in one step: only complete files ever carry a ticket name.
    with _TICKET_LOCK:
        ticket = new_ticket()
        tmp.rename(folder / f"{ticket}.json")
    return ticket, f"new/{sid}" if sid else "new"


def valid_annotations(annotations):
    if not isinstance(annotations, list) or len(annotations) > 200:
        return False
    for annotation in annotations:
        if not isinstance(annotation, dict) or not isinstance(annotation.get("kind"), str):
            return False
        if not isinstance(annotation.get("displayNumber"), int) or isinstance(annotation["displayNumber"], bool):
            return False
        for key in ("comment", "text", "url", "title"):
            if key in annotation and not isinstance(annotation[key], str):
                return False
        element = annotation.get("element")
        if "element" in annotation:
            if not isinstance(element, dict) or any(key in element and not isinstance(element[key], str) for key in ("selector", "text")):
                return False
        image = annotation.get("image")
        if "image" in annotation:
            if not isinstance(image, str) or not image.startswith("data:image/jpeg;base64,"):
                return False
            try:
                base64.b64decode(image.split(",", 1)[1], validate=True)
            except (ValueError, binascii.Error):
                return False
        rect = annotation.get("imageRect")
        if "imageRect" in annotation and (not isinstance(rect, dict) or any(not isinstance(rect.get(key), (int, float)) or isinstance(rect.get(key), bool) for key in ("x", "y", "width", "height"))):
            return False
    return True


def draft_path(tab_id):
    return DRAFTS / f"{tab_id}.json"


class Handler(BaseHTTPRequestHandler):
    def _allowed(self):
        return self.headers.get("Origin") in ALLOWED_ORIGINS

    def _reply(self, code, payload=None):
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _body(self, limit):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if not 0 < n <= limit:
            return None
        return self.rfile.read(n)

    def _allowed_read(self):
        """GET /sessions: Chrome sends no Origin on a service worker's GET (measured 2026-10-23,
        Sec-Fetch-Site: none), so a GET without Origin is let through when it cannot come from a
        web page: Sec-Fetch-Site is absent (not a browser) or "none" (not page-initiated), and Host
        is this loopback port (blocks DNS rebinding). The reply has no CORS header either way."""
        origin = self.headers.get("Origin")
        if origin is not None:
            return origin in ALLOWED_ORIGINS
        site = self.headers.get("Sec-Fetch-Site")
        host = (self.headers.get("Host") or "").lower()
        return site in (None, "none") and host in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path != "/sessions" or not self._allowed_read():
            self._reply(403)
            return
        q = parse_qs(parts.query)
        url = (q.get("url") or [""])[0]
        last = (q.get("last") or [""])[0].lower()
        self._reply(200, sessions_for(url, last if UUID_RE.match(last) else ""))

    def do_POST(self):
        if self.path not in ("/done", "/draft", "/status") or not self._allowed():
            self._reply(403)
            return
        raw = self._body(MAX_BODY if self.path in ("/done", "/draft") else 4096)
        if raw is None:
            self._reply(400)
            return
        try:
            payload = json.loads(raw)
        except ValueError:
            self._reply(400)
            return
        if self.path == "/status":
            ticket = payload.get("ticket") if isinstance(payload, dict) else None
            if not isinstance(ticket, str) or not TICKET_RE.match(ticket):
                self._reply(400)
                return
            status, _ = find_ticket(ticket)
            self._reply(200, {"ticket": ticket, "status": status or "missing"})
            return
        if self.path == "/draft":
            if not isinstance(payload, dict):
                self._reply(400)
                return
            tab_id = payload.get("tabId")
            annotations = payload.get("annotations")
            if (not isinstance(tab_id, int) or isinstance(tab_id, bool) or tab_id <= 0
                    or any(key in payload and not isinstance(payload[key], str) for key in ("url", "title"))
                    or not valid_annotations(annotations)):
                self._reply(400)
                return
            path = draft_path(tab_id)
            if annotations:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.parent / f".{tab_id}-{os.getpid()}-{threading.get_ident()}.json"
                tmp.write_text(json.dumps({"url": payload.get("url", ""), "title": payload.get("title", ""), "annotations": annotations}, ensure_ascii=False))
                tmp.replace(path)
            else:
                path.unlink(missing_ok=True)
            self._reply(200, {"tabId": tab_id})
            return
        if not valid_annotations(payload):
            self._reply(400)
            return
        header = self.headers.get("X-RMP-To")
        to = (header or "").strip().lower()
        if header is not None and not UUID_RE.match(to):
            self._reply(400)
            return
        sid = to
        if not payload:
            self._reply(200, {"ticket": None, "where": None})
            return
        ticket, where = store(payload, sid)
        self._reply(200, {"ticket": ticket, "where": where})
        count = len(payload)

        def tell():
            target = f" → {session_label(sid)}" if sid else ""
            notify(f"注釈 {count} 件を受信{target}。/rmp {ticket}")

        threading.Thread(target=tell, daemon=True).start()

    def log_message(self, *args):
        pass


# ---------- read ----------


CONTROL_RE = re.compile(r"[\x00-\x1f\x7f\u2028\u2029]+")


def flat(value):
    """Page-derived text on one line, so it cannot forge '=== ' headers or 'コメント:' lines in read output."""
    return CONTROL_RE.sub(" ", str(value))


def describe(a, stem):
    element = a.get("element") or {}
    target = a.get("text") or element.get("text", "")[:80]
    selector = element.get("selector", "")
    # The comment is the user's own words: keep its line breaks, indented under the header.
    comment = str(a.get("comment", "")).replace("\r\n", "\n").replace("\n", "\n      ")
    line = f"[{flat(a.get('displayNumber'))}] {flat(a.get('kind'))} {flat(selector)} 「{flat(target)}」\n    コメント: {comment}"
    image = a.get("image", "")
    if image.startswith("data:image/jpeg;base64,"):
        path = IMAGES / f"{stem}-{a.get('displayNumber')}.jpg"
        path.write_bytes(base64.b64decode(image.split(",", 1)[1]))
        r = a.get("imageRect") or {}
        line += f"\n    画像: {path} (印を付けた時の画面。ペンなら描いた線も写る。印の範囲は画像の x={r.get('x')} y={r.get('y')} {r.get('width')}x{r.get('height')} px)"
    return line


def print_send(f, note=""):
    anns = json.loads(f.read_text())
    first = anns[0] if anns else {}
    print(f"=== {f.stem} ({len(anns)} 件){note} {flat(first.get('title', ''))}\n{flat(first.get('url', ''))}")
    for a in anns:
        print(describe(a, f.stem))


def consume(files, notes=None, notify_race=False):
    for f in sorted(files, key=lambda p: p.name):
        target = READ / f.name
        try:
            f.rename(target)
        except FileNotFoundError:
            if notify_race:
                print(f"=== {f.stem} (別の読み手が先に読みました)")
            continue
        except OSError:
            continue
        try:
            print_send(target, (notes or {}).get(f, ""))
        except Exception:
            print(f"=== {f.stem} (読めませんでした: {target})")


def sends_in(folder):
    """Stored sends only: a send is written to a dot-file first and renamed when complete."""
    return sorted(f for f in folder.glob("*.json") if TICKET_RE.match(f.stem))


def targeted():
    """{sid: [file, ...]} for every new/<sid>/ folder that has unread sends."""
    out = {}
    for d in NEW.iterdir():
        if d.is_dir() and UUID_RE.match(d.name):
            files = sends_in(d)
            if files:
                out[d.name] = files
    return out


def read(args):
    valid_args = not args or args == ["--all"] or (len(args) == 2 and args[0] in ("--ticket", "--session", "--draft") and not args[1].startswith("--"))
    # ponytail: malformed arguments must not fall through to a real read that marks notes as read
    if not valid_args:
        print(__doc__.strip())
        return
    untargeted = sends_in(NEW)
    by_sid = targeted()
    if args and args[0] == "--draft":
        tab_id = args[1] if len(args) == 2 else ""
        if not tab_id.isdigit() or int(tab_id) <= 0:
            print(f"タブ {tab_id or '（未指定）'} の下書きはありません")
            return
        try:
            draft = json.loads(draft_path(tab_id).read_text())
        except (OSError, ValueError):
            print(f"タブ {tab_id} の下書きはありません。もう一度試してください")
            return
        if not isinstance(draft, dict) or not isinstance(draft.get("annotations"), list):
            print(f"タブ {tab_id} の下書きはありません。もう一度試してください")
            return
        annotations = draft.get("annotations", [])
        print(f"=== 下書き タブ {tab_id} ({len(annotations)} 件) {draft.get('title', '')}\n{draft.get('url', '')}")
        for annotation in annotations:
            print(describe(annotation, f"draft-{tab_id}"))
        return
    if args and args[0] == "--ticket":
        ticket = args[1] if len(args) > 1 else ""
        status, path = find_ticket(ticket)
        if status == "new":
            consume([path], notify_race=True)
        elif status == "read":
            print_send(path, " (既読)")
        else:
            print(f"ticket {ticket} の注釈はありません (形式は YYYYMMDD-HHMMSS-NNNNNN)")
        return
    if args and args[0] == "--all":
        files = untargeted + [f for fs in by_sid.values() for f in fs]
        if not files:
            print("未読の注釈はありません")
            return
        notes = {f: f" (宛先 {sid[:8]})" for sid, fs in by_sid.items() for f in fs}
        consume(files, notes)
        return
    me = ""
    if args and args[0] == "--session":
        me = (args[1] if len(args) > 1 else "").strip().lower()
        if not UUID_RE.match(me):
            print("(セッション ID が取れなかったので、宛先なしの分と、宛先のセッションが終了済みの分だけを読みます)")
            me = ""
    files = list(untargeted)
    if me:
        files += by_sid.pop(me, [])
    # Without --session, sends for the session named by the environment are this reader's own:
    # they are not read here, but they must not be counted as another session's.
    env_me = str(os.environ.get("CLAUDE_CODE_SESSION_ID") or "").strip().lower()
    mine = len(by_sid.pop(env_me, [])) if not me and UUID_RE.match(env_me) else 0
    ended, unsure = ended_targets(set(by_sid), me) if by_sid else (set(), set())
    notes = {}
    for sid in sorted(ended):
        for f in by_sid.pop(sid):
            files.append(f)
            notes[f] = f" (宛先 {sid[:8]} は終了済み)"
    unknown = sum(len(fs) for sid, fs in by_sid.items() if sid in unsure)
    others = sum(len(fs) for sid, fs in by_sid.items() if sid not in unsure)
    if files:
        consume(files, notes)
    else:
        print("未読の注釈はありません")
    if unknown:
        print(f"(宛先のセッションが生きているか確かめられなかったので、宛先付き {unknown} 件は読んでいません。全部読むなら read --all)")
    if mine:
        print(f"(このセッション宛て {mine} 件は読んでいません。read --session \"$CLAUDE_CODE_SESSION_ID\" で読みます)")
    if others:
        print(f"(他のセッション宛て {others} 件は読んでいません。全部読むなら read --all)")


# ---------- Claude Code hooks (hook-session / hook-prompt) ----------


def _hook_input():
    """(sid, cwd, payload) from the hook JSON on stdin; sid is "" when it is not a session UUID."""
    if sys.stdin is None or sys.stdin.isatty():
        return "", "", {}
    payload = json.loads(sys.stdin.read() or "{}")
    if not isinstance(payload, dict):
        return "", "", {}
    sid = str(payload.get("session_id") or "").strip().lower()
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else ""
    return (sid if UUID_RE.match(sid) else ""), (cwd if cwd.startswith("/") else ""), payload


def _claude_ancestor():
    """(pid, procStart) of the interactive Claude process running this hook, or (None, "").

    Walks up from the nearest ancestor and stops at the first Claude: a process that has a
    ~/.claude/sessions/<pid>.json, is named claude, or is $CLAUDE_PID. Nothing further up counts,
    so a headless `claude -p` started inside an interactive session (Bash tool, workflows) can
    never borrow the interactive parent's pid, even when it inherited the parent's CLAUDE_PID.
    That nearest Claude is taken only when its <pid>.json says kind "interactive"; otherwise
    (headless, or the file is not written yet at SessionStart) the pid stays unknown and the
    next prompt's hook looks again.
    """
    try:
        out = subprocess.run(
            ["/bin/ps", "-axo", "pid=,ppid=,lstart=,comm="],
            capture_output=True,
            text=True,
            check=False,
            env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
        ).stdout
    except OSError:
        return None, ""
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 7)  # pid ppid + lstart (5 words) + comm
        if len(parts) == 8 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), " ".join(parts[2:7]), parts[7])
    env_pid = str(os.environ.get("CLAUDE_PID") or "")
    env_pid = int(env_pid) if env_pid.isdigit() else None
    cur = os.getppid()
    for _ in range(10):
        if cur <= 1 or cur not in table:
            break
        f = CLAUDE_SESSIONS / f"{cur}.json"
        if f.is_file() or os.path.basename(table[cur][2]) == "claude" or cur == env_pid:
            try:
                data = json.loads(f.read_text())
            except (OSError, ValueError):
                return None, ""
            if isinstance(data, dict) and data.get("kind") == "interactive":
                return cur, table[cur][1]
            return None, ""
        cur = table[cur][0]
    return None, ""


def register(sid, cwd, event):
    """Write registry/<sid>.json. The pid is looked up on SessionStart and whenever none is kept yet
    (the nearest Claude was not interactive, or its <pid>.json was not written yet); otherwise kept."""
    REGISTRY.mkdir(parents=True, exist_ok=True)
    path = REGISTRY / f"{sid}.json"
    try:
        old = json.loads(path.read_text())
    except (OSError, ValueError):
        old = {}
    old = old if isinstance(old, dict) else {}
    pid, started = old.get("pid"), old.get("procStart") or ""
    if event == "SessionStart" or not isinstance(pid, int):
        pid, started = _claude_ancestor()  # /resume in another process moves the sid
    data = {
        "sid": sid,
        "cwd": cwd or old.get("cwd") or "",
        "pid": pid,
        "procStart": started,
        "event": event,
        "updatedAt": int(time.time() * 1000),
    }
    tmp = REGISTRY / f".{sid}-{os.getpid()}.json"
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.rename(path)


def prune_registry():
    """Drop entries whose process has ended, or that never got a pid and are a day old: every
    `claude -p` (workflows, delegation) leaves one of those, and every GET /sessions reads them all."""
    procs = _process_table()
    if os.getpid() not in procs:
        return  # ps is not working: keep everything
    day_ago = int(time.time() * 1000) - 24 * 3600 * 1000
    for e in registry_entries():
        dead = (e["pid"] is not None and not _entry_alive(e, procs)) or (e["pid"] is None and e["updatedAt"] < day_ago)
        if dead:
            try:
                (REGISTRY / f"{e['sid']}.json").unlink()
            except OSError:
                pass


def unread_notice(sid):
    """「あなた宛ての赤ペン N 件: /rmp <ticket> … (…)」, or "" when new/<sid>/ holds nothing.

    The note in brackets is the one rule Claude needs before it decides anything: the /rmp skill's
    own text is only read once the skill runs, and running it reads the sends and marks them read."""
    folder = NEW / sid
    files = sends_in(folder) if folder.is_dir() else []
    if not files:
        return ""
    tickets = " ".join(f"/rmp {f.stem}" for f in files[:5])
    more = f" ほか {len(files) - 5} 件" if len(files) > 5 else ""
    return (
        f"あなた宛ての赤ペン {len(files)} 件: {tickets}{more}"
        " (user が /rmp と打つまで読まない。今の依頼に関係なければ、返事の最後に 1 行で伝えるだけ)"
    )


def hook(mode):
    """Never block the prompt: every failure is swallowed and the exit status is 0."""
    try:
        sid, cwd, payload = _hook_input()
        if not sid:
            return
        event = str(payload.get("hook_event_name") or ("SessionStart" if mode == "hook-session" else "UserPromptSubmit"))
        try:
            register(sid, cwd, event)
        except Exception:
            pass
        if mode == "hook-session":
            if event == "SessionStart":
                prune_registry()
            return
        prompt = str(payload.get("prompt") or "").lstrip()
        if prompt.startswith("/rmp"):
            return  # the user is reading it right now
        notice = unread_notice(sid)
        if notice:
            # ASCII-escaped JSON: the hook's stdout encoding is not guaranteed to be UTF-8.
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": notice}}))
    except Exception:
        pass


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode in ("hook-session", "hook-prompt"):
        hook(mode)
        return
    NEW.mkdir(parents=True, exist_ok=True)
    READ.mkdir(parents=True, exist_ok=True)
    IMAGES.mkdir(parents=True, exist_ok=True)
    if mode == "serve":
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    elif mode == "read":
        read(sys.argv[2:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
