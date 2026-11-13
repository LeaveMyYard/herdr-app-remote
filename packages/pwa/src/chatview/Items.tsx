import { useState, type ReactNode } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import claudeIcon from "../assets/claude.svg";
import { Markdown } from "./markdown";
import * as W from "./words";

type Item = bridgeApi.ChatItem;

/** Everything a row needs besides the item. */
export interface ItemCtx {
  /** The agent's name in the label above its replies. */
  agent: string;
  /** The host says the agent is working: a call with no result yet shows a spinner only then. */
  working: boolean;
  now: number;
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <i className="spin work-spinner" data-vis-mask="" style={{ width: size, height: size }} role="img" aria-label="Working" />;
}

function ToolsRow({ tools, working }: { tools: bridgeApi.ChatTools; working: boolean }) {
  const [open, setOpen] = useState(false);
  const running = working && tools.running > 0;
  const failed = tools.failed > 0;
  const label = failed ? W.failedLabel(tools.kind, tools.failed) : W.toolsLabel(tools.kind, tools.count, running);
  const expandable = tools.names.length > 0;
  const inner = (
    <>
      <span className="mono cv-dot" aria-hidden="true">
        ⏺
      </span>
      <span>{label}</span>
      {running ? <Spinner /> : expandable ? <span className={`cv-chev${open ? " cv-chev-open" : ""}`} aria-hidden="true">›</span> : null}
    </>
  );
  return (
    <div className="col cv-tools-wrap">
      {expandable ? (
        <button type="button" className={`row cv-tools${failed ? " cv-tools-failed" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {inner}
        </button>
      ) : (
        <div className={`row cv-tools${failed ? " cv-tools-failed" : ""}`}>{inner}</div>
      )}
      {open ? (
        <ul className="cv-tool-names">
          {tools.names.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AskCard({ item }: { item: Extract<Item, { role: "ask" }> }) {
  const a = item.ask;
  if (a.via === "inbox") {
    return (
      <div className="row cv-asked">
        <span>{W.ASKED}</span>
      </div>
    );
  }
  return (
    <section className="col cv-ask" aria-label="Question">
      {a.header ? <span className="cv-ask-head">{a.header}</span> : null}
      {a.question ? <p className="cv-ask-q">{a.question}</p> : null}
      <ul className="cv-ask-opts">
        {a.options.map((o, i) => (
          <li key={i}>
            <span>{o.label}</span>
            {o.description ? <span className="cv-ask-d">{o.description}</span> : null}
          </li>
        ))}
      </ul>
      {item.cut ? <span className="cv-cut">{W.CUT}</span> : null}
    </section>
  );
}

/**
 * The default row for each role. A new role (CV7's prompt cards, CV8's status row) or a plugin's item (CV5) joins here
 * or through `ChatView`'s `renderItem`; a role this version doesn't draw shows nothing.
 */
export function renderDefaultItem(item: Item, prev: Item | undefined, ctx: ItemCtx): ReactNode {
  switch (item.role) {
    case "divider":
      // A day divider with no time has nothing to say (§3).
      if (item.divider === "day" && !item.at) return null;
      return (
        <div className="row cv-divider" role="separator">
          <span className="f1 cv-rule" />
          {item.divider === "compact" ? W.COMPACTED : item.at ? W.dayLabel(item.at, ctx.now) : null}
          <span className="f1 cv-rule" />
        </div>
      );
    case "you":
      return item.command ? (
        <div className="row cv-you">
          <span className="mono cv-chip">{item.text}</span>
        </div>
      ) : (
        <div className="col cv-you">
          <div className="cv-bubble">{item.text}</div>
          {item.cut ? <span className="cv-cut">{W.CUT}</span> : null}
        </div>
      );
    case "agent": {
      const label = prev === undefined || prev.role === "you" || prev.role === "divider" || prev.role === "ask";
      return (
        <div className="col cv-agent">
          {label ? (
            <div className="row cv-agent-label">
              <img className="hn" src={claudeIcon} alt="" width={13} height={13} />
              <span>{ctx.agent}</span>
            </div>
          ) : null}
          <Markdown text={item.text} />
          {item.cut ? <span className="cv-cut">{W.CUT}</span> : null}
        </div>
      );
    }
    case "tools":
      return <ToolsRow tools={item.tools} working={ctx.working} />;
    case "ask":
      return <AskCard item={item} />;
    case "prompt":
    case "status":
      return null;
  }
}
