// Companion lifecycle, as a pure reducer (side effects live in companion.ts):
//
//   waiting ──game starts──▶ recording ──game ends / stop──▶ finalizing
//      ▲                                                        │
//      └──── done ◀── analyzing (minimap, optional) ◀───────────┘
//
// Recording is the foreground state. One economical analysis worker may
// continue alongside it. A stop request finishes the current step.
import { CompanionState } from "./status";

export type Machine = {
  state: CompanionState;
  /** A stop was requested (Ctrl+C or control.json). */
  stopping: boolean;
  /** The stop request asked for minimap analysis before exiting. */
  analyzeOnStop: boolean;
};

export type CompanionEvent =
  | { type: "GAME_STARTED" }
  | { type: "GAME_ENDED" }
  | { type: "ANALYSIS_REQUESTED" }
  | { type: "FINALIZED"; analyze: boolean }
  | { type: "ANALYSIS_FINISHED"; more: boolean }
  | { type: "STOP_REQUESTED"; analyze: boolean };

export const initialMachine = (): Machine => ({
  state: "waiting",
  stopping: false,
  analyzeOnStop: false,
});

const idle = (m: Machine): Machine => ({
  ...m,
  state: m.stopping ? "stopped" : "waiting",
});

export function transition(m: Machine, event: CompanionEvent): Machine {
  if (m.state === "stopped") return m;
  switch (event.type) {
    case "ANALYSIS_REQUESTED":
      return !m.stopping && m.state === "waiting" ? {...m, state:"analyzing"} : m;
    case "GAME_STARTED":
      return !m.stopping && (m.state === "waiting" || m.state === "analyzing")
        ? { ...m, state: "recording" }
        : m;
    case "GAME_ENDED":
      return m.state === "recording" ? { ...m, state: "finalizing" } : m;
    case "FINALIZED":
      if (m.state !== "finalizing") return m;
      return event.analyze ? { ...m, state: "analyzing" } : idle(m);
    case "ANALYSIS_FINISHED":
      if (m.state !== "analyzing") return m;
      return event.more ? m : idle(m);
    case "STOP_REQUESTED": {
      const next = {
        ...m,
        stopping: true,
        analyzeOnStop: m.analyzeOnStop || event.analyze,
      };
      if (m.state === "waiting") return { ...next, state: "stopped" };
      if (m.state === "analyzing" && !next.analyzeOnStop)
        return { ...next, state: "stopped" };
      return next; // recording/finalizing finish first
    }
  }
}

/** Whether a finished session should go to minimap analysis. */
export function shouldAnalyze(
  m: Machine,
  options: { mapEnabled: boolean; scriptExists: boolean; hasVideo: boolean },
) {
  return (
    options.mapEnabled &&
    options.scriptExists &&
    options.hasVideo && // the analysis reads the minimap from the video
    (!m.stopping || m.analyzeOnStop)
  );
}

/** Background work is allowed during recording, but a plain stop cancels it. */
export const analysisCanContinue = (m: Machine) =>
  !m.stopping || m.analyzeOnStop;
