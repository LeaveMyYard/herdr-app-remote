import type { Connection } from "../model";

const COPY: Record<Exclude<Connection["status"], "online">, { cls: string; text: (c: Connection) => string }> = {
  connecting: { cls: "s-q", text: () => "Connecting to your computer…" },
  offline: { cls: "s-fail", text: () => "No connection. Retrying…" },
  unpaired: { cls: "s-wait", text: () => "This phone isn't paired yet. Pair it from Remote on your computer." },
  refused: { cls: "s-fail", text: () => "Your computer no longer accepts this phone." },
  paused: { cls: "s-wait", text: () => "Remote access is paused on your computer." },
  unavailable: { cls: "s-wait", text: () => "Your computer isn't serving right now. Retrying…" },
  stale: {
    cls: "s-wait",
    text: (c) =>
      // Wording for this reason is fixed by PLAN section 3 and bridge-api-v1.
      c.reason === "layout_without_remote"
        ? "Switch to a layout with Remote"
        : c.age
          ? `Showing data from ${c.age} ago`
          : "Showing older data",
  },
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
