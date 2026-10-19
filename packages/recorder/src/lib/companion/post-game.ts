// What the companion does with a finished game besides recording it. The
// recorder (capture, Live Client polling, session folders) is the part meant
// to become public (doc/tasks/open-recorder.md); the local review, the Riot
// match download and the minimap analysis stay private and are passed in here
// by scripts/companion/companion.ts. Without hooks the companion only records.
import type { Stopper } from "../live/session";
import type { LiveSample } from "../live/types";

type Log = (message: string) => void;

/** Runs one folder at a time; MapAnalysisRunner is the private one. */
export type FolderRunner = {
  readonly available: boolean;
  readonly current: string | null;
  run(dir: string): Promise<{ code: number | null; interrupted: boolean; error?: string }>;
  interrupt(): void;
};

export type PostGame = {
  /** Writes the local review next to the session; `file` marks it as written. */
  review?: { file: string; write(dir: string, samples: LiveSample[]): void };
  /** Background work once the folder is final, cancelled when the companion stops. */
  afterGame?(game: {
    dir: string;
    gameMode?: string;
    first: LiveSample;
    stopper: Stopper;
    log: Log;
  }): Promise<void>;
  /** Folder analysis queued after each game and on request. */
  analysis?: {
    runner: FolderRunner;
    /** Shown when the runner is unavailable. */
    name: string;
    /** Log file the runner writes in the folder. */
    logName: string;
    /** Folders the web app asked to analyse since the last call. */
    takeRequests(): string[];
  };
};
