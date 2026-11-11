import type { bridgeApi } from "@herdr-remote/protocol";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import agentIcon from "../assets/agent.svg";
import { STATES, type StateCode } from "../tokens.generated";

export type Code = bridgeApi.AgentCode;

/** `unknown` is drawn neutral (the idle colours) with its own label; every other code has a design state. */
export function styleCode(code: Code): StateCode {
  return code === "unknown" ? "idle" : code;
}

export const stateLabel = (code: Code): string => (code === "unknown" ? "Unknown" : STATES[code].label);

const GLYPH_TEXT = (code: Code): string => (code === "unknown" ? "?" : STATES[code].text);

/** The harness mark. An unsupported harness gets the generic icon, never Claude's. */
export function HarnessIcon({ name, size = 16 }: { name: string; size?: number }) {
  const src = name === "claude" ? claudeIcon : name === "codex" ? codexIcon : agentIcon;
  return <img className="hn" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />;
}

/** common.py `badge`: the glyph, a lead for needs states ("?2", "!"), then the label. */
export function Badge({ code, h = 18, questions, label }: { code: Code; h?: 17 | 18 | 20 | 22 | 24; questions?: number | undefined; label?: string }) {
  const cls = styleCode(code);
  const lead = code === "wait" && questions ? `?${questions}` : code === "wait" || code === "blk" ? GLYPH_TEXT(code) : "";
  return (
    <span className={`badge h${h} s-${cls}`}>
      <i className="gi" />
      <b className="lead">{lead}</b>
      {label ?? stateLabel(code)}
    </span>
  );
}

/** common.py `tile`: a square state mark; a count widens it (a lone finished mark stays square). */
export function Tile({ code, size = 16, count, still }: { code: Code; size?: 14 | 16 | 18 | 20; count?: number | undefined; still?: boolean }) {
  const cls = styleCode(code);
  const wide = typeof count === "number" && count > 0 && !(code === "done" && count === 1);
  const className = `tile s-${cls}${size !== 16 ? ` t${size}` : ""}${wide ? " wide" : ""}${still ? " still" : ""}`;
  // Needs tiles breathe, the running glyph spins: the visual harness masks both.
  const animated = cls === "wait" || cls === "blk" || cls === "fail";
  if (code === "wait" || code === "blk") {
    return (
      <span className={className} data-vis-mask={animated ? "" : undefined}>
        {code === "wait" ? `?${wide ? count : ""}` : wide ? `!${count}` : "!"}
      </span>
    );
  }
  return (
    <span className={className} data-vis-mask={animated ? "" : undefined}>
      <i className="gi" />
      {wide ? <span>{count}</span> : null}
    </span>
  );
}
