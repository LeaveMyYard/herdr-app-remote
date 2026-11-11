import { hostname } from "node:os";
import type { ServeIdentity } from "./security.js";

/**
 * The computer's name as the phone's copy says it ("desk-1"): the first label of the serve identity's tailnet name
 * (`desk-1.example-tailnet.ts.net:8443` becomes `desk-1`), else the first label of this machine's hostname. Never empty.
 * The single place the phone's name for the desktop comes from (`GET /api/v1/meta` `host_name`).
 */
export function hostName(serve: ServeIdentity | null, osHostname: () => string = hostname): string {
  return firstLabel(serve?.host ?? "") || firstLabel(osHostname()) || "this computer";
}

function firstLabel(name: string): string {
  return name.trim().replace(/:\d+$/, "").split(".")[0]?.trim() ?? "";
}
