// Whether our mod can go: removing it while the shown layout uses it leaves a hole in the window.
// Same rules as herdr-inbox's installer (app/installer/layouts.py): only the window knows what it
// shows, so it is asked (`herdr-app status`), and an answer that can't be used refuses. With no
// herdr-app to ask, a window whose socket answers refuses too. Everything here only reads.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import { isAbsolute, join } from "node:path";
import { usesMod } from "./layouts.js";

/** herdr-app's exit code for "no Herdr window". */
export const NO_WINDOW = 2;

export function windowRuns(appHome: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ path: join(appHome, "herdr-app.sock") });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(1000, () => done(true));
    s.once("connect", () => done(true));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code !== "ENOENT" && e.code !== "ECONNREFUSED"));
  });
}

/** The layout on screen; null when no window runs. Throws when that can't be known. */
export async function shownLayout(appHome: string, checker: string | null): Promise<string | null> {
  if (!checker) {
    if (await windowRuns(appHome)) {
      throw new Error("A window may be running and herdr-app was not found, so nothing can say what it shows; nothing changed. Quit it, or pass --checker with the path to herdr-app");
    }
    return null;
  }
  if (!isAbsolute(checker)) throw new Error("--checker must be an absolute path");
  const r = spawnSync(checker, ["status"], { env: { ...process.env, HERDR_APP_HOME: appHome }, encoding: "utf8", timeout: 3000 });
  const unknown = new Error("The window did not say what it shows; nothing changed. Quit it and try again");
  if (r.error) throw unknown;
  if (r.status === NO_WINDOW) return null;
  let name: unknown;
  try {
    name = r.status === 0 ? (JSON.parse(r.stdout) as { layout?: unknown }).layout : undefined;
  } catch {
    name = undefined;
  }
  if (typeof name !== "string" || !name || name.includes("/") || name.startsWith(".")) throw unknown;
  return name;
}

function layoutUses(appHome: string, name: string): boolean {
  return usesMod(JSON.parse(readFileSync(join(appHome, "layouts", `${name}.json`), "utf8")));
}

/**
 * Refuses when the shown layout uses our mod. Returns the names of the other layouts that still name
 * it once `leaving` (the layouts we remove) are gone: they show an empty block after the uninstall.
 */
export async function guardRemoval(appHome: string, checker: string | null, leaving: string[]): Promise<string[]> {
  const shown = await shownLayout(appHome, checker);
  if (shown !== null) {
    let uses: boolean;
    try {
      uses = layoutUses(appHome, shown);
    } catch {
      throw new Error(`Layout ${shown} is on screen and its file cannot be read, so it may show herdr-app-remote; nothing changed. Switch layouts or quit the window`);
    }
    if (uses) throw new Error(`Layout ${shown} is showing herdr-app-remote; nothing changed. Switch to a layout without it first`);
  }
  const notes: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(join(appHome, "layouts")).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return notes;
  }
  for (const f of names) {
    if (leaving.includes(`layouts/${f}`)) continue;
    try {
      if (layoutUses(appHome, f.slice(0, -5))) notes.push(`Layout ${f.slice(0, -5)} still names herdr-app-remote.`);
    } catch {
      /* unreadable: not ours to judge */
    }
  }
  return notes;
}
