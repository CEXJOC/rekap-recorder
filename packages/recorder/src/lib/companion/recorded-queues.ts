import type { LiveClient } from "../live/session";
import { REVIEW_QUEUES } from "../review-queues";

// Only Solo/Duo, Flex and Draft games are recorded (decided 2026-10-11):
// ARAM, Arena, quickplay, customs and practice are not reviewed.
const RECORDED = new Set<number>(REVIEW_QUEUES.map((queue) => queue.id));

/**
 * Only an explicitly allowed League client queue ID permits recording.
 * Live Client mode/map data cannot identify a supported queue.
 */
export function recordedGame(queueId: number | null) {
  return queueId !== null && RECORDED.has(queueId);
}

/**
 * Hides games of other queues from the recorder: their payloads read as "no
 * game", so no session starts. Unknown queues are retried on each live poll;
 * a known decision is cached until the game stops answering.
 */
export function recordedQueuesOnly(
  live: LiveClient,
  queueId: () => Promise<number | null>,
  log: (line: string) => void = () => {},
): LiveClient {
  let decision: boolean | null = null;
  let waitingLogged = false;
  return {
    ...live,
    getJson: async (timeout) => {
      const raw = await live.getJson(timeout).catch((error) => {
        decision = null;
        waitingLogged = false;
        throw error;
      });
      if (raw === null) {
        decision = null;
        waitingLogged = false;
        return raw;
      }
      if (decision === null) {
        const queue = await queueId().catch(() => null);
        if (queue === null) {
          if (!waitingLogged)
            log("Waiting for the League client queue ID before recording.");
          waitingLogged = true;
          return null;
        }
        decision = recordedGame(queue);
        if (!decision)
          log(
            `Not recording this game: queue ${queue} is not Solo/Duo, Flex or Draft.`,
          );
      }
      return decision ? raw : null;
    },
  };
}
