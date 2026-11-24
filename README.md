# Rekap recorder

The code that runs on a player's PC for [Rekap](https://rekap.gg), a post-game review tool for League of Legends. It is public so that anyone can check what Rekap records and what leaves the player's computer.

> **Status: preparation.** This repository holds the [data contract](docs/data-contract.md) (draft 0.2) and the recorder as it runs today. Until the move is complete, Rekap's private repository is the source and this copy follows it file for file. The Windows app that testers install is built from the private repository. With the player's agreement it sends data from the PC, and the code that sends is not in this repository yet: what the app sends today is listed on [What we record](https://rekap.gg/what-we-record).

## What the recorder does

- Records only **Solo/Duo, Flex and Draft** games. The queue is read from the official League Client API.
- Runs **after you press Play and stops when the game ends**. Nothing is shown in the game, nothing is injected and the game's memory is never read.
- Reads game data from Riot's official **Live Client Data API** (the local endpoint the game exposes).
- Captures the game screen with **Windows Desktop Duplication**, without sound.
- The review itself happens **after the game**.

## What may leave the PC

Only what the [data contract](docs/data-contract.md) lists, and only after the player has agreed once. There is no question after each game. The contract is a draft, written before the sending code moves here; where it differs from [What we record](https://rekap.gg/what-we-record), that page says what the installed app does today.

What may be sent from a live game: the game's description (each slot's champion, team and position, with no names), the game second by second (the player's own gold, health and resource; every player's level, K/D/A, CS, ward score and items; game events), the clock that lines the video up with the game, and a **masked video** at one frame per second where everything is black except the top counters, the ally portraits, the minimap and the player's own HUD. Player names are replaced by slots P1 to P10 on the PC, before anything is sent.

What never leaves the PC:
- the full-screen video;
- sound;
- other windows and notifications;
- `.rofl` replay files;
- players' Riot IDs and names, including the player's own;
- the experimental light analysis track (`screen.analysis.mkv`), which is only read on the PC.

### Where it goes, and how to stop it

Where what is sent is stored today, for how long and with which processors is in [What we record](https://rekap.gg/what-we-record) and the [privacy policy](https://rekap.gg/privacy). The plan is Rekap's own servers in the European Union. A permanent setting turns uploading off at any time; the player can list everything that was sent and delete it. Signing in links an upload to the player's account; no name in the files does.

## What is not here

Rekap's servers, analysis, models and training data stay private. What happens to uploaded data on the server side is described in Rekap's [privacy policy](https://rekap.gg/privacy), not proven by this code.

## Layout

| Path | Contents |
| --- | --- |
| `packages/contract` | The data contract as code: recording format and upload manifest, with tests. |
| `docs/data-contract.md` | The same contract, written for people. |
| `packages/recorder` | The recorder, at the same paths as in Rekap. Live games (`src/lib/companion`): League queue filter (Solo/Duo, Flex, Draft), Live Client Data API polling, screen capture with ffmpeg and Desktop Duplication, minimap location, session folders; it only records, and what happens after a game is passed in from outside (`post-game.ts`). Own replays (`scripts/replay/own-replay.ts`): records one of the player's past games from League's replay viewer under their team's fog of war. |

Planned: cropping on the PC, `packages/uploader` (sends manifest entries only), `apps/desktop` (Windows app). Releases will be built and signed by this repository's CI, with published checksums, so the installed app can be compared with the code.

## Development

```bash
npm ci
npm test
npm run typecheck
```

Node.js 22 or later.

## Riot Games

Rekap isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

## Licence

[Apache License 2.0](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
