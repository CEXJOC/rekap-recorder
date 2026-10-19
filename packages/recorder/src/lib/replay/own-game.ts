import { z } from "zod";
import { comparePatch } from "../riot/patch";
export function replayAnalysisMessage(line: string): string | null {
  const progress = line.match(/analysed (\d+)\/(\d+) frames \((\d+)%\)/);
  return progress ? `Analyse du replay · ${progress[3]} % (${progress[1]} / ${progress[2]} images)` : null;
}
export function replayQueueMessage(line: string): string | null {
  if (line.includes("waiting until the PC is idle")) return "En pause · attends deux minutes sans utiliser le PC pour démarrer ou reprendre.";
  if (line.includes("keys could not reach the replay")) return "Le replay n’a pas pris le focus · attends sans utiliser le PC, nouvel essai…";
  if (line.includes("recording stopped") && line.includes("someone used the PC")) return "Enregistrement en pause · le PC est utilisé. Il reprendra automatiquement au repos.";
  if (line.includes("Opening the replay again")) return "Le replay s’est figé · réouverture et reprise de l’enregistrement…";
  const time = line.match(/: (\d+:\d{2}) of (\d+:\d{2}),/);
  if (time) return `Enregistrement du replay · ${time[1]} / ${time[2]}`;
  if (line.includes("recording 0:00 to")) return "Replay ouvert · enregistrement en cours…";
  if (line.includes("fog of team") && line.includes("selecting")) return "Ouverture du replay · préparation du joueur et du brouillard…";
  if (line === "desktop: encoding tracks") return "Capture terminée · préparation des pistes d’analyse…";
  if (line === "desktop: encoding video") return "Capture terminée · sauvegarde de la vidéo…";
  if (line === "desktop: verifying capture") return "Vidéo sauvegardée · vérification de l’enregistrement…";
  if (line === "desktop: finalizing capture") return "Enregistrement vérifié · finalisation et fermeture du replay…";
  return null;
}
export function isDownloadedReplay(metadata: { state?: string } | null | undefined) {
  return metadata?.state === "watch" || metadata?.state === "watchable";
}
export function assertReplayAccount(currentPuuid: unknown, expectedPuuid: string) {
  if (typeof currentPuuid !== "string" || !currentPuuid.trim())
    throw new Error("Le client LoL n’a pas encore communiqué ton compte. Attends que son accueil soit chargé, puis réessaie.");
  if (currentPuuid !== expectedPuuid)
    throw new Error("Connecte LoL au même compte que Rekap.");
}
/**
 * The League client is signed in to the account Rekap records for. The
 * client may report an internal UUID instead of the account PUUID, so its Riot
 * ID is compared with the one Rekap knows; no Riot API call (and no API
 * key) is needed on the player's PC.
 */
export function assertLocalReplayAccount(
  summoner: { puuid?: string; gameName?: string; tagLine?: string },
  expectedPuuid: string,
  expectedRiotId: string,
) {
  if (summoner.puuid === expectedPuuid) return;
  if (!summoner.gameName?.trim() || !summoner.tagLine?.trim())
    throw new Error("Le client LoL n’a pas encore communiqué ton Riot ID. Attends que son accueil soit chargé, puis réessaie.");
  const riotId = (name: string) => name.trim().toLowerCase();
  if (riotId(`${summoner.gameName}#${summoner.tagLine}`) !== riotId(expectedRiotId))
    throw new Error("Connecte LoL au même compte que Rekap.");
}
const schema = z.object({
  metadata: z.object({ matchId: z.string() }),
  info: z.object({
    gameVersion: z.string(),
    queueId: z.number(),
    gameDuration: z.number(),
    participants: z.array(
      z.object({
        puuid: z.string(),
        participantId: z.number().int().positive(),
        teamId: z.union([z.literal(100), z.literal(200)]),
        championName: z.string(),
      }),
    ),
  }),
});
export function ownReplayPlayer(
  raw: unknown,
  matchId: string,
  puuid: string,
  installed: string,
) {
  const match = schema.parse(raw);
  if (match.metadata.matchId !== matchId)
    throw new Error("La partie reçue ne correspond pas à la demande.");
  const player = match.info.participants.find((p) => p.puuid === puuid);
  if (!player) throw new Error("Cette partie n’appartient pas à ton compte.");
  if (comparePatch(match.info.gameVersion, installed) !== 0)
    throw new Error("Replay expiré : cette partie utilise un autre patch.");
  if (
    ![420, 440, 400].includes(match.info.queueId) ||
    match.info.gameDuration < 900
  )
    throw new Error(
      "Choisis une Solo/Duo, Flex ou Draft d’au moins 15 minutes.",
    );
  return player;
}
export function ownReplayMatches(
  match: unknown,
  source: unknown,
  capture: unknown,
  matchId: string,
  puuid: string,
) {
  const parsed = schema.safeParse(match);
  const s = z
    .object({
      provenance: z.literal("TEAM_FOG_REPLAY"),
      matchId: z.string(),
      puuid: z.string(),
      participantId: z.number(),
      teamId: z.number(),
    })
    .safeParse(source);
  const c = z
    .object({
      version: z.literal("replay-capture-0.1"),
      provenance: z.literal("TEAM_FOG_REPLAY"),
      matchId: z.string(),
      fogTeam: z.number(),
      selectedPlayer: z.object({
        participantId: z.number(),
        teamId: z.number(),
      }),
    })
    .safeParse(capture);
  if (!parsed.success || !s.success || !c.success) return false;
  const p = parsed.data.info.participants.find((p) => p.puuid === puuid);
  return Boolean(
    p &&
    parsed.data.metadata.matchId === matchId &&
    s.data.matchId === matchId &&
    c.data.matchId === matchId &&
    s.data.puuid === puuid &&
    s.data.participantId === p.participantId &&
    c.data.selectedPlayer.participantId === p.participantId &&
    c.data.selectedPlayer.teamId === p.teamId &&
    s.data.teamId === p.teamId &&
    c.data.fogTeam === p.teamId,
  );
}
