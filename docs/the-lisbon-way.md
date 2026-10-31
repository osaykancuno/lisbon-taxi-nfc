# THE LISBON WAY

Un gioco di THE WALL ARCADE. Guidi il tram giallo di Lisbona su una griglia di strade vista dall'alto. Non si ferma mai.
Le persone del muro aspettano per strada: ci passi sopra e si agganciano come una nuova carrozza, con la faccia al
finestrino e il colore della loro fermata sul fianco. Passi sopra una fermata e **scendono tutti quelli di quel colore
insieme**.

## Comandi

| | Tastiera | Telefono / mouse |
| --- | --- | --- |
| Gira | ← ↑ → ↓ oppure W A S D | swipe in quella direzione, o tocco sul lato del tram verso cui vuoi girare |

Due curve veloci fanno un'inversione a U. Il tram non torna mai indietro su se stesso.

## Regole

- **Carica**: passa sopra una persona (16 carrozze al massimo).
- **Fai scendere**: passa sulla fermata del loro colore (BELÉM, ESTRELA, GRAÇA, ALFAMA, BAIXA). Chi scende insieme vale di
  più: ognuno paga 100 × il numero di quelli scesi insieme (uno 100, due 2 × 200, tre 3 × 300…). ★ I passeggeri d'oro
  (dal 30° secondo) pagano 300 invece di 100.
- **Non sbattere**: contro case, fiume, bordo della città, cantieri (dal 45° secondo) e le tue carrozze. Uno scontro
  costa 20 per passeggero a bordo, scendono tutti e il tram riparte dal deposito dopo un secondo.
- Chi aspetta troppo se ne va (nessuna penalità, ma niente corsa).
- 3 s di countdown, poi **90 s fissi** sempre più veloci man mano che si avvicina la fine: una casella ogni 0,3 s fino al
  45° secondo, poi 0,25 s, 0,2 s dal 64° e 0,15 s negli ultimi 12 s (il doppio della velocità iniziale). Più persone
  aspettano insieme (3 → 7) e aspettano meno (22 s → 12 s).
- **FINAL RUSH**: negli ultimi 15 s ogni corsa vale doppio.
- Un turno senza scontri e con almeno 5 passeggeri portati vale **+1000**.
- Competitivo: un test gioca 9 turni con tre bot. Punteggi mediani: tram che gira a caso 0, guidatore avido circa 5.200,
  guidatore che raccoglie un colore prima di farlo scendere circa 11.100.
- La card finale dà un titolo, le persone del muro che hai portato e le loro fermate; POST ON X le tagga. Il record di
  questo dispositivo resta in locale (solo grafica).

**Su ogni dispositivo, come webapp.** Canvas 2D, tastiera, tocco e mouse, verticale, scala a ogni schermo; manifest e
icone per "Aggiungi alla schermata Home". Pratica gratuita con le stesse regole nel browser, niente registrato.

## Pubblicare da Windows

Doppio clic su `PUBBLICA.cmd` (la prima volta e ogni volta che il gioco cambia). Fa tutto `PUBBLICA.ps1`: controlla
Node.js, installa la riga di comando di SuperRare e le dipendenze, aggiorna i nomi del muro, lancia i test, fa il login
se serve, crea l'app una volta sola (la risposta resta in `deploy/the-lisbon-way.app.json`, la config in
`deploy/the-lisbon-way.config.json`), costruisce lo ZIP e aggiorna la stessa app; alla fine stampa i dati per il modulo
di invio e apre il gioco e la pagina di invio.

## Dove sta

| Parte | File |
| --- | --- |
| La mappa (griglia, case, fiume, cinque fermate, deposito) | `src/games/the-lisbon-way/map.ts` |
| Regole deterministiche (lo stesso modulo nel browser e nel verificatore) | `src/games/the-lisbon-way/core.ts` |
| Schemi della pagina (sono i controlli di `core.ts`) | `src/games/the-lisbon-way/engine.ts` |
| Comandi (tasti, swipe, tocchi → una curva) | `src/games/the-lisbon-way/controls.ts` |
| Client: città, tram, persone, HUD, suggerimenti, suoni, card finale | `src/games/the-lisbon-way/client.ts` |
| Verificatore (`POST /v1`, senza zod) | `src/verifiers/the-lisbon-way.ts` |
| Config pubblica, scritta dallo script | `deploy/the-lisbon-way.config.json`, `scripts/the-lisbon-way-config.ts` |
| Test | `tests/the-lisbon-way.test.ts`, `tests/the-lisbon-way-controls.test.ts`, `tests/paid-round.test.ts` |

Gli input di gioco sono `{ "action": "turn", "dir": 0 | 1 | 2 | 3 }` (su, destra, giù, sinistra: vale al passo
successivo del tram, al massimo due in coda) e `{ "action": "start" }`: mai un punteggio, un tempo o uno stato. I nomi
vengono dallo snapshot del muro incluso nella build (`src/generated/wall.json`, aggiornabile con
`node --import tsx scripts/snapshot-wall.ts`); gli sprite da people.json, solo grafica.

Input automatici perfettamente legali sono accettati da queste regole: il gioco non è a prova di bot.
