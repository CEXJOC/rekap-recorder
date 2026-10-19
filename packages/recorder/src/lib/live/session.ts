// Reusable Live Client Data polling loop: waits for a game, records one
// session folder (meta.json + samples.ndjson) and returns when the game ends,
// the client stops answering, or a stop is requested. Used by
// scripts/live/live-recorder.ts and the companion (scripts/companion/companion.ts).
import assert from "node:assert/strict";
import { matchesRecordingAccount } from "./account-identity";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { join, resolve } from "node:path";
import {
  compactSample,
  parsePayload,
  RecorderState,
  sessionDirName,
  stepRecorder,
  stripLongText,
} from "./compact";
import { LiveSample, liveSampleSchema } from "./types";

export const DEFAULT_LIVE_URL =
  "https://127.0.0.1:2999/liveclientdata/allgamedata";
const LOOPBACK = ["127.0.0.1", "localhost"];

export function parseLiveUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("--url must be http(s).");
  if (url.protocol === "http:" && !LOOPBACK.includes(url.hostname))
    throw new Error("Plain http is only allowed for 127.0.0.1 or localhost.");
  return url;
}

export type LiveClient = {
  url: URL;
  getJson(timeoutMs: number): Promise<unknown>;
  close(): void;
};

// The game client serves a self-signed Riot certificate. Verification is only
// relaxed for the local client; any other host keeps normal TLS checks.
function localClientAgent(host: string) {
  assert(LOOPBACK.includes(host), "TLS checks are only relaxed for loopback.");
  return new HttpsAgent({
    keepAlive: true,
    maxSockets: 1,
    rejectUnauthorized: false,
  });
}

