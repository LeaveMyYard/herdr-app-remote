import "./styles/fonts.css";
import "./styles/tokens.generated.css";
import "./styles/app.css";
import "./styles/panorama.css";
import "./styles/usage.css";
import "./styles/inbox.css";
import "./styles/chat.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BridgeClient } from "./bridge/client";
import { LiveApp } from "./LiveApp";
import { boardData } from "./fixtures";
import { registerServiceWorker } from "./sw-register";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// `?fixture=<name>` is for tests and the visual harness only: fake data, no bridge. `agents`, `swarm` and `peek`
// are the herdr-panorama boards; any other name (`basic`, `usage`) shows the demo screens, with the Usage
// scenario picked by the hash (`#/usage/missing`).
const fixture = new URLSearchParams(window.location.search).get("fixture");
let app;
if (fixture !== null) {
  app = <App data={boardData(fixture)} />;
} else {
  const client = new BridgeClient({ events: { win: window, doc: document } });
  client.start();
  app = <LiveApp client={client} />;
}
createRoot(root).render(<StrictMode>{app}</StrictMode>);
registerServiceWorker();
