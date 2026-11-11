// `push.json` (0600): one Web Push subscription per device. The endpoint URL is a bearer capability for
// pushing to that phone, so it is kept like a secret: 0600, never logged, never sent to any client.
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export const PUSH_FILE = "push.json";

/**
 * Writes `data` as JSON to `file` atomically (temp file, fsync, rename, directory fsync), mode 0600.
 * `exclusive` never replaces an existing file: it returns false instead.
 */
export function writeAtomic(dir: string, file: string, data: unknown, o: { exclusive?: boolean } = {}): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  let wrote = true;
  if (o.exclusive) {
    try {
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        unlinkSync(tmp);
        throw e;
      }
      wrote = false;
    }
    unlinkSync(tmp);
  } else {
    renameSync(tmp, file);
  }
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
  return wrote;
}

const B64U = z.string().regex(/^[A-Za-z0-9_-]+$/);
const SubSchema = z
  .object({
    device: z.string().regex(/^d-[0-9a-f]{16}$/),
    endpoint: z.string().url().max(1024),
    p256dh: B64U.length(87),
    auth: B64U.length(22),
    created_at: z.number().int(),
  })
  .strict();
export type PushSub = z.infer<typeof SubSchema>;

const FileSchema = z.object({ v: z.literal(1), subs: z.array(SubSchema) }).strict();

/**
 * The subscriptions, one per device. A file that fails validation is set aside as `push.json.damaged` (still
 * 0600) and the store starts empty: the safe failure of an optional feature is "no pushes" (phones turn
 * notifications on again), not a bridge that won't start.
 */
export class PushStore {
  private readonly file: string;
  private subs: PushSub[] = [];
  /** The file on disk could not be read and was set aside. */
  readonly damaged: boolean = false;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, PUSH_FILE);
    if (!existsSync(this.file)) return;
    chmodSync(this.file, 0o600);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      raw = undefined;
    }
    const parsed = FileSchema.safeParse(raw);
    if (parsed.success) {
      this.subs = parsed.data.subs;
      return;
    }
    this.damaged = true;
    // Kept for a person to look at, never read again; the next write starts a fresh file.
    renameSync(this.file, `${this.file}.damaged`);
  }

  get path(): string {
    return this.file;
  }

  all(): readonly PushSub[] {
    return this.subs;
  }

  get(device: string): PushSub | undefined {
    return this.subs.find((s) => s.device === device);
  }

  /** Replaces the device's subscription. */
  put(sub: PushSub): void {
    // One per device, and one per endpoint: a phone paired again must not get every notification twice.
    this.save([...this.subs.filter((s) => s.device !== sub.device && s.endpoint !== sub.endpoint), sub]);
  }

  /** Removes the device's subscription; only when it still has `endpoint`, if given (a stale 410 must not drop a newer one). */
  remove(device: string, endpoint?: string): boolean {
    const next = this.subs.filter((s) => !(s.device === device && (endpoint === undefined || s.endpoint === endpoint)));
    if (next.length === this.subs.length) return false;
    this.save(next);
    return true;
  }

  /** Removes every subscription whose device fails `keep`, in one write. Returns the removed ones. */
  retain(keep: (device: string) => boolean): PushSub[] {
    const gone = this.subs.filter((s) => !keep(s.device));
    if (gone.length === 0) return [];
    this.save(this.subs.filter((s) => keep(s.device)));
    return gone;
  }

  /** Writes first, then takes the new list: after a failed write, memory still matches the disk. */
  private save(next: PushSub[]): void {
    writeAtomic(this.dir, this.file, { v: 1, subs: next });
    this.subs = next;
  }
}
