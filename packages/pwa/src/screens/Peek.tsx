import type { bridgeApi } from "@herdr-remote/protocol";
import { Icon } from "../components/Icon";
import { Badge, HarnessIcon, styleCode } from "../components/StateMarks";
import { age } from "../panorama/format";

type Root = bridgeApi.PanoramaRoot;
type Node = bridgeApi.PanoramaNode;

export interface TranscriptPage {
  /** "41–80 / 80" */
  range: string;
  entries: { role: string; text: string }[];
  prev: boolean;
  next: boolean;
}

export interface PeekProps {
  root: Root;
  node: Node;
  spaceName: string | null;
  now: number;
  /** Absent until a transcript source exists: the feed only carries a local path, which the phone can't read. */
  transcript?: TranscriptPage | undefined;
  closeHref: string;
  /** Only with a verified live terminal. */
  openRootHref?: string | undefined;
}

/** The sentence under the title for a node that needs something, in the feed's own words. */
function problem(node: Node): { text: string } | null {
  const first = node.pending[0];
  switch (node.status) {
    case "blk":
      return { text: `Blocked: ${first ?? "needs permission"}.` };
    case "wait":
      return { text: `Waiting: ${first ?? "needs an answer"}.` };
    case "fail":
      return { text: `Failed: ${node.error ?? "no detail available"}.` };
    default:
      return null;
  }
}

/**
 * PhonePeek: feed fields only (title, status, model, time, tool calls, role, error, last message, owner).
 * The sheet draws over its own backdrop; the transcript viewer appears only when a page is supplied.
 */
export function Peek({ root, node, spaceName, now, transcript, closeHref, openRootHref }: PeekProps) {
  const p = problem(node);
  const cls = styleCode(node.status);
  const facts = [`${node.role || node.title} ${node.id}`, node.model, age(node.last_at ?? node.started, now), `${node.tool_calls} calls`].filter(Boolean).join(" · ");
  const owner = [spaceName, root.title].filter(Boolean).join(" · ");
  return (
    <div className="rel f1">
      <div className="abs col pk-back" aria-hidden="true">
        <div className="pk-back-title">Swarm</div>
        <div className="pk-back-a" />
        <div className="pk-back-b" />
      </div>
      <div className="abs pk-scrim" />
      <section aria-label="Peek" className={`abs col pk-sheet s-${cls}`}>
        <div className="row nf pk-grab">
          <i />
        </div>
        <div className="z col f1 pk-body">
          <div className="rel col pk-card">
            <span className="abs pk-edge" />
            <div className="row pk-top">
              <HarnessIcon name={node.harness} size={16} />
              <span className="tr pk-name">{node.title}</span>
              <span className="f1 tr pk-model">{node.model ?? ""}</span>
              <Badge code={node.status} h={20} />
              <a href={closeHref} aria-label="Close" className="row nf pk-close">
                <Icon name="x" size={12} />
              </a>
            </div>
            <div className="col pk-facts">
              <span>{facts}</span>
              <span>
                {owner ? `Subagent of ${owner}. ` : ""}It has no pane of its own.
              </span>
            </div>
            {p ? <div className="pk-note">{p.text}</div> : null}
            {node.last_message ? (
              <div className="col pk-last">
                <span className="pk-last-k">Last message</span>
                <span className="pk-last-v">{node.last_message}</span>
              </div>
            ) : null}
            <div className="row pk-acts">
              {openRootHref ? (
                <a href={openRootHref} className="row f1 pk-btn solid">
                  <span className="pk-btn-l">Open root pane</span>
                  <span className="mono pk-key">⏎</span>
                </a>
              ) : null}
              {transcript ? (
                <a href="#transcript" className="row f1 pk-btn">
                  <span>Transcript</span>
                  <span className="mono pk-key">t</span>
                </a>
              ) : null}
            </div>
          </div>
          {transcript ? (
            <div className="col f1 pk-tr">
              <div className="row pk-tr-head">
                <span className="pk-tr-title">Transcript</span>
                <span className="f1 pk-tr-range">{transcript.range}</span>
                <button type="button" aria-label="Previous page" className="row pk-page" disabled={!transcript.prev}>
                  ←
                </button>
                <button type="button" aria-label="Next page" className="row pk-page" disabled={!transcript.next}>
                  →
                </button>
              </div>
              <div className="mono f1 pk-tr-text">
                {transcript.entries.map((e, i) => (
                  <span key={i}>
                    <span className="pk-tr-role">{e.role}</span>
                    {"\n"}
                    {e.text}
                    {i < transcript.entries.length - 1 ? "\n\n" : ""}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
