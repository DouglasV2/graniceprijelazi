# ROI kalibracija kamera — worklist + upute

**Cilj:** da `roiTrusted = true` za svaku kameru → YOLO broji **samo traku kolone** (ne cijeli frame) →
procjena postaje lane-točna i ima pravo na visoku pouzdanost.

## Zašto je ovo potrebno (i zašto YOLO sam nije dovoljan)
Bez queue ROI poligona YOLO detektira vozila po **cijelom frameu**, a band se onda računa iz
whole-frame occupancyja (asfalt/rampe/oba smjera → šum). Zato je 86% framova lažno čitalo `srednja`.

- Band-fix (`cvCounted`, commit `772e05f`) je to **već popravio**: kad YOLO stvarno broji, vjeruje se
  niskom broju → nema više lažne "Gužva — prema kameri". Procjena je sad **poštena i count-driven na
  svim kamerama**, srednje pouzdanosti.
- ROI poligon je **nadogradnja**: skalira count na pravu traku → točniji band + otključava `roiTrusted`
  (visoka pouzdanost). `roiTrusted` se NE smije paliti bez ispravnog poligona (inače = samouvjereno
  kriva procjena).

## Kako (po kameri, u editoru — radi se DANJU)
1. Na Railwayu postavi: `YOLO_ROI_EDITOR_ENABLED=true` + `TRAFFIC_VISION_DEBUG_TOKEN=<tajni-token>`
   (ili budi prijavljen kao admin). Editor je inače 404.
2. Otvori `/internal/roi-editor` **danju** (da se vidi stvarna kolona + YOLO kvadratići na slici).
3. Odaberi kameru → nacrtaj poligon **oko trake u kojoj kolona stoji za TAJ smjer**:
   - prati cestu od rampe/granice unatrag (gdje vozila čekaju),
   - NE obuhvati suprotni smjer, parking, ni pozadinsku cestu,
   - uska traka kolone, ne cijeli kadar (poligon >85% kadra se odbija kao "nije queue-ROI").
4. Klikni **Test** → provjeri da broji vozila unutar poligona (insideQueueRoi > 0 kad ima prometa).
5. **Spremi** → konfiguracija postaje `roiTrusted: true` za tu kameru/smjer.

## Worklist (po prioritetu)

### Prioritet 1 — wait-capable kamere (najveći učinak; 3 već imaju seed poligon → samo provjeri/podesi)
| Prijelaz | Kamera | Smjer | Stanje | Akcija |
|---|---|---|---|---|
| Maljevac | `mal-hak-hr-entry` | toHr | seed poligon (needsEditorReview) | provjeri da poligon prati ulaznu traku; spremi |
| Maljevac | `mal-hak-hr-exit` | toBih | seed poligon (needsEditorReview) | isto, izlazna traka |
| Gornji Varoš | `gv-hak-queue-9` | toHr | seed poligon (needsEditorReview) | provjeri/podesi; spremi |
| Gornji Varoš | `gv-hak-plaza-4` | toHr | seed poligon (needsEditorReview) | provjeri/podesi; spremi |
| Gradiška | `gra-rs-in` | toBih | inline laneProfiles, nema editor-poligona | nacrtaj queue poligon; spremi |
| Gradiška | `gra-rs-out` | toHr | inline laneProfiles, nema editor-poligona | nacrtaj queue poligon; spremi |

### Prioritet 2 — status nakon pregleda 2026-06-18 (live danji frameovi)
| Prijelaz | Kamera | Smjer | Stanje |
|---|---|---|---|
| Bijača | `bij-hak-ulaz-hr` | toHr | ✅ reviewed — kolona vidljiva u central. trakama → roiTrusted |
| Bijača | `bij-hak-izlaz-hr` | toBih | ✅ reviewed — kolona u lijevoj dijagonalnoj traci → roiTrusted |
| Brod (SB) | `bro-hak-sb-ulaz-hr` | toHr | ⚠️ flagged poligon (prazne trake; označeni parking isključen) — provjeri u editoru s kolonom |
| Brod (SB) | `bro-hak-sb-izlaz-hr` | toBih | ostavljen rect-derived (frame prazan, nema parkinga za isključiti) |
| Brod (BB) | `bro-hak-bb-ulaz-hr` | **toBih** (ispravljeno) | smjer bio OBRNUT u configu — frame je "Ulaz u BiH". `validForDirections` pinned; ROI tek nakon potvrde uživo |
| Brod (BB) | `bro-hak-bb-izlaz-hr` | **toHr** (ispravljeno) | smjer bio OBRNUT — frame je "Izlaz iz BiH". `validForDirections` pinned |
| Crveni Grm | `cg-hak-bih` | visual-only | ⚠️ flagged poligon (cesta prazna; cestovni parking isključen) |
| Izačić | `iza-hak-bih` | visual-only | ⚠️ flagged poligon (kolona u lijevim trakama; prazne desne isključene) |

