import { RMV_BASE_URL, parseLastTarget } from "../inboxSend";
import { rmvPanelUrl } from "./logic";

// ponytail: no UI of its own; rmv below 700px already renders its phone layout.
const frame = document.getElementById("rmv") as HTMLIFrameElement;

async function show(raw: unknown) {
  const target = parseLastTarget(raw);
  let sessions: unknown = null;
  if (target) {
    try { sessions = await (await fetch(`${RMV_BASE_URL}/sessions`, { cache: "no-store" })).json(); }
    catch { /* rmv down: fall back to ?repo= */ }
  }
  const url = rmvPanelUrl(RMV_BASE_URL, target, sessions);
  if (frame.src !== url) frame.src = url;
}

void chrome.storage.local.get("lastTarget").then((value) => show(value.lastTarget));
chrome.storage.local.onChanged.addListener((changes) => {
  if ("lastTarget" in changes) void show(changes.lastTarget.newValue);
});

// The shortcut toggles: the background keeps this port while the panel is open and sends "close".
const connect = (windowId: number) => {
  const port = chrome.runtime.connect({ name: `rmp-panel:${windowId}` });
  port.onMessage.addListener((message) => { if (message === "close") window.close(); });
  // The worker is stopped after ~30s idle and forgets this port; reconnect so the shortcut still closes.
  port.onDisconnect.addListener(() => connect(windowId));
};
void chrome.windows.getCurrent().then((window_) => connect(window_.id!));
