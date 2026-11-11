// The bundle's entry: `node bridge.mjs launch|serve --app-home ABS`. Exit codes: 0 done (or a bridge
// already runs), 1 refused (with one line on stderr), 2 usage.
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { install } from "@herdr-remote/protocol";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.js";
import { serve } from "./serve.js";
import { checkBundle } from "./self.js";

export function parseArgs(argv: string[]): { cmd: "launch" | "serve"; appHome: string } | null {
  const [cmd, flag, appHome, ...rest] = argv;
  if ((cmd !== "launch" && cmd !== "serve") || flag !== "--app-home" || !appHome || !isAbsolute(appHome) || rest.length) return null;
  return { cmd, appHome };
}

export async function main(argv: string[], bundle: string): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write("usage: bridge.mjs launch|serve --app-home ABS\n");
    return 2;
  }
  if (args.cmd === "launch") {
    const r = await launch({ appHome: args.appHome, bundle, node: process.execPath });
    if (!r.ok) process.stderr.write(`herdr-app-remote: not launched: ${r.reason}\n`);
    return r.ok ? 0 : 1;
  }
  const check = await checkBundle(args.appHome, bundle);
  if (!check.ok) {
    process.stderr.write(`herdr-app-remote: not serving: ${check.reason}\n`);
    return 1;
  }
  const pwa = join(args.appHome, install.PWA_DIR);
  const bridge = await serve({ appHome: args.appHome, bundleSha256: check.sha256, app: existsSync(pwa) ? { staticDir: pwa } : {} });
  if (!bridge) return 0;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(sig, () => void bridge.stop("signal"));
  await bridge.stopped;
  return 0;
}

/** True when this module is the program node was asked to run (not when a test imports it). */
function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const bundle = realpathSync(fileURLToPath(import.meta.url));
  main(process.argv.slice(2), bundle).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`herdr-app-remote: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