**Brod BB smjer-bug (ispravljeno 2026-06-18):** HAK oznake za GP Bosanski Brod (k=184) bile su obrnute u
odnosu na BIHAMK natpis utisnut u sliku — `402.jpg` = "Izlaz iz BiH" (→ toHr), `403.jpg` = "Ulaz u BiH"
(→ toBih). Bez ispravka je kolona u smjeru BiH curila u **HR** prikaz. Pinned `validForDirections` u
`CAMERA_FEEDS` (`server/index.js`). ID sufiksi (`izlaz-hr`/`ulaz-hr`) ostaju legacy/varljivi — ne mijenjaju
se jer su ključevi za ROI/testove.

> "flagged" = poligon postoji i sužava brojanje na traku (manje lažnih "gužva"), ali `needsEditorReview` →
> NIJE `roiTrusted` (nema prava na visoku pouzdanost dok ga operater ne potvrdi nad kadrom s kolonom).

### Prioritet 3 — status nakon pregleda 2026-06-18 (SVE su VISUAL-ONLY → ROI samo čisti vizualni count, ne pokreće smjer/wait)
| Kamera | Stanje |
|---|---|
| `ora-hak-bih` | ⚠️ flagged — TIR kolona u lijevoj traci; otvorene desne trake isključene |
| `kam-hak` | ⚠️ flagged — TIR kolona lijevo; otvoreni centar/desno isključeni (multi-image, primary 317.jpg) |
| `vd-hak` | ⚠️ flagged — toBih kolona u desnoj traci; prazne lijeve isključene (multi-image, primary 302.jpg) |
| `svi-hak` | ⚠️ flagged — kratka toBih kolona lijevo; prazna desna strana isključena |
| `sam-hak` | prazan prilaz + parkirani TIR-ovi (staging) — nije bakeano |
| `pri-hak-arzano` | prazna cesta — nije bakeano |
| `pri-hak-bih` | prazna seoska cesta — nije bakeano |
| `vg-hak` | prazan plato (1 auto u prolazu) — nije bakeano |
| `gra-hak-page` | ⚠️ slika (404.jpg) je zapravo **Bugojno** (~150 km u unutrašnjosti), NE granica Gradiška → nije za queue-ROI; provjeri mapiranje slike |

### Preskoči / zasebno provjeri
- `ora-hak-zupanja` — **NIJE offline** (live, ~5 vozila među čunjevima). Ostavljen bez ROI-a: čunjevi
  prerasporedjuju trake → traka je dvosmislena iz jednog kadra (radije editor uživo).
- BIHAMK iframe izvori (`bij-bihamk-page`, `iza-bihamk`, `kam-bihamk`, `pri-bihamk`, `cg-bihamk`,
  `bro-bihamk`, `ora-amsbih`) — to su **stranice/iframe**, ne direktni frameovi → nisu za queue-ROI
  (ostaju vizualni/tekstualni izvor).

## Nakon kalibracije — što pratiti
- `GET /api/admin/cv-readiness` — po kameri: ima ROI / `roiTrusted` / live count (rollout pregled).
- `GET /api/admin/camera/audit` — wait-capable vs visual-only po kameri/smjeru.
- `GET /api/admin/accuracy` — kako se procjena uči iz stvarnih A→B prelazaka (measured + live lokacija).

## Napomena o pouzdanosti
Čak i s ispravnim ROI-em, **visoka** pouzdanost se daje tek kad kalibracija ima dovoljno stvarnih
prelazaka (≥30 uzoraka, ≥70% unutar 15 min) za taj prijelaz — dotad ostaje srednja s rasponom. ROI
daje točan count; mjereni A→B prelasci ga pretvaraju u točne minute.
