import "./styles/fonts.css";
import "./styles/tokens.generated.css";
import "./styles/app.css";
import "./styles/panorama.css";
import "./styles/usage.css";
import "./styles/chat.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boardData } from "./fixtures";
import { registerServiceWorker } from "./sw-register";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// Until the bridge client lands, `?fixture=agents|swarm|peek` shows the herdr-panorama screens from fake data
// (the visual harness uses it); without it the Basic Agents screen shows as before.
const data = boardData(new URLSearchParams(window.location.search).get("fixture"));
createRoot(root).render(
  <StrictMode>
    <App data={data} />
  </StrictMode>,
);
registerServiceWorker();
