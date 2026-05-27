# PrijelazRadar handoff

Ovo je verzija koju možeš dati nekome da odmah vidi ozbiljniju pilot/produkcijsku osnovu aplikacije.

## Kako se pokreće

```bash
npm install
cp .env.example .env.local
npm run dev
```

Otvori `http://localhost:5173`.

Login više ne prikazuje demo passworde u aplikaciji. Admin račun postavi kroz `.env.local` ili SQL seed.

Za deploy:

```bash
npm run build
npm start
```

ili Docker:

```bash
docker build -t prijelazradar .
docker run --env-file .env.local -p 5050:5050 prijelazradar
```

## Baza

Aplikacija radi u dva moda:

- `DATABASE_URL` postavljen → PostgreSQL tablice iz `sql/001_schema.sql`
- `DATABASE_URL` prazan → lokalni JSON fallback `data/runtime-store.json`

Za produkciju/pilot s domenom preporuka je PostgreSQL.

```bash
psql "$DATABASE_URL" -f sql/001_schema.sql
psql "$DATABASE_URL" -f sql/002_seed_local_admin.sql

# za vlastitu produkcijsku lozinku:
node scripts/create-password-hash.mjs "jaka-admin-lozinka"
# hash kopirati u sql/002_seed_admin_template.sql
psql "$DATABASE_URL" -f sql/002_seed_admin_template.sql
```

## Što je produkcijski dorađeno

- Login više nije hardkodiran u Reactu.
- Demo password shortcuti su maknuti iz UI-ja.
- Lozinke se hashiraju na backendu.
- Sesije koriste signed tokene.
- Admin korekcije čekanja spremaju se server-side.
- Dojave korisnika se spremaju server-side.
- Route search history se sprema lokalno i može se spremiti server-side za ulogirane korisnike.
- Admin može ručno promijeniti čekanje i kopirati dugu/kratku objavu.
- Admin može exportati dnevni CSV izvještaj.
- Admin endpointi traže admin token.
- Postoji audit log.
- Health endpoint javlja Google key, session secret, datastore mode i broj spremljenih zapisa.
- Route comparison radi i bez Google keya kroz fallback procjenu, a s Google keyem koristi Routes API.
- UI označava čekanja kao `Procjena aplikacije`, `Admin potvrđeno` ili `Službeni izvor` ako se kasnije poveže.
- Dockerfile je uključen.
- Dependency verzije su zaključane.

## Što treba promijeniti prije javnog puštanja

Ovo nisu feature planovi nego sigurnosne i deploy postavke koje moraju biti tvoje:

- postaviti `DATABASE_URL`
- postaviti `SESSION_SECRET`
- kreirati admin korisnika kroz env seed ili SQL seed
- postaviti Google Maps browser key
- postaviti Google Routes server key
- postaviti `CORS_ORIGINS` na pravu domenu
- provjeriti pravila korištenja javnih kamera/izvora prije komercijalnog korištenja

## Što aplikacija ne tvrdi

Aplikacija ne tvrdi da ima službeno čekanje policije/carine. Čekanje je procjena iz prometnih signala, kamera, admin korekcija i dojava. Zato UI prikazuje smjer, izvore i pouzdanost.

Službene izvore treba dodati nakon dogovora s nadležnim izvorima/podacima. Do tada se za automatske brojke koristi oznaka **Procjena aplikacije**.

## Camera lane calibration

For the Gornji Varoš demo camera the lane overlay is calibrated from operational knowledge:

- far-left lane = EU passengers/documents
- remaining visible lanes = non-EU / standard control

This is not treated as generic AI truth. It is stored as crossing-specific calibration data and can be changed per camera if the lane setup changes. For production, each public camera should have its own calibration note, last verified timestamp, and confidence level.

## Hardkodirane minute / fallback politika

Korisnički UI više ne smije prikazivati stare konfiguracijske minute kao realno čekanje. Ako nema admin overridea, BIHAMK/AMS signala, kamera snapshota ili dojava, prikazuje se `Čeka live izvor` / `—`. Konfiguracija `waits` ostaje samo interni baseline za multiplikatore i tehnički fallback, ne kao javni podatak.
