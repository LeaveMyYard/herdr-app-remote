// The pairing screen (board PhonePair: check, wait, ok, bad, first). Copy follows design/COPY.md and the board.
import { useEffect, useRef, useState, type ReactNode } from "react";
import appIcon from "../assets/remote.svg";
import { Tile } from "../components/StateMarks";
import { fetchApi, isStandalone, parseFragment, runPairing, setPromptWanted, type PairApi, type PairView } from "./flow";

function Mark({ chip }: { chip: ReactNode }) {
  return (
    <div className="pair-mark">
      <img src={appIcon} alt="" className="pair-icon" />
      <span className="row pair-chip">{chip}</span>
    </div>
  );
}

const Spinner = () => <i className="spin pair-spinner" data-vis-mask="" aria-hidden="true" />;
const WaitDot = () => <span className="nf pair-dot" data-vis-mask="" aria-hidden="true" />;

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="col pair-steps">
      {items.map((s, i) => (
        <li key={i} className="row pair-step">
          <span className="mono nf row pair-step-n">{i + 1}</span>
          <span className="f1">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Block({ chip, title, body, extra, foot }: { chip: ReactNode; title: string; body: string; extra?: ReactNode; foot?: ReactNode }) {
  return (
    <>
      <div className="nf pair-top" />
      <main className="col f1 pair-main">
        <Mark chip={chip} />
        <h1 className="pair-title">{title}</h1>
        <p className="pair-body">{body}</p>
        {extra}
      </main>
      {foot}
    </>
  );
}

/** One state of the board. `host` is the computer's name ("desk-1"). */
export function PairPage({ view, host, onContinue }: { view: PairView; host: string; onContinue?: () => void }) {
  const name = view.name ?? "This phone";
  let inner: ReactNode;
  switch (view.state) {
    case "check":
      inner = <Block chip={<Spinner />} title="Checking the code…" body={`Pairing this phone with ${host}.`} />;
      break;
    case "wait":
      inner = (
        <Block
          chip={<WaitDot />}
          title="Approve on your computer"
          body={`${host} is asking whether to let this phone in. Approve it there to finish.`}
          extra={
            <>
              <div className="col pair-card pair-facts">
                <div className="row pair-kv">
                  <span className="f1 pair-k">Shows as</span>
                  <span className="pair-v">{name}</span>
                </div>
                <div className="row pair-kv">
                  <span className="f1 pair-k">Computer</span>
                  <span className="pair-v">{host}</span>
                </div>
                <div role="status" className="row pair-waiting">
                  <WaitDot />
                  Waiting for approval…
                </div>
              </div>
              <p className="pair-note">The request ends after 10 minutes if no one approves it.</p>
            </>
          }
        />
      );
      break;
    case "ok":
      inner = (
        <Block
          chip={<Tile code="done" size={18} />}
          title={`${name} is paired`}
          body={`${host} approved this phone. You can remove it any time in Remote on the computer.`}
          extra={<p className="pair-note">Opening Herdr…</p>}
          foot={
            <div className="col nf pair-foot">
              <button type="button" className="row pair-solid" onClick={onContinue}>
                Continue
              </button>
            </div>
          }
        />
      );
      break;
    case "bad":
      inner = view.transfer ? (
        // Not drawn on the board (provisional): a spent or expired Home Screen code is fixed from Safari, not by a new QR code.
        <Block
          chip={<Tile code="fail" size={18} />}
          title="This code no longer works"
          body="Each setup link works once, for 10 minutes."
          extra={<Steps items={["Open Herdr in Safari on this phone.", "Tap the bell at the top, then add Herdr to your Home Screen again."]} />}
        />
      ) : (
        <Block
          chip={<Tile code="fail" size={18} />}
          title="This code no longer works"
          body="Each code works once, for 5 minutes."
          extra={<Steps items={[`On ${host}, open Remote › Devices for a fresh code.`, "Scan it with the iPhone Camera."]} />}
        />
      );
      break;
    case "first":
      inner = <Block chip={<Spinner />} title="Finishing setup on this phone…" body="Using the pairing from Safari. No need to approve again." />;
      break;
  }
  return (
    <div className="hd ph pair" data-state={view.state}>
      {inner}
    </div>
  );
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `/pair#c=…` and `/pair#t=…`: runs the flow against the bridge. */
export function PairScreen({
  host,
  hash = window.location.hash,
  api = fetchApi,
  open = () => window.location.replace("/"),
  sleep = realSleep,
  standalone = isStandalone,
}: {
  host: string;
  hash?: string;
  api?: PairApi;
  open?: () => void;
  sleep?: (ms: number) => Promise<void>;
  standalone?: () => boolean;
}) {
  const [view, setView] = useState<PairView>(() => ({ state: parseFragment(hash)?.kind === "t" ? "first" : "check" }));
  // Started once per screen, even when StrictMode runs the effect twice: a code must never be posted twice.
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      const frag = parseFragment(hash);
      // The code leaves the address bar (and history) at once; it is single use either way.
      try {
        if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
      } catch {
        // Not fatal: the code dies on first use.
      }
      void runPairing(frag, {
        api,
        show: (v) => {
          if (alive.current) setView(v);
        },
        open,
        offerHomeScreen: () => {
          if (!standalone()) setPromptWanted(true);
        },
        sleep,
        alive: () => alive.current,
      });
    }
    return () => {
      alive.current = false;
    };
  }, [hash, api, open, sleep, standalone]);
  return <PairPage view={view} host={host} onContinue={open} />;
}
