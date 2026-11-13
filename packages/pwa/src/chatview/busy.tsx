import { createContext, useContext, useEffect, type ReactNode } from "react";

/** The text view reports what the person is in the middle of (a draft, the Keys sheet), so the chat view waits (§6). */
const Ctx = createContext<((id: string, busy: boolean) => void) | null>(null);

export function BusyProvider({ report, children }: { report: (id: string, busy: boolean) => void; children: ReactNode }) {
  return <Ctx.Provider value={report}>{children}</Ctx.Provider>;
}

export function useReportBusy(id: string, busy: boolean): void {
  const report = useContext(Ctx);
  useEffect(() => {
    if (!report) return;
    report(id, busy);
    return () => report(id, false);
  }, [report, id, busy]);
}
