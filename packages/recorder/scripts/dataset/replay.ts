import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertLocalReplayAccount } from "../../src/lib/replay/own-game";
import { httpsJson, lcuConnection, lcuRequest } from "../../src/lib/companion/league-client";
export { httpsJson, lcuConnection, lcuRequest };

/** The League client is signed in to the expected account (checked locally, no API key). */
export async function assertCurrentReplayAccount(expectedPuuid: string, expectedRiotId: string) {
  const summoner = await lcuRequest<{puuid?: string; gameName?: string; tagLine?: string}>("/lol-summoner/v1/current-summoner");
  assertLocalReplayAccount(summoner, expectedPuuid, expectedRiotId);
}

type Json = Record<string, unknown>;

/**
 * The Riot Client's own local API, which launches its products. Its lockfile
 * (name:pid:port:password:protocol, like the League client's) is in
 * LOCALAPPDATA while the Riot Client runs, signed in or not.
 */
export async function riotClientRequest<T>(
  apiPath: string,
  method = "GET",
  body?: unknown,
) {
  const lockfilePath = path.join(
    process.env.LOCALAPPDATA ?? "",
    "Riot Games",
    "Riot Client",
    "Config",
    "lockfile",
  );
  let lockfile: string;
  try {
    lockfile = await readFile(lockfilePath, "utf8");
  } catch {
    throw new Error(`Riot Client lockfile not found at ${lockfilePath}: the Riot Client is not running.`);
  }
  const [, , port, password] = lockfile.trim().split(":");
  if (!port || !password) throw new Error(`Invalid Riot Client lockfile: ${lockfilePath}`);
  return httpsJson<T>(Number(port), apiPath, { method, auth: `riot:${password}`, body });
}

export async function replayRequest<T>(
  apiPath: string,
  method = "GET",
  body?: unknown,
) {
  return httpsJson<T>(2999, apiPath, { method, body });
}

export type ReplayMetadata = {
  state?: string;
  downloadProgress?: number;
  gameId?: number;
  gameVersion?: string;
  [key: string]: unknown;
};

export type ReplayRecording = {
  recording?: boolean;
  path?: string;
  codec?: string;
  startTime?: number;
  endTime?: number;
  currentTime?: number;
  [key: string]: unknown;
};

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export type ReplayMetadataSeed = {
  gameVersion: string;
  gameType: string;
  queueId: number;
  gameEnd: number;
};

/**
 * The League client cannot reach Riot's replay service. A replay is in
 * "checking" while the client asks the service about it: about a second on a
 * client that works (EUW1_8007185197, 2026-10-08), then "downloading". A
 * client that lost its sign-in still answers locally as before, but its
 * request fails (LEAGUE_EDGE_CLIENT_AUTH_HEADERS_NOT_AVAILABLE in its log) and
 * every replay stays in "checking": on 2026-10-07 and on 2026-10-09, when the
 * Riot Client had closed. The client's fault, not the game's.
 */
export class ReplayServiceUnreachable extends Error {}

/** How long a replay may stay in "checking" before the client is blamed. */
export const CHECKING_MS = 60_000;
/** How long a replay gets to download (23 s for EUW1_8007185197). */
export const DOWNLOAD_MS = 120_000;
// The states a replay passes through on its way to "watch".
const PASSING = new Set(["checking", "downloading"]);

/** The League client, its replay folder and the clock, for ensureReplayDownloaded; the tests answer for all three. */
export type ReplayClient = {
  request: <T>(apiPath: string, method?: string, body?: unknown) => Promise<T>;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  /** Whether the replay's file is in the client's replay folder. */
  hasFile: (gameId: string) => Promise<boolean>;
};
const LEAGUE_CLIENT: ReplayClient = {
  request: lcuRequest,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hasFile: replayFileExists,
};

/**
 * Whether the client's replay folder holds the game's file
 * (<platform>-<gameId>.rofl). True when the folder cannot be read: the
 * client's own answer is then all there is.
 */
