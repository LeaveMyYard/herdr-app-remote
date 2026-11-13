// The Claude reader child (docs/chatview.md §2.2). Bundled on its own into dist/claude-reader.mjs and run by
// `ReaderPool` as `node --permission --allow-fs-read=... claude-reader.mjs --idle-ms N`, with a clean env whose
// only Claude setting is CLAUDE_CONFIG_DIR. It imports only the SDK's two session readers: it never calls
// query(), so it never starts Claude, spends tokens or writes anything (the permission model also denies
// writes and child processes). Requests and replies are line-delimited JSON (`wire.ts`), handled one at a time.
import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { checkRequest, type WireReply, type WireRequest } from "./wire.js";

const argIdle = process.argv.indexOf("--idle-ms");
const idleMs = argIdle > 0 ? Number(process.argv[argIdle + 1]) : NaN;
if (!process.env.CLAUDE_CONFIG_DIR || !Number.isInteger(idleMs) || idleMs <= 0) {
  process.stderr.write("claude-reader: needs CLAUDE_CONFIG_DIR and --idle-ms\n");
  process.exit(2);
}

let idle: NodeJS.Timeout | undefined;
/** Exits by itself after `idleMs` with no request, in case the bridge's own idle timer never fires. */
const arm = (): void => {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), idleMs);
};

async function answer(req: WireRequest): Promise<WireReply> {
  try {
    const dir = req.dir !== undefined ? { dir: req.dir } : {};
    if (req.op === "info") return { id: req.id, ok: true, value: (await getSessionInfo(req.session, dir)) ?? null };
    const page = { ...(req.limit !== undefined ? { limit: req.limit } : {}), ...(req.offset !== undefined ? { offset: req.offset } : {}) };
    return { id: req.id, ok: true, value: await getSessionMessages(req.session, { ...dir, ...page, includeSystemMessages: true }) };
  } catch {
    return { id: req.id, ok: false, error: "failed" };
  }
}

function write(reply: WireReply): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.write(JSON.stringify(reply) + "\n")) resolve();
    else process.stdout.once("drain", resolve);
  });
}

let chain = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (idle) clearTimeout(idle);
  chain = chain.then(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const req = checkRequest(parsed);
    const id = parsed !== null && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "number" ? (parsed as { id: number }).id : -1;
    await write(req ? await answer(req) : { id, ok: false, error: "bad_request" });
    arm();
  });
});
lines.on("close", () => void chain.then(() => process.exit(0)));
arm();
