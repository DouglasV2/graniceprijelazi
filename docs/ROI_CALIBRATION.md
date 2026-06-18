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

### Prioritet 2 — direkcijske HAK kamere bez ROI-a (poligon ih čini lane-točnima)
| Prijelaz | Kamere |
|---|---|
| Bijača | `bij-hak-ulaz-hr` (toHr), `bij-hak-izlaz-hr` (toBih) |
| Brod | `bro-hak-sb-ulaz-hr` (toHr), `bro-hak-sb-izlaz-hr` (toBih), `bro-hak-bb-ulaz-hr` (toHr), `bro-hak-bb-izlaz-hr` (toBih) |
| Crveni Grm | `cg-hak-bih` (toBih) |
| Izačić | `iza-hak-bih` |

### Prioritet 3 — jednosmjerne/višeslikovne HAK stranice (provjeri smjer u editoru pri crtanju)
`ora-hak-bih`, `sam-hak`, `svi-hak`, `kam-hak`, `pri-hak-arzano`, `pri-hak-bih`, `vd-hak`, `vg-hak`,
`gra-hak-page`

### Preskoči / zasebno provjeri
- `ora-hak-zupanja` — kamera djeluje offline (provjeri prvo da uopće daje sliku).
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
