# PrijelazRadar Production Build

Aplikacija za praćenje prometa na HR ↔ BiH graničnim prijelazima: čekanja po smjeru, usporedba ruta, mapa, kamere, dojave vozača, korekcije tima, route search history i export dnevnog izvještaja.

Ova verzija je složena kao pilot spreman za domenu. UI više ne prikazuje konfiguracijske/demo vrijednosti kao stvarno čekanje. Velika brojka za čekanje prikazuje se samo kada postoji admin potvrda, BIHAMK/AMS javni signal, kamera snapshot signal ili svježa dojava. Ako toga nema, prikazuje se **Čeka live izvor** umjesto hardkodirane minute.

## Što je dorađeno

- backend login/register umjesto hardkodirane prijave u browseru
- maknuti demo password shortcuti iz login prikaza
- PBKDF2 hash lozinki i signed session tokeni
- PostgreSQL datastore kada je postavljen `DATABASE_URL`
- JSON fallback u `data/runtime-store.json` za lokalni demo bez baze
- SQL schema i seed template u `sql/`
- server-side spremanje admin korekcija i dojava vozača
- route search history u browseru + server endpoint za ulogirane korisnike
- admin export dnevnog CSV izvještaja
- admin-only endpoint za korekcije čekanja i dnevni report
- audit log za login, korekcije, dojave, route history i export
- health endpoint s production provjerama
- rate limit za auth i write endpointove
- CORS allowlist kroz `.env`
- Google route comparison za sve prijelaze
- Dockerfile i `.dockerignore`
- zaključane verzije dependencyja
- build provjeren s `npm run build`

## Pokretanje lokalno

```bash
npm install
cp .env.example .env.local
npm run dev
```

Frontend: `http://localhost:5173`  
Backend: `http://localhost:5050`

Za lokalni demo možeš koristiti JSON fallback. Za ozbiljniji pilot postavi PostgreSQL `DATABASE_URL` i seedaj admina kroz env varijable ili SQL template.

## PostgreSQL setup

1. Kreiraj bazu i postavi connection string:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/prijelazradar
DATABASE_SSL=false
```

2. Pokreni schemu:

```bash
psql "$DATABASE_URL" -f sql/001_schema.sql
```

3. Kreiraj admina na jedan od tri načina.

Opcija A, gotov lokalni seed koji možeš odmah pokrenuti:

```bash
psql "$DATABASE_URL" -f sql/002_seed_local_admin.sql
```

Lozinka u tom lokalnom seedu je `change-this-admin-password`; promijeni je prije javnog deploya.

Opcija B, automatski seed iz env varijabli pri prvom startu:

```env
BORDERFLOW_ADMIN_EMAIL=admin@tvoja-domena.com
BORDERFLOW_ADMIN_PASSWORD=jaka-admin-lozinka
```

Opcija C, ručni SQL seed s vlastitom lozinkom:

```bash
node scripts/create-password-hash.mjs "jaka-admin-lozinka"
# kopiraj hash u sql/002_seed_admin_template.sql
psql "$DATABASE_URL" -f sql/002_seed_admin_template.sql
```

Ako `DATABASE_URL` nije postavljen, aplikacija automatski koristi `data/runtime-store.json`.

## Production env

Minimalno postaviti:

```env
NODE_ENV=production
PORT=5050
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/prijelazradar
DATABASE_SSL=false
SESSION_SECRET=dug-random-string
BORDERFLOW_ADMIN_EMAIL=admin@tvoja-domena.com
BORDERFLOW_ADMIN_PASSWORD=jaka-lozinka
GOOGLE_MAPS_SERVER_KEY=server-routes-key
VITE_GOOGLE_MAPS_API_KEY=browser-maps-key
CORS_ORIGINS=https://tvoja-domena.com
```

Google key setup:

1. Browser key: Maps JavaScript API, ograničiti na produkcijsku domenu.
2. Server key: Routes API, držati samo na backendu.
3. Ako je frontend na drugoj domeni, postaviti `VITE_API_BASE_URL` i `CORS_ORIGINS`.

## Naredbe

```bash
npm run dev          # frontend + backend
npm run dev:client   # samo frontend
npm run dev:server   # samo backend
npm run build        # production frontend build
npm start            # servira dist preko Express backenda
npm run check        # syntax check servera + production build
```

## Docker

```bash
docker build -t prijelazradar .
docker run --env-file .env.local -p 5050:5050 prijelazradar
```

Aplikacija se tada otvara na `http://localhost:5050`.

## API endpointi

Auth:

- `POST /api/auth/login`
- `POST /api/auth/register`
- `GET /api/auth/me`

Public:

- `GET /api/health`
- `GET /api/public/state`
- `GET /api/routes/:crossingId?direction=toBih|toHr`
- `GET /api/trip-options?origin=Zagreb&destination=Cazin&direction=toBih&vehicle=car`

Admin/user write:

