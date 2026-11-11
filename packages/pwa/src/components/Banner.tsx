import type { Connection } from "../model";

const COPY: Record<Exclude<Connection["status"], "online">, { cls: string; text: (c: Connection) => string }> = {
  connecting: { cls: "s-q", text: () => "Connecting to your computer…" },
  offline: { cls: "s-fail", text: () => "No connection. Retrying…" },
  stale: { cls: "s-wait", text: (c) => (c.age ? `Showing data from ${c.age} ago` : "Showing older data") },
};

/** Connection and stale-data banner. Renders nothing while online. */
export function Banner({ connection }: { connection: Connection }) {
  if (connection.status === "online") return null;
  const { cls, text } = COPY[connection.status];
  return (
    <div role="status" className={`banner ${cls}`} data-status={connection.status}>
      <span className="banner-dot" aria-hidden="true" />
      {text(connection)}
    </div>
  );
}
