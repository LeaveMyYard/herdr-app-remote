import type { ReactNode } from "react";

/** The one app frame (.ph, pinned to the window and never past it): every route, tabbed or full screen, renders inside it. */
export function AppFrame({ className = "", children, "data-state": state }: { className?: string; children: ReactNode; "data-state"?: string }) {
  return (
    <div className={`hd ph${className ? ` ${className}` : ""}`} data-state={state}>
      {children}
    </div>
  );
}