/** One keep-alive connection, one request at a time. */
export function createLiveClient(url: URL): LiveClient {
  const https = url.protocol === "https:";
  const agent = !https
    ? new HttpAgent({ keepAlive: true, maxSockets: 1 })
    : LOOPBACK.includes(url.hostname)
      ? localClientAgent(url.hostname)
      : new HttpsAgent({ keepAlive: true, maxSockets: 1 });
  const getJson = (timeoutMs: number) =>
    new Promise<unknown>((done, fail) => {
      const request = (https ? httpsRequest : httpRequest)(
        url,
        { timeout: timeoutMs, headers: { Accept: "application/json" }, agent },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", fail);
          response.on("end", () => {
            if (response.statusCode !== 200)
              return fail(new Error(`HTTP ${response.statusCode}`));
            try {
              done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              fail(new Error("Invalid JSON"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("Timeout")));
      request.on("error", fail);
      request.end();
    });
  return { url, getJson, close: () => agent.destroy() };
}

/** A stop flag whose stop() also wakes any pending sleep(). */
export class Stopper {
  stopped = false;
  private wakers = new Set<() => void>();
  stop() {
    this.stopped = true;
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }
  sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.wakers.delete(finish);
        done();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      this.wakers.add(finish);
    });
  }
}

export type EndReason = "GAME_END" | "CONNECTION_LOST" | "INTERRUPTED";
export type LiveSessionInfo = {
  dir: string;
  name: string;
  champion: string;
  gameMode?: string;
  startedAtMs: number;
};
export type RecordedSession = LiveSessionInfo & {
  samples: LiveSample[];
  reason: EndReason;
};
export type LiveSessionOptions = {
  client: LiveClient;
  interval: number;
  endAfter: number;
  /** Minimum API silence before failure-count termination; 0 keeps CLI behavior. */
  disconnectGraceMs?: number;
  outDir: string;
  label?: string;
  expectedRiotId?: string;
  stopper: Stopper;
  log?: (message: string) => void;
};
export type LiveSessionHooks = {
  /** First valid in-game payload: the folder and meta.json exist. */
  onStart?(info: LiveSessionInfo, first: LiveSample): void;
  /** Every recorded sample, after it was appended to samples.ndjson. */
  onSample?(sample: LiveSample, info: LiveSessionInfo): void;
};

/**
 * Polls until one game has been recorded. Returns null when stopped before a
 * game started. Recording ends on GameEnd, `endAfter` consecutive failed
 * polls after the optional disconnect grace, or `stopper.stop()`.
 */
export async function recordLiveSession(
  options: LiveSessionOptions,
  hooks: LiveSessionHooks = {},
): Promise<RecordedSession | null> {
  const { client, interval, endAfter, stopper } = options;
  const log = options.log ?? console.log;
  let state: RecorderState = { phase: "WAITING" };
  let lastEventId = -1;
  let info: LiveSessionInfo | null = null;
  let samplesFd: number | null = null;
  let lastMinute = -1;
  let lastSampleAt = 0;
  let lastGameTime: number | null = null;
  const failureLimit = () =>
    state.phase === "RECORDING" &&
    Date.now() - lastSampleAt < (options.disconnectGraceMs ?? 0)
      ? Infinity
      : endAfter;
  const samples: LiveSample[] = [];
  try {
    while (state.phase !== "ENDED") {
      const startedAt = Date.now();
      let raw: unknown = null;
      try {
        raw = await client.getJson(Math.max(2000, interval));
      } catch {
        // No game, loading screen or client shutting down.
      }
      if (stopper.stopped) {
        state = stepRecorder(state, { kind: "INTERRUPT" }, endAfter);
        break;
      }
      const payload = raw === null ? null : parsePayload(raw);
      if (!payload)
        state = stepRecorder(state, { kind: "FAILURE" }, failureLimit());
      else {
        const recording = state.phase === "RECORDING";
        const { sample, lastEventId: nextId } = compactSample(
          payload,
          Date.now(),
          recording ? lastEventId : -1,
        );
        if (
          options.expectedRiotId &&
          !matchesRecordingAccount(payload, options.expectedRiotId)
        ) {
          state = stepRecorder(state, { kind: "FAILURE" }, endAfter);
          await stopper.sleep(interval);
          continue;
        }
        // A reconnect must not glue a new game onto the old recording.
        if (
          recording &&
          lastGameTime !== null &&
          sample.gameTime < lastGameTime - 3
        ) {
          state = { phase: "ENDED", reason: "CONNECTION_LOST" };
          break;
        }
        lastSampleAt = Date.now();
        lastGameTime = sample.gameTime;
        const gameEnded = sample.events.some((e) => e.name === "GameEnd");
        const next = stepRecorder(
          state,
          { kind: "SAMPLE", gameEnded },
          endAfter,
        );
        if (!recording && next.phase === "RECORDING") {
          const champion =
            sample.players.find((p) => p.id === sample.active.id)?.champion ??
            "Unknown";
          const name = sessionDirName(sample.t, champion, options.label);
          const dir = resolve(options.outDir, name);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, "meta.json"),
            `${JSON.stringify({ recordedAt: new Date(sample.t).toISOString(), source: client.url.origin, payload: stripLongText(raw) }, null, 2)}\n`,
          );
          samplesFd = openSync(join(dir, "samples.ndjson"), "a");
          info = {
            dir,
            name,
            champion,
            gameMode: payload.gameData.gameMode,
            startedAtMs: sample.t,
          };
          log(`Recording ${champion} into ${dir}`);
          hooks.onStart?.(info, sample);
        }
        if (info && samplesFd !== null && next.phase !== "WAITING") {
          lastEventId = nextId;
          samples.push(sample);
          writeSync(samplesFd, `${JSON.stringify(sample)}\n`);
          hooks.onSample?.(sample, info);
          const minute = Math.floor(sample.gameTime / 60);
          if (minute > lastMinute && minute % 5 === 0)
            log(
              `  recording… game clock ${minute}:00, ${samples.length} samples`,
            );
          lastMinute = minute;
        }
        state = next;
      }
      if (state.phase !== "ENDED")
        await stopper.sleep(Math.max(0, interval - (Date.now() - startedAt)));
    }
  } finally {
    if (samplesFd !== null) closeSync(samplesFd);
  }
  if (!info) return null;
  return {
    ...info,
    samples,
    reason: state.phase === "ENDED" ? state.reason : "INTERRUPTED",
  };
}

export function endMessage(reason: EndReason, endAfter: number) {
  return {
    GAME_END: "Game ended.",
    CONNECTION_LOST: `The game stopped answering ${endAfter} times in a row; finishing the recording.`,
    INTERRUPTED: "Recording stopped.",
  }[reason];
}

/** Reads samples.ndjson, skipping lines cut off by a crash. */
export function readSamples(dir: string): {
  samples: LiveSample[];
  skipped: number;
} {
  let skipped = 0;
  const samples = readFileSync(join(dir, "samples.ndjson"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const parsed = liveSampleSchema.safeParse(JSON.parse(line));
        if (parsed.success) return [parsed.data];
      } catch {
        // A line cut off when the recorder was killed.
      }
      skipped++;
      return [];
    });
  return { samples, skipped };
}
