# THE LISBON WAY

A game of [THE WALL ARCADE](https://6972mvu4.srstudio.dev/), the arcade played on the names of a real wall in Lisbon
(ON THE WALL by NFC Summit). By osaykancuno (K4NCUN0 on the wall).

You drive a black-and-green taxi through Lisbon, seen from above in 3D: 14 places from Belém to the NFC Summit, the
Tagus and its red bridge, terracotta roofs, a yellow tram, and hills. Three rules: **pick up** the people of the wall,
**drive them** where their tag says, **be quick**.

## Controls

| | Keyboard | Phone / mouse |
| --- | --- | --- |
| Turn at the next corner | ← ↑ → ↓ or W A S D | swipe that way, or tap towards it from the taxi |
| Turbo | Space (or Shift, Enter) | the TURBO button |

The taxi takes the street that points the closest to your direction at the **next corner** (chevrons there show the
ways, blue the one it will take, red a jam). With no new direction it goes straight on where a street continues straight,
and waits at a T-junction ("PICK A WAY").

## Rules

| Request | Tag | Pays |
| --- | --- | --- |
| Ride | the destination's colour | 100 + 15 per street + a tip for speed |
| ⚡ Express (from 0:15) | yellow border | 200, less time |
| ★ Golden passenger (from 0:30) | gold border, shines | 300, little patience |
| + Tour (from 0:45) | `+` | 160, must stop at its FIRST place before the destination |

- **Hills.** Every place has a height (the river 0, Graça 4): uphill streets are slow, downhill streets fast (−6/+6 units
  per tick per level, on a base of 44). The shortest way is not always the fastest.
- **Turbo.** One charge at the start, one more per delivery, two at most: ×1.7 for 2 s. When to spend it is yours.
- **Shared rides.** Riders dropped at the same place together pay ×1.5 each: pick up people going the same way.
- Three seats. Drive through a place to pick people up, through their destination to drop them off.
- 3 s countdown, then a **fixed 90 s shift** that gets busier all along: fares every 3.2 s → 1.3 s, patience 23 s → 13 s,
  rides with less slack, traffic jams every 13 s → 2.5 s (a quarter of the speed), new requests by wave.
- Deliveries in a row multiply fares (×2 from the 3rd, ×4 at most). Someone kept waiting gives up (−50), someone
  kept in the taxi too long jumps out (−100); both reset the combo. The score never goes below 0.
- End of a good shift: with 5 deliveries or more, satisfaction (delivered / delivered + lost) ≥ 90 % pays **+2500**,
  ≥ 75 % +1200, ≥ 50 % +500.
- Competitive by design: a test plays 9 shifts with three bots. Median scores: a taxi wandering at random 0, a greedy
  driver about 3 300, a planning driver about 4 500, and none earns the top bonus on most shifts.
- The end card gives you a driver title (LEGEND OF LISBON, MASTER OF THE HILLS, THE ESCAPE ARTIST, LOST IN ALFAMA…),
  the names you drove and where; POST ON X tags them. This device's best score is kept locally (display only).

Players sign in with SuperRare Connect and spend 1 credit per shift; the score is computed by SuperRare's server from the
game's own rules (`src/games/the-lisbon-way/core.ts`, the very module the verifier runs). Practice is free, local and
unrecorded.

**Every device, as a web app.** The 3D view uses three.js (WebGL2); without WebGL2, after a lost context or on a device
too slow for it, the page draws the same game on a flat map (also a choice: the View button). Keyboard, touch and mouse,
portrait layout scaled to any screen, a web app manifest with home-screen icons (Add to Home Screen, full screen).

> A Remix The Wall experiment · NFC Summit 2027 · Lisbon — https://onthewall.nfcsummit.com

## Publish (Windows)

Double-click `PUBBLICA.cmd`. The first time it installs what is missing, logs in to SuperRare Studio, creates the app
once (`deploy/the-lisbon-way.config.json`), then builds and publishes; every later run updates the same app. Details in
[docs/the-lisbon-way.md](docs/the-lisbon-way.md) (Italian).

Elsewhere (Node.js 22+, `npm install --global @rareprotocol/rare-profile@0.1.0`, `rare-profile login`):

```sh
npm ci
npm run typecheck
npm test
npm run build -- --config deploy/the-lisbon-way.config.json --output dist/the-lisbon-way.zip --force
rare-profile app update <app-id> --zip dist/the-lisbon-way.zip --max-attempts 10000 --json
```

Walk the whole page locally with a fake Connect (no wallet, no payment): `node --import tsx scripts/dev-flow.ts
dist/dev-the-lisbon-way the-lisbon-way`, then `node --import tsx scripts/dev-serve.ts dist/dev-the-lisbon-way` and open
https://127.0.0.1:8443/.

## Where things are

| Part | Files |
| --- | --- |
| The map (places, heights, streets, lengths, shortest paths), shared by the rules and the page | `src/games/the-lisbon-way/map.ts` |
| Rules (deterministic engine, shared by the page and the verifier) | `src/games/the-lisbon-way/core.ts` |
| Page schemas (the verifier's own checks) | `src/games/the-lisbon-way/engine.ts` |
| Controls (keys, swipes, taps → the street at the next corner) | `src/games/the-lisbon-way/controls.ts` |
| Client: HUD, seats, hints, bubbles, 2D map, end card, music | `src/games/the-lisbon-way/client.ts` |
| The 3D map seen from above (three.js, display only) | `src/games/the-lisbon-way/scene3d.ts` |
| Server verifier (`POST /v1`, no schema library) | `src/verifiers/the-lisbon-way.ts` |
| Tests: map, rules, hills, turbo, shared rides, ramp, penalties, forged inputs, tampered states, skill, the built verifier, the web app | `tests/the-lisbon-way.test.ts` |
| Tests of the controls | `tests/the-lisbon-way-controls.test.ts` |
| Publishing | `PUBBLICA.cmd`, `PUBBLICA.ps1`, `scripts/the-lisbon-way-config.ts` |

The game's inputs are `{ "action": "route", "path": [places] }` (the page sends one place: the street to take at the next
corner; the rules accept up to 8, each one street from the one before, starting from the place the taxi is at or
driving to), `{ "action": "boost" }` and `{ "action": "start" }`: never a score, a time or a state.

The rest (sign-in, credits, paid start, weekly leaderboard, Practice, the people of the wall's sprites) is
[THE WALL ARCADE's code](https://github.com/hs7j4yk4sz-boop/wall-arcade-connect), itself built on SuperRare's
[studio-games-example](https://github.com/superrare/studio-games-example): see `LICENSE` and `NOTICE` (MIT).

Perfectly legal automated inputs are accepted by these rules: the game is not bot-proof.
