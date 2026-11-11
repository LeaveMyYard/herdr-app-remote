import { createContext, useContext, type ReactNode } from "react";

/** What the copy calls the computer until the bridge has told the phone its name. */
export const UNNAMED_HOST = "your computer";

const HostNameContext = createContext<string>(UNNAMED_HOST);

/** The computer's name ("desk-1") for the copy that points the person at it ("Turn it on in Remote on desk-1."). */
export const HostNameProvider = ({ name, children }: { name: string; children: ReactNode }) => <HostNameContext.Provider value={name}>{children}</HostNameContext.Provider>;

export const useHostName = (): string => useContext(HostNameContext);

/** `host_name` from a `GET /api/v1/meta` body; anything unexpected reads as absent. */
export function hostNameOfMeta(body: unknown): string | null {
  const n = body !== null && typeof body === "object" ? (body as { host_name?: unknown }).host_name : undefined;
  return typeof n === "string" && n.trim() !== "" ? n.trim() : null;
}

/** `GET /api/v1/meta`'s `host_name`; null when it failed, so the caller keeps its fallback. */
export async function fetchHostName(): Promise<string | null> {
  try {
    const r = await fetch("/api/v1/meta", { credentials: "same-origin", cache: "no-store" });
    return r.status === 200 ? hostNameOfMeta(await r.json()) : null;
  } catch {
    return null;
  }
}
