# Data contract

Version **0.2.0-draft**. Code: [`packages/contract`](../packages/contract/src/manifest.ts). The two must say the same thing. A change to either is a new version.

## Today

Nothing is uploaded. Recordings stay on the player's PC. This contract describes what the recorder **will be allowed** to send once uploading exists. It is published first so the rules come before the feature.

## Rules

1. The uploader sends only the files listed for the recording's source. The server refuses any other file for the announced contract version.
2. The player agrees once, at sign-up. There is no question after each game, and uploads then happen on their own.
3. A permanent setting turns uploading off. The player can list everything that was sent and delete it.
4. Cropping, masking and pseudonymization happen on the PC, before anything is sent.
5. No player name leaves the PC. The upload is linked to the player's account through sign-in, not through a name in the files.

## Two sources

- **Live**: a game the player plays, recorded from the game screen.
- **Replay**: one of the player's own past games, recorded from League's replay viewer (spectator interface) under the fog of war of the player's team.

## Live games: files that may be sent

| File | Required | Why | What the PC does first |
| --- | --- | --- | --- |
| `game.json` | yes | Which game this is and who played which champion: game mode, map, each slot's champion, team and position, and the player's own slot. | Built from the first Live Client payload. Names, runes and tooltips are left out. |
| `samples.ndjson` | yes | The game second by second: the player's gold, health and resource; for all ten players level, K/D/A, CS, ward score and items; new game events. | Every player name becomes its slot (P1 to P10). A name that is neither a player nor a game object becomes `unknown`. |
| `clock.json` | yes | Lines up the video with the game clock: frame rate, size, time offset and capture gaps. | Only these fields are kept. |
| `masked.mp4` | yes | Positions, vision, health and the player's own state, as the player saw them. | Everything is blacked out except the top counters (score, K/D/A, CS, clock), the ally portraits, the minimap and the player's HUD. |

## Replays: files that may be sent

| File | Required | Why | What the PC does first |
| --- | --- | --- | --- |
| `capture.json` | yes | Which game, which team's fog of war and which player the recording follows, and how the capture was checked. | The followed player's Riot ID is removed. |
| `minimap.mp4` | yes | Positions, waves and vision under the team's fog of war. | Cropped to the minimap. |
| `frames.mp4` | no | Health, resource, spells, ultimate and level of the ten players, from the team frames. | Cropped to the two frame columns, with the name above each portrait blacked out. |
| `top.mp4` | no | Kills, towers, objectives and the game clock. | Cropped to the top bar. |
| `scoreboard.mp4` | no | Items, K/D/A and CS of the ten players. | Cropped to the spectator scoreboard, which shows no names. |
| `player.mp4` | no | The followed player's health, stats, spells and cooldowns. | Cropped to the player's panel. |
| `cooldowns.json` | no | The followed player's spell cooldowns, read from that panel. | None. |

No video has sound. Nothing from the 3D game view is read.

## Files that never leave the PC

| File | Why it stays |
| --- | --- |
| `screen.mp4`, `screen.mkv` | Full-screen video. It can show other windows, notifications and names. It is kept only if the player wants it for their own review. |
| `meta.json` | The first Live Client payload, with every player's Riot ID. `game.json` replaces it. |
| `source.json` | Local folder description, with the player's PUUID. |
| `screen.json`, `screen.recording.json` | Local video details and crash recovery. `clock.json` carries what the server needs. |
| `report.json`, `report.md`, `map.json`, `map-debug.json`, `map-analyze.log` | The local review and analysis. The server computes its own. |
| `match.json`, `timeline.json` | The server gets match data from Riot itself. |
| `.rofl` replay files | Never downloaded, copied or deleted for the player. |

## Still to decide

These will be fixed before uploading is built and published in the privacy policy:
- retention periods for raw tracks and for derived data;
- the hosting region (planned: the European Union);
- the list of processors.
