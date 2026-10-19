import type { LivePayload } from "./types";
const normalize = (name: string) => name.trim().normalize("NFC").toLowerCase();
/** Require an explicit complete active Riot ID or a uniquely identified roster member. */
export function matchesRecordingAccount(
  payload: LivePayload,
  expected: string,
) {
  const active = payload.activePlayer;
  const explicit = [active.riotId, active.summonerName].find((name) =>
    name?.includes("#"),
  );
  if (explicit) return normalize(explicit) === normalize(expected);
  const name = active.riotIdGameName ?? active.riotId ?? active.summonerName;
  if (!name) return false;
  const roster = payload.allPlayers.filter((p) =>
    [p.riotIdGameName, p.summonerName, p.riotId?.split("#")[0]].some(
      (n) => n && normalize(n) === normalize(name),
    ),
  );
  if (roster.length !== 1) return false;
  const player = roster[0];
  const id = player.riotId?.includes("#")
    ? player.riotId
    : player.riotIdGameName && player.riotIdTagLine
      ? `${player.riotIdGameName}#${player.riotIdTagLine}`
      : null;
  return id !== null && normalize(id) === normalize(expected);
}
