// .data/companion/status.json: what the companion is doing, for the web UI.
// Rewritten atomically (temp file + rename), at most once per second, and at
// least every heartbeat so a stale `updatedAt` means the companion is gone.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const COMPANION_STATES = [
  "waiting",
  "recording",
  "finalizing",
  "analyzing",
  "stopped",
] as const;
export type CompanionState = (typeof COMPANION_STATES)[number];

export const companionStatusSchema = z.object({
  state: z.enum(COMPANION_STATES),
  /** Session folder name under .data/live while recording/finalizing/analyzing. */
  session: z.string().nullable(),
  champion: z.string().nullable(),
  /** Latest game clock in seconds while recording. */
  gameTime: z.number().nullable(),
  /** ISO time the current session started. */
  startedAt: z.string().nullable(),
  /** Encoder used for screen capture, null when video is off/unavailable. */
  encoder: z.string().nullable(),
  updatedAt: z.string(),
  pid: z.number(),
  lastError: z.string().nullable(),
  /** Most recently finished session folder name (extra, for the UI). */
  lastSession: z.string().nullable().optional(),
  owner: z.string().optional(),
  automatic: z.boolean().optional(),
  accountId: z.string().optional(),
  analysisSession: z.string().nullable().optional(),
});
export type CompanionStatus = z.infer<typeof companionStatusSchema>;

export function initialStatus(pid: number, now = Date.now()): CompanionStatus {
  return {
    state: "waiting",
    session: null,
    champion: null,
    gameTime: null,
    startedAt: null,
    encoder: null,
    updatedAt: new Date(now).toISOString(),
    pid,
    lastError: null,
    lastSession: null,
  };
}

const sleepSync = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes JSON to a temp file and renames it over the target, so readers never
 * see a half-written file. Windows can refuse the rename for a moment while
 * another process holds the target open; that is retried briefly.
 */
export function writeJsonAtomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        rmSync(temp, { force: true });
        throw error;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export type StatusWriterOptions = {
  minIntervalMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  write?: (path: string, value: CompanionStatus) => void;
  onError?: (error: unknown) => void;
};

/** Throttled, heartbeat-refreshed status file. */
export class StatusWriter {
  private status: CompanionStatus;
  private lastWriteAt = -Infinity;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly minIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly write: (path: string, value: CompanionStatus) => void;
  private readonly onError: (error: unknown) => void;

  constructor(
    readonly path: string,
    initial: CompanionStatus,
    options: StatusWriterOptions = {},
  ) {
    this.status = { ...initial };
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.write = options.write ?? writeJsonAtomic;
    this.onError = options.onError ?? (() => {});
  }

  get current(): Readonly<CompanionStatus> {
    return this.status;
  }

  /** Merges a change; written now, or as soon as the throttle allows. */
  update(patch: Partial<Omit<CompanionStatus, "updatedAt">>) {
    Object.assign(this.status, patch);
    this.request();
  }

  /** Starts the heartbeat (keeps `updatedAt` fresh in every state). */
  start() {
    this.request();
    this.heartbeat ??= setInterval(() => this.request(), this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** Stops timers and writes the final state immediately. */
  close(patch: Partial<Omit<CompanionStatus, "updatedAt">> = {}) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    Object.assign(this.status, patch);
    this.writeNow();
  }

  private request() {
    const wait = this.lastWriteAt + this.minIntervalMs - this.now();
    if (wait <= 0) return this.writeNow();
    if (!this.pending) {
      this.pending = setTimeout(() => this.writeNow(), wait);
      this.pending.unref?.();
    }
  }

  private writeNow() {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    const now = this.now();
    this.status.updatedAt = new Date(now).toISOString();
    this.lastWriteAt = now;
    try {
      this.write(this.path, { ...this.status });
    } catch (error) {
      this.onError(error);
    }
  }
}

export function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A status older than this means the companion that wrote it is gone. */
export const STALE_STATUS_MS = 10_000;

/**
 * The other companion that is still running according to `raw` status.json
 * content, or null when it is safe to start.
 */
export function runningInstance(
  raw: unknown,
  options: {
    now: number;
    selfPid: number;
    isAlive: (pid: number) => boolean;
  },
): CompanionStatus | null {
  const parsed = companionStatusSchema.safeParse(raw);
  if (!parsed.success) return null;
  const status = parsed.data;
  if (status.state === "stopped" || status.pid === options.selfPid) return null;
  const age = options.now - Date.parse(status.updatedAt);
  if (!(age < STALE_STATUS_MS)) return null;
  return options.isAlive(status.pid) ? status : null;
}