- `POST /api/admin/overrides` — admin token required
- `GET /api/admin/daily-report?date=YYYY-MM-DD&format=csv` — admin token required
- `POST /api/reports` — logged-in user required
- `GET /api/reports` — logged-in user required
- `POST /api/route-searches` — logged-in user required
- `GET /api/route-searches` — logged-in user required
- `GET /api/admin/audit` — admin token required

Camera analytics:

- `GET /api/camera-analytics/:crossingId?direction=toBih|toHr`
- `GET /api/camera-history/:crossingId?direction=toBih|toHr`
- `POST /api/camera-scan/:crossingId`
- `POST /api/camera-ingest`

## Važna napomena o točnosti

Google Routes API ne daje službeno “čekanje na granici”. Aplikacija procjenjuje čekanje kombinacijom:

- Google route/traffic signala kada je API key postavljen
- definiranih graničnih segmenata
- javnih kamera / CV adaptera
- ručnih admin korekcija
- dojava vozača
- povijesnih obrazaca

Zato UI prikazuje izvor čekanja. Ako nema službenog izvora, prikazuje se **Procjena aplikacije**. Službene izvore treba dodati nakon dogovora s vlasnicima/izvorima podataka.

## Panel za tim

Za osobu koja održava objave dodan je kratki vodič: `ADMIN_PANEL_GUIDE.md`.

## Pilot update: favoriti, dojave i povijest u bazi

Ova verzija dodaje tri produkcijska pilot flowa:

- Favorit prijelaza: korisnik može označiti prijelaz kao favorit iz pregleda/detalja. Favoriti se koriste u tabu Dojave kao brzi izbor za komentiranje stanja.
- In-app alerti: za favorite se prikazuje mali popup unutar aplikacije kada je čekanje visoko ili trend raste. Ovo nije browser push notifikacija; za pravi push kasnije treba dodati Web Push/FCM.
- Povijest/Prošlost: tab Povijest sada koristi `/api/history/:crossingId`, sprema satne snapshotove u SQL tablicu `prijelazradar_history_snapshots` i vraća kalendarski pregled 7 ili 30 dana.

SQL schema je idempotentna. Ako baza već postoji, ponovno pokretanje `sql/001_schema.sql` samo dodaje nedostajuće kolone/tablice:

```bash
psql "$DATABASE_URL" -f sql/001_schema.sql
```

Ako app radi s `DATABASE_URL`, backend će schemu pokrenuti automatski pri startu. Ako `DATABASE_URL` nije postavljen, koristi se lokalni JSON fallback u `data/runtime-store.json`.

## Povijest / Prošlost

Tab **Prošlost** je namjerno postavljen kao dnevni pregled: korisnik bira konkretan datum iz zadnjih 7 ili 30 dana i dobiva sat-po-sat protok vozila, čekanje i raspodjelu vozila za taj dan. Ispod dnevnog detalja ostaje dodatni sažetak za cijeli odabrani raspon 7/30 dana, ali glavni UX je odabir dana i detaljni satni prikaz.



## Production wait display policy

U starijim buildovima neki prijelazi su imali hardkodirane minute kao demo/fallback vrijednosti. To je uklonjeno iz korisničkog prikaza:

- `effectiveWaits` se puni samo za izvore koji su stvarno spremni za prikaz.
- `no-live-source` / `static-fallback` se ne prikazuju kao minutaža.
- frontend za takav slučaj prikazuje `—` i badge **Čeka live izvor**.
- admin i route paneli smiju koristiti neutralni interni baseline samo za tehničku usporedbu, ali ga ne smiju prodavati kao stanje na granici.

Ovo sprječava situacije gdje se npr. stara demo vrijednost od 75 minuta prikaže kao realno čekanje.

## Production source ingestion: BIHAMK / AMS RS / kamera snapshoti

Za pilot prema produkciji app sada ima `prijelazradar_source_snapshots` tablicu i source adapter sloj.

Prioritet čekanja je:

1. Admin potvrđeno čekanje
2. BIHAMK / AMS RS javni tekstualni izvor ako daje minute ili status koji se može normalizirati
3. Kamera snapshot model
4. Dojave vozača
5. Ako ništa od toga ne postoji, UI prikazuje **Čeka live izvor**. Konfiguracijske vrijednosti ostaju samo interni baseline za izračune i nikad se ne prikazuju kao stvarno stanje.

### Što se automatski dohvaća

- **BIHAMK**: `https://bihamk.ba/spi/stanje-na-cesti-u-bih/granicni-prijelazi`
  - `GP Velika Kladuša` mapira se na `maljevac`
  - `GP Gradiška` mapira se na `gradiska`
  - Tekstovi poput “duga kolona”, “zadržavanja nisu duža od 30 minuta”, “pojačan izlaz/ulaz” normaliziraju se u procijenjene minute + confidence.
- **AMS RS Gradiška**: `https://ams-rs.com/granicni-prelaz-gradiska/`
  - Ako stranica ne izloži strojno čitljivo vrijeme čekanja, snapshot se svejedno sprema kao javni signal, a čekanje se dodatno procjenjuje iz kalibriranog camera snapshot modela.
