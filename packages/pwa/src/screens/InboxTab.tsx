import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import type { HostInfo, PluginRow } from "../model";
import { Inbox } from "./Inbox";
import { Missing } from "./Missing";

export interface InboxTabProps {
  host: HostInfo;
  topic: bridgeApi.InboxTopic;
  hostState?: HostState | undefined;
  plugins: PluginRow[];
  installCommand: string;
  /** POSIX seconds. */
  now: number;
}

function InboxGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M3 13l3-8h12l3 8v6H3z" />
      <path d="M3 13h5l1 2h6l1-2h5" />
    </svg>
  );
}

/** The Inbox tab: the "not installed" screen when herdr-inbox is missing, else PhoneInbox. */
export function InboxTab({ host, topic, hostState, plugins, installCommand, now }: InboxTabProps) {
  if (topic.plugin === "missing") {
    return (
      <Missing
        host={host}
        title="Inbox"
        plugin="herdr-inbox"
        blurb="This tab shows the questions and alerts your agents have for you."
        command={installCommand}
        icon={<InboxGlyph />}
        plugins={plugins.map((p) => (p.name === "herdr-inbox" ? { ...p, state: "missing" as const } : p))}
      />
    );
  }
  return <Inbox topic={topic} host={hostState} now={now} />;
}
