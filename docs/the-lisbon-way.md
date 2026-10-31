# THE LISBON WAY

Un gioco di THE WALL ARCADE. Guidi un taxi nero e verde per Lisbona, vista dall'alto in 3D: 14 luoghi da Belém al NFC
Summit, il Tejo con il ponte rosso, tetti in cotto, un tram giallo, e le colline. Tre regole: **carica** le persone del
muro, **portale** dove dice la loro etichetta, **fai presto**.

## Comandi

| | Tastiera | Telefono / mouse |
| --- | --- | --- |
| Gira al prossimo incrocio | ← ↑ → ↓ oppure W A S D | swipe in quella direzione, o tocco verso quella direzione dal taxi |
| Turbo | Spazio (o Shift, Invio) | il pulsante TURBO |

Al **prossimo incrocio** il taxi prende la via che punta più vicino alla direzione data (le frecce sull'incrocio mostrano
le vie: blu quella che prenderà, rossa se c'è un ingorgo). Senza una nuova direzione va dritto dove una via continua
dritta, e si ferma a un incrocio a T ("PICK A WAY").

## Regole

| Richiesta | Etichetta | Quanto vale |
| --- | --- | --- |
| Corsa | colore della destinazione | 100 + 15 per via + mancia per la velocità |
| ⚡ Express (dal 15° secondo) | bordo giallo | 200, meno tempo |
| ★ Passeggero d'oro (dal 30°) | bordo oro, brilla | 300, poca pazienza |
| + Tour (dal 45°) | `+` | 160, deve fermarsi PRIMA nel luogo indicato |

- **Colline.** Ogni luogo ha un'altezza (il fiume 0, Graça 4): in salita si va piano, in discesa veloce. La via più
  corta non è sempre la più rapida.
- **Turbo.** Una carica all'inizio, una in più a ogni consegna, due al massimo: ×1,7 per 2 s. Quando usarlo lo decidi tu.
- **Corse condivise.** Passeggeri che scendono insieme nello stesso luogo valgono ×1,5 ciascuno: carica chi va dalla
  stessa parte.
- Tre posti. Passi da un luogo e carichi chi aspetta; passi dalla sua destinazione e scende.
- 3 s di countdown, poi **90 s fissi** sempre più intensi: un passeggero ogni 3,2 s → 1,3 s, pazienza 23 s → 13 s,
  corse con meno margine, ingorghi ogni 13 s → 2,5 s (un quarto della velocità), richieste nuove a ogni ondata.
- Consegne di fila moltiplicano i punti (×2 dalla 3ª, fino a ×4). Chi aspetta troppo se ne va (−50), chi resta in taxi
  troppo salta giù (−100); entrambi azzerano la serie. Il punteggio non scende mai sotto 0.
- Fine turno: con almeno 5 consegne, soddisfazione (consegnati / consegnati + persi) ≥ 90% vale **+2500**, ≥ 75% +1200,
  ≥ 50% +500.
- Competitivo: un test gioca 9 turni con tre bot. Punteggi mediani: taxi che gira a caso 0, guidatore avido circa 3.300,
  guidatore che pianifica circa 4.500; nessuno prende il bonus massimo nella maggior parte dei turni.
- La card finale dà il titolo da tassista, i nomi che hai portato e dove; POST ON X li tagga. Il record di questo
  dispositivo resta in locale (solo grafica).
- Solo grafica: musica che accelera nell'ora di punta, ticchettio degli ultimi 10 s, "JUST IN TIME!", fiammata del turbo,
  fumetti, coriandoli, scosse dello schermo.

**Su ogni dispositivo, come webapp.** La vista 3D usa three.js (WebGL2). Senza WebGL2, se il contesto grafico si perde o
se il dispositivo è troppo lento, la pagina disegna lo stesso gioco su una mappa piatta (scelta possibile anche dal
pulsante View). Tastiera, tocco e mouse, verticale, scala a ogni schermo; manifest e icone per "Aggiungi alla schermata
Home".

Pratica gratuita con le stesse regole nel browser, niente registrato.

## Pubblicare da Windows

Doppio clic su `PUBBLICA.cmd` (la prima volta e ogni volta che il gioco cambia). Fa tutto `PUBBLICA.ps1`: controlla
Node.js, installa la riga di comando di SuperRare e le dipendenze, aggiorna i nomi del muro, lancia i test, fa il login
se serve, crea l'app una volta sola (la risposta resta in `deploy/the-lisbon-way.app.json`, la config in
`deploy/the-lisbon-way.config.json`), costruisce lo ZIP e aggiorna la stessa app; alla fine stampa i dati per il modulo
di invio e apre il gioco e la pagina di invio.

## Dove sta

| Parte | File |
| --- | --- |
| La mappa (luoghi, altezze, vie, lunghezze, percorsi), condivisa da regole e pagina | `src/games/the-lisbon-way/map.ts` |
| Regole deterministiche (lo stesso modulo nel browser e nel verificatore) | `src/games/the-lisbon-way/core.ts` |
| Schemi della pagina (sono i controlli di `core.ts`) | `src/games/the-lisbon-way/engine.ts` |
| Comandi (tasti, swipe, tocchi → la via al prossimo incrocio) | `src/games/the-lisbon-way/controls.ts` |
| Client: HUD, sedili, frecce, fumetti, mappa 2D, card finale, musica | `src/games/the-lisbon-way/client.ts` |
| Vista 3D dall'alto (three.js, solo grafica) | `src/games/the-lisbon-way/scene3d.ts` |
| Verificatore (`POST /v1`, senza zod) | `src/verifiers/the-lisbon-way.ts` |
| Ingresso della pagina | `src/entries/the-lisbon-way.ts` |
| Config pubblica, scritta dallo script | `deploy/the-lisbon-way.config.json`, `scripts/the-lisbon-way-config.ts` |
| Test di regole, colline, turbo, corse condivise, abilità, verificatore compilato, webapp | `tests/the-lisbon-way.test.ts` |
| Test dei comandi | `tests/the-lisbon-way-controls.test.ts` |

Gli input di gioco sono `{ "action": "route", "path": [luoghi] }` (la pagina manda un luogo: la via da prendere al
prossimo incrocio), `{ "action": "boost" }` e `{ "action": "start" }`: mai un punteggio, un tempo o uno stato. Un
percorso non percorribile, un turbo senza cariche, un input prima dell'inizio o dopo la fine, o malformato non cambia
nulla. I nomi vengono dallo snapshot del muro incluso nella build (`src/generated/wall.json`, aggiornabile con
`node --import tsx scripts/snapshot-wall.ts`); gli sprite da people.json, solo grafica.

Input automatici perfettamente legali sono accettati da queste regole: il gioco non è a prova di bot.
