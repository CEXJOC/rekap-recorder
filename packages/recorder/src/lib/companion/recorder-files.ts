// The recorder files bound for the public rekap-recorder repository
// (doc/tasks/open-recorder.md), relative to src/lib. recorder-boundary.test.ts
// keeps the companion's imports inside them; scripts/companion/sync-public-recorder.ts
// copies them, their tests and assets into packages/recorder at the same paths.
export const RECORDER_FILES = [
  "companion/analysis-track.ts",
  "companion/capture.ts",
  "companion/clock.ts",
  "companion/companion-lock.ts",
  "companion/companion.ts",
  "companion/control.ts",
  "companion/encoder.ts",
  "companion/ffmpeg-output.ts",
  "companion/game-display.ts",
  "companion/league-client.ts",
  "companion/live-games-only.ts",
  "companion/masked-screen.ts",
  "companion/minimap-area.ts",
  "companion/post-game.ts",
  "companion/process.ts",
  "companion/recorded-queues.ts",
  "companion/recorder-files.ts",
  "companion/screen-fit.ts",
  "companion/segments.ts",
  "companion/state.ts",
  "companion/status.ts",
  "live/account-identity.ts",
  "live/compact.ts",
  "live/session.ts",
  "live/types.ts",
  "map/perception/locate.ts",
  "map/perception/raster.ts",
  "review-queues.ts",
] as const;

/** Non-code files the recorder reads, relative to the repository root. */
export const RECORDER_ASSETS = [
  "src/lib/map/assets/minimap-reference.png",
  "scripts/companion/game-display.ps1",
] as const;

/**
 * The import of one's own replay (scripts/replay/own-replay.ts) and what it
 * reaches, relative to the repository root. The research queue
 * (replay-queue.ts: game choice, fog rotation, sharing) stays private.
 */
export const REPLAY_FILES = [
  "scripts/common/game-files.ts",
  "scripts/dataset/replay.ts",
  "scripts/replay/own-replay.ts",
  "scripts/replay/replay-capture.ts",
  "scripts/replay/replay-client.ts",
  "scripts/replay/replay-cooldown-reader.ts",
  "src/lib/companion/league-client.ts",
  "src/lib/companion/screen-fit.ts",
  "src/lib/map/perception/locate.ts",
  "src/lib/map/perception/raster.ts",
  "src/lib/replay/cooldowns.ts",
  "src/lib/replay/focus.ts",
  "src/lib/replay/fog.ts",
  "src/lib/replay/own-game.ts",
  "src/lib/replay/panel.ts",
  "src/lib/replay/queue-lock-file.ts",
  "src/lib/replay/queue-lock.ts",
  "src/lib/replay/queue.ts",
  "src/lib/replay/replay-display.ts",
  "src/lib/replay/selection.ts",
  "src/lib/riot/patch.ts",
] as const;
