# PrijelazRadar test deploy checklist

Ovaj ZIP ima minimalne dorade za test/staging deploy:

- proširen lijevi plavi `mini-sign` box u listi prijelaza, bez rezanja regije na tri točke
- frontend više ne forsira `/api/public/state?refresh=1`
- frontend provjerava spremljeni token preko `/api/auth/me` pri učitavanju
- `POST /api/camera-scan/:crossingId` je sada iza admin prijave
- `POST /api/camera-ingest` traži `x-api-key` koji mora odgovarati `CAMERA_INGEST_API_KEY`
- public source/snapshot endpointi više ne prihvaćaju force refresh kroz query parametar
- Dockerfile uključuje `sql`, non-root user i healthcheck

## Lokalna provjera

```bash
npm install
npm run check
```

## Docker test

```bash
docker build -t prijelazradar-test .
docker run --env-file .env -p 5050:5050 prijelazradar-test
```

## Minimalni env za staging

```env
NODE_ENV=production
PORT=5050
CORS_ORIGINS=https://tvoja-test-domena.com
SESSION_SECRET=dug-random-secret
BORDERFLOW_ADMIN_EMAIL=admin@prijelazradar.app
BORDERFLOW_ADMIN_PASSWORD=jaka-test-lozinka
CAMERA_INGEST_API_KEY=dug-random-ingest-key
VITE_GOOGLE_MAPS_API_KEY=browser-key
GOOGLE_MAPS_SERVER_KEY=server-key
```

Za pravi production koristi PostgreSQL preko `DATABASE_URL`.

## Source fallback model for test deploy

- Admin override always wins.
- BIHAMK and AMS RS public statuses are parsed when available for configured crossings.
- Camera snapshot counting runs for every configured crossing camera that exposes a direct JPEG image.
- Google Routes traffic estimate is used as the fallback when no public status/camera/report is available.
- If Google Routes key is missing, the UI still shows a clearly marked conservative planner estimate instead of a blank "Čeka izvor" state.
