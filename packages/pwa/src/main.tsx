import "./styles/fonts.css";
import "./styles/tokens.generated.css";
import "./styles/app.css";
import "./styles/panorama.css";
import "./styles/usage.css";
import "./styles/inbox.css";
import "./styles/chat.css";
import "./styles/pair.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BridgeClient } from "./bridge/client";
import { hostNameFrom, LiveApp } from "./LiveApp";
import type { ConnectionStatus } from "./model";
import { PairPage, PairScreen } from "./pair/PairScreen";
import type { PairView as PairViewState } from "./pair/flow";
import { HostNameProvider } from "./bridge/host-name";
import { boardData, host as demoHost } from "./fixtures";
import { registerServiceWorker } from "./sw-register";

const STATUSES: readonly ConnectionStatus[] = ["online", "connecting", "offline", "stale", "unpaired", "refused", "paused", "unavailable"];
const isStatus = (s: string): s is ConnectionStatus => (STATUSES as readonly string[]).includes(s);

/** The pairing board's states, with the fake device name the board shows. */
function pairFixture(state: string | null): PairViewState {
  switch (state) {
    case "check":
    case "first":
      return { state };
    case "ok":
    case "wait":
      return { state, name: "Phone 1" };
    case "bad-transfer":
      return { state: "bad", transfer: true };
    default:
      return { state: "bad" };
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// `?fixture=<name>` is for tests and the visual harness only: fake data, no bridge. `agents`, `swarm` and `peek`
// are the herdr-panorama boards; any other name (`basic`, `usage`) shows the demo screens, with the Usage
// scenario picked by the hash (`#/usage/missing`). `pair` is the pairing board in the state `&state=` names;
// `&banner=<status>` shows a connection banner and `&prompt=1` the Home Screen prompt (boards PhoneBanners, PhonePair).
const params = new URLSearchParams(window.location.search);
const fixture = params.get("fixture");
const host = hostNameFrom(window.location.hostname);
let app;
if (fixture === "pair") {
  app = <PairPage view={pairFixture(params.get("state"))} host="desk-1" />;
} else if (fixture !== null) {
  const banner = params.get("banner");
  const connection = banner !== null && isStatus(banner) ? { status: banner } : undefined;
  const prompt = params.get("prompt") === "1" ? { open: true, onOpen: () => undefined, onClose: () => undefined } : undefined;
  // The fake computer's name, as the bridge would give it ("desk-1").
  app = (
    <HostNameProvider name={demoHost.name}>
      <App data={boardData(fixture)} connection={connection} onRetry={() => undefined} homePrompt={prompt} />
    </HostNameProvider>
  );
} else if (window.location.pathname === "/pair") {
  app = <PairScreen host={host} />;
} else {
  const client = new BridgeClient({ events: { win: window, doc: document } });
  client.start();
  app = <LiveApp client={client} hostName={host} />;
}
createRoot(root).render(<StrictMode>{app}</StrictMode>);
registerServiceWorker();
