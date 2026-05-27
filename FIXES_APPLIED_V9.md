# V9 route calibration – stvarne OSM koordinate za Brod, Bijaču i Orašje

Zašto V8 nije popravio rute za Brod, Bijaču i Orašje:

- V8 je dodao `routeGuard` i anchore za ova tri prijelaza, ali su koordinate bile grube pretpostavke.
- Nijedna od `approachStart` / `borderPoint` / `exitPoint` točaka nije ležala na stvarnoj cesti prijelaza, pa je Google Routes API snapao na najbližu cestu (gradsku ulicu ili sporedni put), ne na onu koja prelazi granicu.
- V7/V8 trim logika je nakon toga rezala polyline oko tog krivog `borderPoint`-a, pa se na karti prikazao kratki komad krive ceste umjesto stvarnog mosta/prijelaza.

Što je promijenjeno u V9:

- **GP Bijača**: anchori prebačeni s `~43.08°N, 17.62°E` (~5 km jugoistočno od stvarnog prijelaza, na cesti 6218 kroz Prudsku Dragu) na stvarnu A10/A1 autocestu kroz GP Nova Sela (OSM node 6942922065, `43.12359°N, 17.56060°E`) i GP Bijača (OSM node 2424868070, `43.12323°N, 17.57493°E`). Autocesta ide zapad→istok kroz prijelaz.
- **GP Brod**: longituda prebačena s `~17.99°E` (gdje je Google rutirao kroz Ul. Pavla Štoosa / Luke Botića u Slavonskom Brodu) na stvarnu `18.003°E` gdje je most preko Save. Glavna referentna točka: GP Slavonski Brod customs na `45.15286°N, 18.00341°E`. Most ide sjever→jug.
- **GP Orašje**: latitude prebačene s `45.066–45.083°N` (sve unutar Županje, 2–3 km sjeverno od granice) na stvarni most preko Save kod `45.043°N, 18.703°E`. Glavna referentna točka: GP Županja customs na `45.04339°N, 18.70299°E`. Most ide sjever→jug.
- `displayBeforeMeters` / `displayAfterMeters` prošireni na ~950 / ~1150 m za sva tri tako da prikazani polyline jasno pokriva prilaz + HR carinu + most + BiH carinu, a ne samo 700 m oko jedne točke.
- `routeGuard.passDistanceMeters` postavljen na 700–750 m što daje prostora za sitne snapping nesavršenosti Google Routes API-a kod motorway/mosta.
- Ažurirane su i centralne `lat` / `lng` vrijednosti za `orasje` i `brod` u `addCrossing` pozivu da odgovaraju stvarnoj lokaciji carine.

Izvori za koordinate:

- mapcarta.com (OSM mirror): node 6942922065 (GP Nova Sela), node 2424868070 (GP Bijača), node 78468446 (GP Slavonski Brod).
- yuga.at/granicni_prelazi: precizne GPS koordinate za GP Slavonski Brod (`45.152863, 18.003410`) i GP Županja (`45.04339, 18.70299`).

Provjera:

- `node -c server/index.js`
- `npm run build`
- `npm run check`

Što testirati nakon deploya:

- Mapa za Brod treba pokazati polyline koja stvarno prelazi Savu od Slavonskog Broda na sjeveru prema BiH Brodu na jugu.
- Mapa za Orašje treba pokazati polyline od Županje na sjeveru preko Save prema Orašju na jugu.
- Mapa za Bijaču treba pokazati polyline na A10/A1 autocesti koja ide zapad-istok kroz GP Nova Sela i GP Bijača (ne kroz Prudsku Dragu na cesti 6218).
- Ako se neka ruta odbije s `route guard` errorom, jednostavno povećati `passDistanceMeters` za taj prijelaz na 1000 m — sad su koordinate na pravoj cesti, pa Google bi trebao prolaziti vrlo blizu njih.
