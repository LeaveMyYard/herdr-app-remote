import type { ReactNode } from "react";
import { ICON, ICON_STROKE } from "../tokens.generated";

type IconName = keyof typeof ICON;

/** Icons from the design's common.py `ICON` table (24px viewBox). */
export function Icon({ name, size, className }: { name: IconName; size: number; className?: string }) {
  const sw = (ICON_STROKE as Record<string, number>)[name] ?? 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flex: "none" }}
      // The paths come from the committed design table, not from user input.
      dangerouslySetInnerHTML={{ __html: ICON[name] }}
    />
  );
}

/** Tab-bar glyphs (PhoneAgents boards): 22px, stroke 1.7, no round caps. */
export function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      {children}
    </svg>
  );
}
