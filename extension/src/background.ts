import {
  INBOX_BASE_URL, buildTargetList, deliverViaRmv, fetchInboxSessions, fetchTicketStatus,
  lastTargetAfterSend, parseLastTarget, postAnnotationsToInbox, probeRmvDeliver,
} from "./inboxSend";
import type { InboxSession, InboxSendResult, SessionsReply, TargetDelivery } from "./inboxSend";
import { VIEWER, validMessage } from "./messages";

export type DeliveryRoute = TargetDelivery | "pending";

export function deliveryRoute(
  result: Pick<InboxSendResult, "delivered" | "deliver">,
  session?: InboxSession,
): DeliveryRoute {
  if (result.delivered) return "now";
  if (result.deliver === "rmv_timeout") return "pending";
  // rmv's refusal describes the live terminal; don't also enqueue a hook delivery.
  if (result.deliver) return "manual";
  return session?.delivery === "next" ? "next" : "manual";
}

export function createBackground(api: typeof chrome, fetchImpl: typeof fetch = fetch) {
  // Finish injection before processing another action or command on the same tab.
  const activating = new Map<number, Promise<void>>();

  async function activateTab(tab: chrome.tabs.Tab, copy: boolean) {
    const tabId = tab.id;
    if (tabId === undefined) return;
    const url = tab.url ?? "";
    const pdfPath = (() => {
      try { return new URL(url).pathname.toLowerCase().endsWith(".pdf"); }
      catch { return false; }
    })();
    let pdf = pdfPath;
    if (!pdfPath) {
      try {
        const results = await api.scripting.executeScript({
          target: { tabId }, func: () => document.contentType === "application/pdf",
        });
        pdf = results[0]?.result === true;
      } catch { /* Restricted pages will report their injection error below. */ }
    }
    if (pdf) {
      await api.tabs.create({ url: api.runtime.getURL(`${VIEWER}?file=${encodeURIComponent(url)}`) });
      return;
    }
    try {
      const answer = await api.tabs.sendMessage(tabId, { type: copy ? "rmp:copy-tab-id" : "rmp:toggle" });
      if (answer && typeof answer.active === "boolean") return;
    } catch { /* No listener yet: inject once. */ }
    await api.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
    if (copy) await api.tabs.sendMessage(tabId, { type: "rmp:copy-tab-id" });
  }

  async function activate(tab: chrome.tabs.Tab, copy: boolean) {
    if (tab.id === undefined) return;
    const previous = activating.get(tab.id);
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(() => activateTab(tab, copy));
    activating.set(tab.id, current);
    try { await current; }
    finally { if (activating.get(tab.id) === current) activating.delete(tab.id); }
  }

  async function targets(url: string, picked?: { sid: string | null }) {
    const last = parseLastTarget((await api.storage.local.get("lastTarget")).lastTarget);
    const [reply, extDeliver] = await Promise.all([
      fetchInboxSessions(url, last?.sid ?? "", { fetchImpl }),
      probeRmvDeliver({ fetchImpl }),
    ]);
    return { reply, list: buildTargetList(reply, last, picked ?? null, extDeliver) };
  }

  async function remember(result: Pick<InboxSendResult, "reason">, to: string | null, reply: SessionsReply, noTarget: boolean) {
    const session = reply.available ? reply.sessions.find((s) => s.sid === to) : undefined;
    const change = lastTargetAfterSend(result, {
      to, toCwd: session?.cwd, toLabel: session?.label || session?.name, noTarget,
    });
    if (change === "clear") await api.storage.local.remove("lastTarget");
    else if (change) await api.storage.local.set({ lastTarget: change.set });
  }

  async function handle(raw: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (!validMessage(raw, sender, api.runtime.id)) throw new Error("拡張への依頼が不正です");
    let tabId = sender.tab?.id;
    if (tabId === undefined && sender.url?.startsWith(api.runtime.getURL(VIEWER))) {
      const documentId = (sender as chrome.runtime.MessageSender & { documentId?: string }).documentId;
      const contexts = documentId ? await api.runtime.getContexts({ documentIds: [documentId] }) : [];
      if (contexts.length === 1 && Number.isInteger(contexts[0].tabId) && contexts[0].tabId! >= 0) tabId = contexts[0].tabId;
    }
    switch (raw.type) {
      case "rmp:init": {
        if (tabId === undefined) throw new Error("PDF ビューアのタブ ID を取得できませんでした");
        return { tabId, list: (await targets(raw.url)).list };
      }
      case "rmp:targets": return (await targets(raw.url, raw.picked)).list;
      case "rmp:pick": {
        const { reply } = await targets(raw.url, { sid: raw.sid });
        await remember({ reason: "stored" }, raw.sid, reply, raw.sid === null);
        return { ok: true };
      }
      case "rmp:send": {
        const { reply, list } = await targets(raw.url, raw.picked);
        if (list.decision.action === "pick") return { kind: "pick", list };
        const to = list.decision.to;
        const result = await postAnnotationsToInbox(raw.annotations, { to, fetchImpl });
        if (result.reason === "stored") {
          // Remembering a target must never obscure a successful inbox receipt.
          await remember(result, to, reply, raw.picked?.sid === null).catch(() => {});
          const session = reply.available ? reply.sessions.find((s) => s.sid === to) : undefined;
          const option = list.options.find((s) => s.sid === to);
          if (option?.delivery === "now" && to && result.ticket) {
            const delivery = await deliverViaRmv(to, result.ticket, { fetchImpl });
            result.delivered = delivery.delivered;
            result.deliver = delivery.reason;
            result.via = delivery.via;
          }
          return { kind: "sent", result, route: deliveryRoute(result, session) };
        }
        return { kind: "sent", result, route: "manual" };
      }
      case "rmp:draft": {
        if (tabId === undefined) throw new Error("PDF ビューアのタブ ID を取得できませんでした");
        const response = await fetchImpl(`${INBOX_BASE_URL}/draft`, {
          method: "POST", body: JSON.stringify({ tabId, url: raw.url, title: raw.title, annotations: raw.annotations }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("下書きを保存できませんでした");
        return { ok: true };
      }
      case "rmp:capture": {
        if (tabId === undefined) throw new Error("PDF ビューアの撮影はページ側で行います");
        const [active] = await api.tabs.query({ active: true, windowId: sender.tab!.windowId });
        if (active?.id !== tabId) throw new Error("撮影するタブを開いてください");
        return { image: await api.tabs.captureVisibleTab(sender.tab!.windowId!, { format: "jpeg", quality: 80 }) };
      }
      case "rmp:status": return fetchTicketStatus(raw.ticket, { fetchImpl });
    }
  }
  return { activate, handle };
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  const background = createBackground(chrome);
  const report = (error: unknown) => console.error("Red Marker Page:", error);
  // A page the extension may not enter (Web Store, sign-in, Chrome's PDF viewer...) shows no toast,
  // so mark the toolbar icon for a few seconds instead of failing silently.
  const failed = (tabId: number | undefined) => (error: unknown) => {
    report(error);
    if (tabId === undefined) return;
    void chrome.action.setBadgeText({ tabId, text: "×" });
    void chrome.action.setTitle({ tabId, title: "このページでは注釈できません (拡張が入れないページです)" });
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      void chrome.action.setTitle({ tabId, title: "Red Marker Page" }).catch(() => {});
    }, 4_000);
  };
  // rmv side panel. sidePanel.open needs the user gesture, so it runs before any await.
  // ponytail: Dia may refuse the open on ⌘Enter; then the shortcut opens it.
  const panels = new Map<number, chrome.runtime.Port>();
  let lastWindowId: number | undefined;
  // ego's agent Spaces open tabs in their own windows, so the event's window is not the user's.
  // Ask the browser which window the user touched last instead.
  const trackWindow = () => {
    void chrome.windows.getLastFocused().then((window_) => { lastWindowId = window_.id; }).catch(() => {});
  };
  chrome.windows.onFocusChanged.addListener(trackWindow);
  chrome.tabs.onActivated.addListener(trackWindow);
  trackWindow();
  chrome.runtime.onConnect.addListener((port) => {
    const windowId = Number(/^rmp-panel:(\d+)$/.exec(port.name)?.[1]);
    if (port.sender?.id !== chrome.runtime.id || !Number.isInteger(windowId)) return;
    panels.set(windowId, port);
    port.onDisconnect.addListener(() => { if (panels.get(windowId) === port) panels.delete(windowId); });
  });
  const openPanel = (windowId: number | undefined) => {
    if (windowId !== undefined) chrome.sidePanel.open({ windowId }).catch(report);
  };

  chrome.action.onClicked.addListener((tab) => { void background.activate(tab, false).catch(failed(tab.id)); });
  chrome.commands.onCommand.addListener((command, commandTab) => {
    if (command === "open-rmv-panel") {
      // Dia may hand the shortcut no tab; then use the window focused last.
      const windowId = commandTab?.windowId ?? lastWindowId;
      const open = windowId === undefined ? undefined : panels.get(windowId);
      if (open) open.postMessage("close");
      else openPanel(windowId);
      return;
    }
    if (command !== "toggle-annotate" && command !== "copy-tab-id") return;
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) return background.activate(tab, command === "copy-tab-id").catch(failed(tab.id));
    }).catch(report);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === "rmp:send" && sender.id === chrome.runtime.id) openPanel(sender.tab?.windowId);
    void background.handle(message, sender).then(respond, (error) => {
      respond({ error: error instanceof Error ? error.message : "処理できませんでした" });
    });
    return true;
  });
}
