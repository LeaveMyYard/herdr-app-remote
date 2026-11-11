// "Get notifications on this phone" (board PhonePair, state "In Safari"): after pairing in Safari, a dismissible card
// asks to add Herdr to the Home Screen, where Web Push works and the app opens already set up. The bell in the header
// opens it again. Shown in the browser only, never in the installed app.
import { createContext, useContext } from "react";
import appIcon from "../assets/remote.svg";
import { Icon } from "../components/Icon";

/** What the header's bell does; null hides the bell (the installed app, tests, the visual harness by default). */
export const HomePromptBell = createContext<(() => void) | null>(null);

export function useHomePromptBell(): (() => void) | null {
  return useContext(HomePromptBell);
}

const ShareGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Share" role="img" className="share-glyph">
    <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" />
    <path d="M6 11H5v10h14V11h-1" />
  </svg>
);

export function BellButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Notifications" className="row icon-btn bell-btn" onClick={onClick}>
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
        <path d="M10 20.5a2 2 0 0 0 4 0" />
      </svg>
    </button>
  );
}

export function HomePrompt({ onClose }: { onClose: () => void }) {
  const steps = [
    <>
      Tap Share <ShareGlyph /> below.
    </>,
    "Tap Add to Home Screen.",
    "Open Herdr from your Home Screen.",
  ];
  return (
    <section aria-label="Get notifications" className="col home-prompt">
      <div className="row home-prompt-head">
        <img src={appIcon} alt="" className="nf home-prompt-icon" />
        <div className="col f1 home-prompt-text">
          <span className="home-prompt-title">Get notifications on this phone</span>
          <span className="home-prompt-sub">Add Herdr to your Home Screen. It opens already set up.</span>
        </div>
        <button type="button" aria-label="Close" className="row nf home-prompt-close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <ol className="col pair-steps home-prompt-steps">
        {steps.map((s, i) => (
          <li key={i} className="row pair-step">
            <span className="mono nf row pair-step-n">{i + 1}</span>
            <span className="f1">{s}</span>
          </li>
        ))}
      </ol>
      <div className="row home-prompt-foot">
        <span className="f1 home-prompt-hint">To see this again, tap the bell at the top.</span>
        <button type="button" className="home-prompt-later" onClick={onClose}>
          Not now
        </button>
      </div>
    </section>
  );
}
