import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Caps } from "./caps.js";

export const DEVICES_FILE = "devices.json";

const CapsSchema = z
  .object({
    view: z.boolean(),
    "inbox.answer": z.boolean(),
    navigate: z.boolean(),
    "terminal.input": z.boolean(),
    "terminal.input.until": z.number().int().nullable(),
    push: z.boolean(),
  })
  .strict();

const DeviceSchema = z
  .object({
    id: z.string().regex(/^d-[0-9a-f]{16}$/),
    name: z.string().min(1).max(32),
    /** The `Tailscale-User-Login` that paired it. */
    login: z.string().min(1),
    /** sha256 (hex) of the device token. The token itself is never stored. */
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(["pending", "approved"]),
    caps: CapsSchema,
    created_at: z.number().int(),
    approved_at: z.number().int().nullable(),
    last_seen: z.number().int().nullable(),
  })
  .strict();
export type Device = z.infer<typeof DeviceSchema>;

const FileSchema = z
  .object({
    v: z.literal(1),
    paused: z.boolean(),
    devices: z.array(DeviceSchema),
  })
  .strict();
type DevicesFile = z.infer<typeof FileSchema>;

export function newDeviceId(): string {
  return `d-${randomBytes(8).toString("hex")}`;
}

/**
 * `devices.json` (0600, in a 0700 directory): the paired devices and the pause flag.
 * Writes are atomic (temp file, fsync, rename). A file that fails validation is an
 * error, not an empty list: the bridge fails closed rather than forgetting revocations.
 */
export class DeviceStore {
  private readonly file: string;
  private data: DevicesFile;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.file = join(dir, DEVICES_FILE);
    if (existsSync(this.file)) {
      chmodSync(this.file, 0o600);
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const parsed = FileSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`${this.file} is invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
      this.data = parsed.data;
    } else {
      this.data = { v: 1, paused: false, devices: [] };
    }
  }

  get path(): string {
    return this.file;
  }

  get paused(): boolean {
    return this.data.paused;
  }

  set paused(v: boolean) {
    this.data.paused = v;
    this.save();
  }

  all(): readonly Device[] {
    return this.data.devices;
  }

  get(id: string): Device | undefined {
    return this.data.devices.find((d) => d.id === id);
  }

  byTokenHash(hash: string): Device | undefined {
    return this.data.devices.find((d) => d.token_sha256 === hash);
  }

  add(d: Device): void {
    this.data.devices.push(d);
    this.save();
  }

  /** Applies `fn` to a device and saves. Returns the device, or undefined if unknown. */
  update(id: string, fn: (d: Device) => void): Device | undefined {
    const d = this.get(id);
    if (!d) return undefined;
    fn(d);
    this.save();
    return d;
  }

  remove(id: string): Device | undefined {
    const i = this.data.devices.findIndex((d) => d.id === id);
    if (i < 0) return undefined;
    const [d] = this.data.devices.splice(i, 1);
    this.save();
    return d;
  }

  /** Removes every device matching `pred` in one write. */
  removeWhere(pred: (d: Device) => boolean): Device[] {
    const gone = this.data.devices.filter(pred);
    if (gone.length === 0) return [];
    this.data.devices = this.data.devices.filter((d) => !pred(d));
    this.save();
    return gone;
  }

  private save(): void {
    const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(this.data, null, 2)}\n`);
      fsyncSync(fd);
    } catch (e) {
      closeSync(fd);
      unlinkSync(tmp);
      throw e;
    }
    closeSync(fd);
    renameSync(tmp, this.file);
  }
}

export type { Caps };