async function replayFileExists(gameId: string) {
  try {
    const folder = await lcuRequest<string>("/lol-replays/v1/rofls/path");
    return (await readdir(folder)).some((name) => name.endsWith(`-${gameId}.rofl`));
  } catch {
    return true;
  }
}

/**
 * Makes a replay watchable: creates the client's metadata when it has none,
 * asks for the download and waits for "watch". Throws ReplayServiceUnreachable
 * when the replay stays in "checking", and an error that says "incompatible"
 * or "not downloadable" when the replay itself cannot be watched.
 *
 * The client goes on answering "watch" for a replay whose file was deleted
 * (the queue deletes it after each recording): opening it then starts nothing,
 * and every second fog pass lost two 90 s waits and one of its attempts
 * (2026-10-12, as on 2026-10-07). Only a request to watch makes the client
 * look for the file: finding none, it opens nothing and sets the replay back
 * to "download". So "watch" counts only with the file there; without it the
 * client is asked to watch, then to download again.
 */
export async function ensureReplayDownloaded(
  gameId: string,
  seed: ReplayMetadataSeed,
  client = LEAGUE_CLIENT,
) {
  const metadataPath = `/lol-replays/v1/metadata/${gameId}`;
  let metadata: ReplayMetadata;

  try {
    metadata = await client.request<ReplayMetadata>(metadataPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("returned 404")) throw error;

    console.log("Replay metadata is missing; creating it from Riot match data...");

    await client.request(`/lol-replays/v2/metadata/${gameId}/create`, "POST", seed);
    metadata = await client.request<ReplayMetadata>(metadataPath);
  }

  const started = client.now();
  let asked = false;
  let lookedAgain = false;
  let checkingSince: number | null = null;
  let lastError: unknown;
  for (;;) {
    const state = String(metadata.state ?? "").toLowerCase();
    // A download this call asked for has just written the file.
    const fileGone = state === "watch" && !asked && !(await client.hasFile(gameId));
    if (state === "watch" && !fileGone) return metadata;
    if (state === "incompatible")
      throw new Error(
        asked
          ? `Replay ${gameId} became incompatible while downloading.`
          : `Replay ${gameId} is incompatible with the installed League patch.`,
      );
    if (state === "checking") {
      checkingSince ??= client.now();
      if (client.now() - checkingSince >= CHECKING_MS)
        throw new ReplayServiceUnreachable(
          `Replay ${gameId} stayed in "checking" for ${CHECKING_MS / 1000} s: the League client cannot reach Riot's replay service (signed out, or the Riot Client closed).`,
        );
    } else checkingSince = null;
    if (fileGone) {
      // Once: with the file gone the request opens nothing, and the state
      // changed within 10 ms of it (EUW1_8011121152, 2026-10-12).
      if (!lookedAgain) {
        console.log(`Replay ${gameId}: its file is gone and the client still says "watch"; asking it to look again...`);
        await client.request(`/lol-replays/v1/rofls/${gameId}/watch`, "POST", {});
        lookedAgain = true;
      }
    } else if (state === "download" && !asked) {
      await client.request(`/lol-replays/v1/rofls/${gameId}/download`, "POST", {});
      asked = true;
    } else if (!asked && !PASSING.has(state))
      throw new Error(
        `Replay ${gameId} is not downloadable/watchable (state: ${state || "unknown"}).`,
      );
    if (client.now() - started >= DOWNLOAD_MS)
      throw new Error(
        `Replay ${gameId} was not downloaded after ${DOWNLOAD_MS / 1000} s (state: ${state || "unknown"}${fileGone ? ", its file missing" : ""}${lastError ? `; last answer: ${(lastError as Error).message}` : ""}).`,
      );
    await client.sleep(1500);
    // A request that fails keeps the last state; the deadline still holds.
    try {
      metadata = await client.request<ReplayMetadata>(metadataPath);
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
}

export async function launchReplay(gameId: string) {
  await lcuRequest(`/lol-replays/v1/rofls/${gameId}/watch`, "POST", {});

  await waitFor(
    async () => {
      const playback = await replayRequest<Json>("/replay/playback");
      return typeof playback === "object" && playback !== null;
    },
    90_000,
    1000,
  );
}
