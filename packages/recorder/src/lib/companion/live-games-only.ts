import type { LiveClient } from "../live/session";
/** Both APIs use port 2999; a spectator replay must never start live capture. */
export function liveGamesOnly(
  live: LiveClient,
  replay: LiveClient,
): LiveClient {
  return {
    ...live,
    getJson: async (timeout) => {
      const raw = await live.getJson(timeout);
      if (
        live.url.hostname === "127.0.0.1" &&
        live.url.port === "2999" &&
        (await replay.getJson(500).then(
          () => true,
          () => false,
        ))
      )
        return null;
      return raw;
    },
    close: () => {
      live.close();
      replay.close();
    },
  };
}