- **Kamera snapshot model**:
  - Ne tvrdi da je službeni AI brojač vozila.
  - Koristi dostupne javne snapshotove, kalibracije kadra i opcionalni `CAMERA_CV_ENDPOINT` ako kasnije spojite pravi vehicle detector.

### Ručno osvježavanje izvora

Admin endpoint:

```bash
curl -X POST http://localhost:5050/api/admin/sources/refresh \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Javni debug/latest endpoint:

```bash
curl "http://localhost:5050/api/sources/latest?crossingId=maljevac&direction=toHr&refresh=1"
```

`/api/public/state` također osvježava izvore ako je prošao `SOURCE_REFRESH_INTERVAL_MINUTES`.

### Povijest više nije modelirani backfill

`/api/history/:crossingId` čita `prijelazradar_history_snapshots`, a ti se snapshotovi pune iz source snapshotova. Stari modelirani backfill je isključen po defaultu.

Ako za vizualni demo baš želiš generirati povijest za dane bez izvora, postavi:

```env
HISTORY_ALLOW_MODEL_BACKFILL=true
```

Za produkciju ostavi:

```env
HISTORY_ALLOW_MODEL_BACKFILL=false
```

## Camera snapshot counting: brojanje vozila bez posebnog AI servisa

Ova verzija dodaje ugrađeni non-AI brojač za direktne JPEG snapshot kamere.

Radi ovako:

1. backend dohvaća direktni `.jpg` snapshot kamere
2. dekodira sliku preko `jpeg-js`
3. uzima kalibrirani ROI kadar za kameru
4. radi jednostavnu occupancy/edge analizu po mreži ćelija
5. grupira zauzete ćelije u komponente i iz toga procjenjuje vidljiva vozila
6. sprema rezultat u `prijelazradar_camera_snapshots`
7. kamera signal se pretvara u `camera-snapshot-model` source snapshot i ulazi u finalnu formulu čekanja

Ovo nije službeni brojač vozila i nije trenirani AI model. To je kalibrirani snapshot counter za pilot/production MVP. U UI i API odgovorima izvor zato treba ostati označen kao **Kamera procjena** ili **Snapshot counter**, ne kao službeno mjerenje.

### Nova SQL tablica

`sql/001_schema.sql` dodaje:

- `prijelazradar_camera_snapshots`

Sprema se:

- prijelaz i smjer
- kamera
- broj vidljivih auta/kombija/kamiona/buseva
- procjena queue vehicles
- procjena throughput/h
- procjena čekanja
- confidence
- ROI/metapodaci
- vrijeme dohvaćanja

### Env varijable

```env
CAMERA_SNAPSHOT_COUNTING_ENABLED=true
CAMERA_SNAPSHOT_TIMEOUT_MS=4500
CAMERA_SNAPSHOT_MIN_CONFIDENCE=46
```

Ako kasnije spojite pravi YOLO/Roboflow/OpenCV detector, `CAMERA_CV_ENDPOINT` ima prednost nad ugrađenim snapshot counterom.

### Debug endpoint

```bash
curl "http://localhost:5050/api/camera-snapshots/maljevac?direction=toHr&refresh=1"
curl "http://localhost:5050/api/camera-snapshots/gradiska?direction=toHr&refresh=1"
```

Za Railway/production treba periodično pozivati source refresh svakih 5–10 minuta, tako da se `prijelazradar_camera_snapshots`, `prijelazradar_source_snapshots` i `prijelazradar_history_snapshots` pune kroz dan.

`CAMERA_SNAPSHOT_REFRESH_INTERVAL_MINUTES=5` ograničava koliko često backend ponovno dohvaća istu kameru. Ako snapshot već postoji i svjež je, `/api/camera-analytics` koristi spremljeno očitanje umjesto da nepotrebno pogađa javni izvor.

## Production route guard for Maljevac/Gradiška

For the key crossings (`maljevac`, `gradiska`) the app does not route through the visual marker/pin only. Each direction has calibrated route anchors:

- approach side anchor
- checkpoint/border anchor
- exit side anchor

Google Routes requests force these anchors in order. After Google returns a polyline, the backend validates that the line passes close to the calibrated anchors and rejects alternatives that look like snapped-pin/local-road loops. This prevents the map from showing a strange detour around Maljevac/Gradiška as if it were a valid crossing route.

Useful local checks:

```text
http://localhost:5050/api/routes/maljevac?direction=toHr
http://localhost:5050/api/routes/maljevac?direction=toBih
http://localhost:5050/api/routes/gradiska?direction=toHr
http://localhost:5050/api/routes/gradiska?direction=toBih
```

The response contains `routeGuard` metrics in development mode. A valid production route should have `routeQuality: "verified"` and the returned `note` should say that the route was validated through calibrated crossing points.

Environment knobs:

```env
ROUTE_GUARD_ENABLED=true
ROUTE_GUARD_PASS_METERS=500
ROUTE_GUARD_MAX_CROSSING_KM=8
```

Keep `ROUTE_GUARD_ENABLED=true` for production demos.
#   g r a n i c e p r i j e l a z i  
 