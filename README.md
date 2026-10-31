# THE LISBON WAY

A game of [THE WALL ARCADE](https://6972mvu4.srstudio.dev/), the arcade played on the names of a real wall in Lisbon
(ON THE WALL by NFC Summit). By osaykancuno (K4NCUN0 on the wall).

You drive Lisbon's yellow tram through a grid of streets seen from above. It never stops. The people of the wall wait in
the streets: drive into them and they hook on as a new carriage, their face at the window and the colour of their stop
along the side. Drive onto a stop and **everyone of that colour gets off at once**.

## Controls

| | Keyboard | Phone / mouse |
| --- | --- | --- |
| Turn | ← ↑ → ↓ or W A S D | swipe that way, or tap on the side of the tram you want to turn to |

Two quick turns make a U-turn. The tram never goes straight back on itself.

## Rules

- **Pick up**: drive into someone (16 carriages at most).
- **Drop off**: drive onto the stop of their colour (BELÉM, ESTRELA, GRAÇA, ALFAMA, BAIXA). Riders dropped together pay
  more: each pays 100 × the number dropped together (one alone 100, two 2 × 200, three 3 × 300…). ★ Golden passengers
  (from 0:30) pay 300 instead of 100.
- **Do not crash**: the houses, the river, the edge of the town, roadworks (from 0:45) and your own carriages. A crash
  costs 20 per rider aboard, they all get off, and the tram starts again from the depot after a second.
- People who wait too long walk away (no penalty, but no fare).
- 3 s countdown, then a **fixed 90 s shift** that gets harder all along: the tram goes from a cell every 0.3 s to one
  every 0.2 s, more people wait at once (3 → 7) and they wait less (22 s → 12 s).
- A shift with no crash and 5 riders or more pays **+1000**.
- Competitive by design: a test plays 9 shifts with three bots. Median scores: a tram wandering at random 0, a greedy
  driver about 5 200, a driver who collects one colour before dropping about 7 400.
- The end card gives you a driver title (CHAIN LEGEND, SMOOTH OPERATOR, TRAM 28 HERO, DEMOLITION TRAM…), the people of the
  wall you drove and their stops; POST ON X tags them. This device's best score is kept locally (display only).

Players sign in with SuperRare Connect and spend 1 credit per shift; the score is computed by SuperRare's server from the
game's own rules (`src/games/the-lisbon-way/core.ts`, the very module the verifier runs). Practice is free, local and
unrecorded.

**Every device, as a web app.** A 2D canvas, keyboard, touch and mouse, portrait layout scaled to any screen, a web app
manifest with home-screen icons (Add to Home Screen, full screen).

> A Remix The Wall experiment · NFC Summit 2027 · Lisbon — https://onthewall.nfcsummit.com

## Publish (Windows)

Double-click `PUBBLICA.cmd`. The first time it installs what is missing, logs in to SuperRare Studio, creates the app
once (`deploy/the-lisbon-way.config.json`), then builds and publishes; every later run updates the same app. Details in
[docs/the-lisbon-way.md](docs/the-lisbon-way.md) (Italian).

Elsewhere (Node.js 22+, `npm install --global @rareprotocol/rare-profile@0.1.0`, `rare-profile login`):

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build -- --config deploy/the-lisbon-way.config.json --output dist/the-lisbon-way.zip --force
rare-profile app update <app-id> --zip dist/the-lisbon-way.zip --max-attempts 10000 --json
```

Walk the whole page locally with a fake Connect (no wallet, no payment): `node --import tsx scripts/dev-flow.ts
dist/dev-the-lisbon-way`, then `node --import tsx scripts/dev-serve.ts dist/dev-the-lisbon-way` and open
https://127.0.0.1:8443/.

## Where things are

| Part | Files |
| --- | --- |
| The map (the grid, the houses, the river, the five stops, the depot) | `src/games/the-lisbon-way/map.ts` |
| Rules (deterministic engine, shared by the page and the verifier) | `src/games/the-lisbon-way/core.ts` |
| Page schemas (the verifier's own checks) | `src/games/the-lisbon-way/engine.ts` |
| Controls (keys, swipes, taps → a turn) | `src/games/the-lisbon-way/controls.ts` |
| Client: the town, the tram, the people, HUD, hints, sounds, end card | `src/games/the-lisbon-way/client.ts` |
| Server verifier (`POST /v1`, no schema library) | `src/verifiers/the-lisbon-way.ts` |
| Tests: map, rules, crashes, ramp, forged inputs, tampered states, skill, the built verifier, the web app | `tests/the-lisbon-way.test.ts` |
| Tests of the controls; of the paid start with this game plugged in | `tests/the-lisbon-way-controls.test.ts`, `tests/paid-round.test.ts` |
| Publishing | `PUBBLICA.cmd`, `PUBBLICA.ps1`, `scripts/the-lisbon-way-config.ts` |
| Thumbnails and the texts to paste in the submit form | `docs/listing/` |

The game's inputs are `{ "action": "turn", "dir": 0 | 1 | 2 | 3 }` (up, right, down, left: applied at the tram's next
step, two at most queued) and `{ "action": "start" }`: never a score, a time or a state. A turn straight back, the same
way twice, before the start or after the end, or malformed, changes nothing.

The rest (sign-in, credits, paid start, weekly leaderboard, Practice, the people of the wall's sprites) is
[THE WALL ARCADE's code](https://github.com/hs7j4yk4sz-boop/wall-arcade-connect), itself built on SuperRare's
[studio-games-example](https://github.com/superrare/studio-games-example): see `LICENSE` and `NOTICE` (MIT).

Perfectly legal automated inputs are accepted by these rules: the game is not bot-proof.
