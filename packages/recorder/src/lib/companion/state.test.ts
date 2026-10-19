import { describe, expect, it } from "vitest";
import {
  analysisCanContinue,
  CompanionEvent,
  initialMachine,
  Machine,
  shouldAnalyze,
  transition,
} from "./state";
it("starts requested analysis from idle without replacing foreground recording",()=>{
  expect(transition(initialMachine(),{type:"ANALYSIS_REQUESTED"}).state).toBe("analyzing");
  const recording={...initialMachine(),state:"recording" as const};
  expect(transition(recording,{type:"ANALYSIS_REQUESTED"})).toBe(recording);
  const stopping={...initialMachine(),stopping:true};
  expect(transition(stopping,{type:"ANALYSIS_REQUESTED"})).toBe(stopping);
});

const run = (events: CompanionEvent[], from = initialMachine()) =>
  events.reduce<Machine[]>(
    (states, event) => [...states, transition(states.at(-1)!, event)],
    [from],
  );
const states = (events: CompanionEvent[], from?: Machine) =>
  run(events, from).map((m) => m.state);
// A session with video, map analysis enabled and its script present.
const ready = { mapEnabled: true, scriptExists: true, hasVideo: true };

describe("companion state machine", () => {
  it("cycles waiting → recording → finalizing → analyzing → waiting", () => {
    expect(
      states([
        { type: "GAME_STARTED" },
        { type: "GAME_ENDED" },
        { type: "FINALIZED", analyze: true },
        { type: "ANALYSIS_FINISHED", more: false },
        { type: "GAME_STARTED" },
      ]),
    ).toEqual([
      "waiting",
      "recording",
      "finalizing",
      "analyzing",
      "waiting",
      "recording",
    ]);
  });

  it("returns to waiting without analysis (--no-map or no script)", () => {
    expect(
      states([
        { type: "GAME_STARTED" },
        { type: "GAME_ENDED" },
        { type: "FINALIZED", analyze: false },
      ]).at(-1),
    ).toBe("waiting");
  });

  it("keeps recording foreground when background analysis finishes", () => {
    const [, , , analyzing, recording, late] = run([
      { type: "GAME_STARTED" },
      { type: "GAME_ENDED" },
      { type: "FINALIZED", analyze: true },
      { type: "GAME_STARTED" },
      { type: "ANALYSIS_FINISHED", more: false }, // background run reports
    ]);
    expect(analyzing.state).toBe("analyzing");
    expect(recording.state).toBe("recording");
    expect(late.state).toBe("recording");
  });

  it("stays analyzing while queued sessions remain", () => {
    expect(
      states([
        { type: "GAME_STARTED" },
        { type: "GAME_ENDED" },
        { type: "FINALIZED", analyze: true },
        { type: "ANALYSIS_FINISHED", more: true },
        { type: "ANALYSIS_FINISHED", more: false },
      ]).slice(-2),
    ).toEqual(["analyzing", "waiting"]);
  });

  it("stops at once when idle", () => {
    expect(states([{ type: "STOP_REQUESTED", analyze: true }])).toEqual([
      "waiting",
      "stopped",
    ]);
  });

  it("finalizes a game in progress before stopping (Ctrl+C)", () => {
    const machines = run([
      { type: "GAME_STARTED" },
      { type: "STOP_REQUESTED", analyze: false },
      { type: "GAME_ENDED" },
    ]);
    expect(machines.map((m) => m.state)).toEqual([
      "waiting",
      "recording",
      "recording",
      "finalizing",
    ]);
    const finalizing = machines.at(-1)!;
    expect(shouldAnalyze(finalizing, ready)).toBe(false);
    expect(
      transition(finalizing, { type: "FINALIZED", analyze: false }).state,
    ).toBe("stopped");
  });

  it("analyzes before exiting when the stop request asks for it", () => {
    const machines = run([
      { type: "GAME_STARTED" },
      { type: "STOP_REQUESTED", analyze: true },
      { type: "GAME_ENDED" },
    ]);
    const finalizing = machines.at(-1)!;
    expect(shouldAnalyze(finalizing, ready)).toBe(true);
    expect(
      states(
        [
          { type: "FINALIZED", analyze: true },
          { type: "ANALYSIS_FINISHED", more: false },
        ],
        finalizing,
      ),
    ).toEqual(["finalizing", "analyzing", "stopped"]);
  });

  it("drops a running analysis on a plain stop, keeps it when asked", () => {
    const analyzing: Machine = {
      state: "analyzing",
      stopping: false,
      analyzeOnStop: false,
    };
    expect(
      transition(analyzing, { type: "STOP_REQUESTED", analyze: false }).state,
    ).toBe("stopped");
    expect(
      transition(analyzing, { type: "STOP_REQUESTED", analyze: true }).state,
    ).toBe("analyzing");
  });

  it("does not start a game while stopping, and stopped is final", () => {
    const stopping: Machine = {
      state: "finalizing",
      stopping: true,
      analyzeOnStop: false,
    };
    expect(transition(stopping, { type: "GAME_STARTED" })).toBe(stopping);
    const stopped: Machine = { ...stopping, state: "stopped" };
    for (const event of [
      { type: "GAME_STARTED" },
      { type: "GAME_ENDED" },
      { type: "FINALIZED", analyze: true },
    ] as CompanionEvent[])
      expect(transition(stopped, event)).toBe(stopped);
  });

  it("ignores events that do not apply", () => {
    const waiting = initialMachine();
    expect(transition(waiting, { type: "GAME_ENDED" })).toBe(waiting);
    expect(transition(waiting, { type: "FINALIZED", analyze: true })).toBe(
      waiting,
    );
  });

  it("analyzes only with video, the script present and --no-map unset", () => {
    const waiting = initialMachine();
    expect(shouldAnalyze(waiting, ready)).toBe(true);
    expect(shouldAnalyze(waiting, { ...ready, scriptExists: false })).toBe(
      false,
    ); // the map script is not written yet
    expect(shouldAnalyze(waiting, { ...ready, mapEnabled: false })).toBe(false);
    expect(shouldAnalyze(waiting, { ...ready, hasVideo: false })).toBe(false);
  });
});

it("allows economical analysis during play and honors stop choices", () => {
  const recording = transition(initialMachine(), { type: "GAME_STARTED" });
  expect(analysisCanContinue(recording)).toBe(true);
  expect(
    analysisCanContinue(
      transition(recording, { type: "STOP_REQUESTED", analyze: false }),
    ),
  ).toBe(false);
  expect(
    analysisCanContinue(
      transition(recording, { type: "STOP_REQUESTED", analyze: true }),
    ),
  ).toBe(true);
});
