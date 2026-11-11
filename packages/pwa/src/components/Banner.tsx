import type { Connection } from "../model";

interface Copy {
  /** The state hue (`s-wait` amber, `s-fail` red, `s-q` grey). */
  cls: string;
  title: (c: Connection, host: string) => string;
  /** The second line, muted. */
  sub?: (host: string) => string;
  /** A button on the right. */
  action?: "retry";
}

// Board PhoneBanners and design/COPY.md (approved 2026-11-11). `host` is the computer's Tailscale machine name
// ("desk-1"). Funnel is deliberately not named on the phone.
const COPY: Record<Exclude<Connection["status"], "online">, Copy> = {
  connecting: { cls: "s-q", title: (_c, host) => `Connecting to ${host}…` },
  offline: { cls: "s-fail", title: () => "No connection. Retrying…" },
  unpaired: {
    cls: "s-wait",
    title: () => "This phone isn't paired yet.",
    sub: (host) => `Scan a fresh code from Remote › Devices on ${host} with the iPhone Camera.`,
  },
  refused: {
    cls: "s-fail",
    title: (_c, host) => `${host} no longer accepts this phone.`,
    sub: () => "It was removed, or this phone uses another account. Scan a fresh code from Remote › Devices with the iPhone Camera.",
  },
  paused: {
    cls: "s-q",
    title: (_c, host) => `Remote access is paused on ${host}.`,
    sub: () => "Resume it in Remote on the computer. This reconnects by itself.",
  },
  unavailable: {
    cls: "s-wait",
    title: (_c, host) => `Can't reach ${host}.`,
    sub: () => "It may be asleep or offline. Trying again every 10 s.",
    action: "retry",
  },
  stale: {
    cls: "s-wait",
    title: (c) =>
      // Wording for this reason is fixed by PLAN section 3 and bridge-api-v1.
      c.reason === "layout_without_remote"
        ? "Switch to a layout with Remote"
        : c.age
          ? `Showing data from ${c.age} ago`
          : "Showing older data",
  },
};

/** Connection and stale-data banner. Renders nothing while online. `host` is the computer's name ("desk-1"). */
export function Banner({ connection, host, onRetry }: { connection: Connection; host: string; onRetry?: (() => void) | undefined }) {
  if (connection.status === "online") return null;
  const c = COPY[connection.status];
  return (
    <div role="status" className={`banner ${c.cls}`} data-status={connection.status}>
      <span className="banner-dot" aria-hidden="true" />
      <span className="col f1 banner-text">
        <span className="banner-title">{c.title(connection, host)}</span>
        {c.sub ? <span className="banner-sub">{c.sub(host)}</span> : null}
      </span>
      {c.action === "retry" && onRetry ? (
        <button type="button" className="nf banner-action" onClick={onRetry}>
          Retry now
        </button>
      ) : null}
    </div>
  );
}
