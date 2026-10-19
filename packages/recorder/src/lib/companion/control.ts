// .data/companion/control.json: how the web UI stops a detached companion on
// Windows, where it cannot send Ctrl+C. Example:
//   {"command":"stop","requestedAt":"2026-10-03T12:00:00.000Z","analyze":true}
import { z } from "zod";

export const controlSchema = z.object({
  command: z.literal("stop"),
  requestedAt: z.string(),
  /** Run minimap analysis on the last session before exiting. */
  analyze: z.boolean().optional(),
});

export type StopRequest = { analyze: boolean; requestedAtMs: number };

/**
 * A stop request written after `sinceMs` (the companion's start), or null for
 * anything else: no file, a half-written file, an unknown command, or a stale
 * request left over from an earlier run.
 */
export function parseStopRequest(
  raw: unknown,
  sinceMs: number,
): StopRequest | null {
  const parsed = controlSchema.safeParse(raw);
  if (!parsed.success) return null;
  const requestedAtMs = Date.parse(parsed.data.requestedAt);
  if (!Number.isFinite(requestedAtMs) || requestedAtMs < sinceMs) return null;
  return { analyze: parsed.data.analyze ?? false, requestedAtMs };
}

/** True for a well-formed request that predates `sinceMs` (safe to delete). */
export function isStaleControl(raw: unknown, sinceMs: number) {
  const parsed = controlSchema.safeParse(raw);
  if (!parsed.success) return false;
  const requestedAtMs = Date.parse(parsed.data.requestedAt);
  return Number.isFinite(requestedAtMs) && requestedAtMs < sinceMs;
}
