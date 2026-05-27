# AUDIT_PLAN.md — PrijelazRadar produkcijski audit

Datum: 2026-05-27
Verzija: v10/staging-v9

---

## P0 — Kritično (sigurnost, jargon koji izravno kvari produkcijsku sliku)

### P0-1: Debug endpointi dostupni bez autentifikacije
- **Problem**: `/api/debug/wait` i `/api/debug/wait-scenarios` su javno dostupni bez ikakve autentifikacije. Vraćaju interne signale, težine, confidence score, parsere, raw statuse i detalje pipeline logike.
- **Rizik**: Korisnik može reverse-engineerati logiku procjene. Admin može propustiti da ih isključi u produkciji.
- **Predloženo rješenje**: Dodati `authRequired + adminRequired` na oba endpointa. Alternativno, omogućiti ih samo kad `NODE_ENV !== 'production'`.
- **Datoteke**: `server/index.js:2123`, `server/index.js:2288`
- **Testiranje**: `curl /api/debug/wait` bez tokena → mora vratiti 401.
- **Utjecaj**: Nema vidljivog utjecaja na korisnike, samo zakl. admin access.

### P0-2: `/api/health` otkriva osjetljive interne informacije
- **Problem**: Endpoint vraća: `integrations.routes: 'missing-key'` (otkriva status Google ključa), `productionChecks.warnings` koji sadrži poruke o SESSION_SECRET stanju, broju korisnika/reportova/overridea, puni path datastora u dev modu.
- **Rizik**: Rekognosciranje produkcijskog okruženja. Outsider može znati je li Google ključ konfiguriran i jesmo li u dev/prod modu.
- **Predloženo rješenje**: Javni `/api/health` vraća samo `{ ok, service, updatedAt, uptimeSeconds }`. Detalji integrations/datastore/productionChecks idu na `/api/admin/health` iza adminRequired.
- **Datoteke**: `server/index.js:2750–2805`
- **Testiranje**: `curl /api/health` → samo ok/service/updatedAt/uptimeSeconds.
- **Utjecaj**: Monitoring alati trebaju samo `ok: true`, nemaju štete.

### P0-3: User-Agent sadrži "staging-pilot"
- **Problem**: Svi HTTP zahtjevi prema javnim izvorima (BIHAMK, AMS RS, HAK) šalju User-Agent: `'PrijelazRadar/1.0 staging-pilot (+https://borderflow.local)'`. U produkciji ovo može:
  - Izazvati da se app identificira kao staging/test
  - Uzrokovati blokiranje od strane izvora koji filtriraju botovc/staging agente
  - Narušiti percepciju ozbiljnosti aplikacije ako se logira
- **Rizik**: Srednji. Može blokirati dohvat javnih izvora u produkciji.
- **Predloženo rješenje**: Promijeniti u `'PrijelazRadar/1.0 (+https://prijelazradar.hr)'` ili koristiti `SITE_URL` env varijablu.
- **Datoteke**: `server/index.js:1127`
- **Testiranje**: Provjera logova nakon deploy-a.
- **Utjecaj**: Nema na korisnika.

---

## P1 — Važno (korisnički jargon, sigurnosni headeri, memorijski propust)

### P1-1: Rate limit buckets se nikad ne čiste (memory leak)
- **Problem**: `rateBuckets` je in-memory `Map`. Svaki novi IP:path stvori novi entry koji se nikad ne briše. Na dugotrajnom procesu s mnogo različitih IP adresa, ovo može nahrupiti memoriju.
- **Rizik**: Na Render/Fly free tieru — prekorijen memorije → restart aplikacije.
- **Predloženo rješenje**: Dodati `setInterval` koji svake 15 min briše buckete čiji je `resetAt` prošao.
- **Datoteke**: `server/index.js:470–485`
- **Testiranje**: Provjeriti da stari bucketi nestaju.
- **Utjecaj**: Nema na korisnike.

### P1-2: Nedostaju CSP, HSTS, X-Frame-Options sigurnosni headeri
- **Problem**: Trenutno postoje samo: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. Nedostaju:
  - `Content-Security-Policy` — štiti od XSS i injection
  - `Strict-Transport-Security` — potrebno u produkciji
  - `X-Frame-Options` (ili CSP `frame-ancestors`) — clickjacking zaštita
  - `X-XSS-Protection` — legacy browser zaštita
- **Rizik**: Srednji. Bez CSP-a browser ne ograničava inline scripts/styles injection. Bez HSTS-a korisnici mogu biti downgraded na HTTP.
- **Predloženo rješenje**: Dodati comprehensive security header middleware. CSP mora dozvoliti Google Maps JS/tiles, Google fonts, self.
- **Datoteke**: `server/index.js:26–32`
- **Testiranje**: `curl -I /api/health` i provjera headera. Security headers validator.
- **Utjecaj**: Nema vidljivog na korisnike.

### P1-3: Camera UI prikazuje tehnički jargon korisniku
- **Problem**: U javnom camera panelu korisnik vidi:
  - `{analytics.confidence}% pouzdanost` (linija 3257) — goli postotak bez konteksta
  - `izvor: snapshot` / `izvor: snapshot provjera` (linija 3258) — tehničke oznake
  - `<small>snapshot provjera</small>` ili `<small>snapshot</small>` po lane signal kartici (linija 3297)
  - `{signal.confidence}%` po lane kartici (linija 3298)
  - `{selectedSignalData.confidence}%` u selected signal strip (linija 3323)
  - Nota kartica: "Snapshot provjera", "vizualni snapshot", "AI detekcije", "bounding boxove", "confidence postotke", "CV pipeline" (linija 3344–3347) — ovo je najgori slučaj
- **Rizik**: Korisnik vidi developer-alat, ne produkcijsku aplikaciju.
- **Predloženo rješenje**:
  - `{analytics.confidence}%` → za javljanje u pilu koristiti "Srednja pouzdanost" / "Visoka pouzdanost" / "Niska pouzdanost" prema rasponu
  - `snapshot`/`snapshot provjera` → `Kamera (vizualni pregled)` ili `Prema kameri`
  - Nota karticu kompletno prepisati na korisnički jezik
  - `{signal.confidence}%` u lane karticama → maknuti ili zamijeniti s labelom
- **Datoteke**: `src/App.jsx:3257–3258`, `3297–3298`, `3322–3323`, `3344–3347`
- **Testiranje**: Vizualna provjera camera panela — nema tehničkih pojmova.
- **Utjecaj**: Korisnik bolje razumije što kamera govori.

### P1-4: Signal badge "fallback" vidljiv u route label
- **Problem**: `src/App.jsx:2430–2432` koristi `className: 'fallback'` za badge oznake "Provjera rute" i "Validirana ruta". Klasa se može vidjeti u DOM-u; label je OK, ali klasa može izazvati vizualni problem ako CSS koristi klasu za display.
- **Rizik**: Nizak ako CSS klasa nije direktno prikazana; srednji ako se koristi kao vizualni indikator.
- **Predloženo rješenje**: Promijeniti klasu `'fallback'` u `'pending'` ili `'unconfirmed'`.
- **Datoteke**: `src/App.jsx:2430–2432`
- **Testiranje**: Provjera badge vizuala na rute.
- **Utjecaj**: Vizualni badge izgleda konzistentno.

### P1-5: Camera selected signal strip prikazuje `Pouzdanost X%`
- **Problem**: Selected signal strip (linija 3321–3324) prikazuje `<span>Pouzdanost</span><strong>{selectedSignalData.confidence}%</strong>`. To je interni confidence score — nije korisnički razumljivo.
- **Rizik**: Korisnik vidi "Pouzdanost 63%" bez ikakvog konteksta što to znači.
- **Predloženo rješenje**: Zamijeni s labelom "Visoka pouzdanost" / "Srednja pouzdanost" / "Niska pouzdanost" na temelju praga.
- **Datoteke**: `src/App.jsx:3321–3325`

---

## P2 — UX poboljšanja

### P2-1: Camera analytics kartica — jasnije stanje
- **Problem**: "Procjena iz kamera" kartica prikazuje minutu i status, ali nema jasnog "zadnje ažuriranje" timestampa koji je vidljiv korisniku na prvom pogledu.
- **Predloženo rješenje**: Dodati kratki timestamp uz status badge.

### P2-2: Empty state za kamere kad kamera nije dostupna
- **Problem**: Nema posebnog empty state kad nema kamera za prijelaz (crossing.cameras je prazan).
- **Predloženo rješenje**: Prikazati "Za ovaj prijelaz nemamo dostupnu kameru" umjesto praznog panela.

### P2-3: Tooltip za source badge
- **Problem**: Source badge (npr. "BIHAMK", "Kamera", "Procjena") ne objašnjava što znači.
- **Predloženo rješenje**: Dodati `title` atribut s kratkim objašnjenjem.

### P2-4: Route recommendation objašnjenje
- **Problem**: Kad app preporučuje rutu, korisnik ne vidi uvijek zašto.
- **Predloženo rješenje**: Kratko objašnjenje uz preporuku (npr. "Preporučujemo Maljevac jer prema dostupnim podacima ima kraće čekanje.").

### P2-5: `<small>` timestamp "Ažurirano {analytics.updatedAt}" u flow kartici
- **Problem**: `analytics.updatedAt` može biti relativno ili apsolutno — nije uvijek razumljivo bez konteksta.
- **Predloženo rješenje**: Formatirati kao "Zadnje ažurirano prije X min" ili "Ažurirano u HH:MM".

---

## P3 — Refaktor / dugoročno

### P3-1: server/index.js modularizacija
- **Problem**: 4681 linija u jednoj datoteci — teško za održavanje.
- **Plan**: Postupna ekstrakcija bez promjene ponašanja:
  - `server/config.js` — env, crossings config
  - `server/auth.js` — hashPassword, verifyPassword, signToken, verifyToken
  - `server/datastore.js` — readStore, writeStore, pg helpers
  - `server/sources/bihamk.js`, `ams-rs.js`, `google-routes.js`
  - `server/camera/analytics.js`, `ingest.js`
  - `server/health.js`

### P3-2: src/App.jsx komponentizacija
- **Problem**: 4574 linija — teško za čitanje.
- **Plan**: Tek nakon stabilizirane logike, ekstrakcija u:
  - `CameraPanel.jsx`, `RouteView.jsx`, `AdminPanel.jsx`, `ChatView.jsx`

### P3-3: Testovi za wait pipeline
- **Problem**: Nema automatiziranih unit testova za `parseDirectionalWaitsFromText`, `isSoftUpperBoundSource`, `weightedWait`, `applyTrafficSanityCaps`.
- **Plan**: Dodati Vitest ili Node test runner s minimalnim overhead-om.

### P3-4: Proxy-aware rate limit
- **Problem**: IP-based rate limit ne radi ispravno iza Render/Fly/Cloudflare proxyja jer su svi requestovi s istog proxy IP-a.
- **Plan**: Postaviti `app.set('trust proxy', 1)` za Render/Fly deployment.

---

## Sigurnosni sažetak (za zapis)

| Nalaz | Razina | Status |
|-------|--------|--------|
| Debug endpointi bez autentifikacije | Kritično | **Popraviti P0** |
| Health endpoint otkriva interne detalje | Visoko | **Popraviti P0** |
| User-Agent "staging-pilot" | Srednje | **Popraviti P0** |
| Rate limit memory leak | Srednje | **Popraviti P1** |
| Nedostaju CSP/HSTS headeri | Srednje | **Popraviti P1** |
| Camera UI jargon (snapshot, CV, confidence %) | Visoko (UX) | **Popraviti P1** |
| innerHTML u Map markerima (iz internih podataka) | Nisko | Dokumentirati |
| Session token u localStorage (XSS rizik) | Srednje | Dokumentirati, httpOnly cookie kao P3 |
| Demo user u seedStore | Nisko | U redu za dev, ne mijenjati |

---

## Implementacijski red

1. ✅ Zaštiti debug endpointe (P0-1)
2. ✅ Sanitizirati health endpoint (P0-2)
3. ✅ Popraviti User-Agent (P0-3)
4. ✅ Dodati rate limit cleanup (P1-1)
5. ✅ Dodati security headers (P1-2)
6. ✅ Popraviti camera UI jargon (P1-3, P1-5)
7. ✅ Popraviti route badge klasu (P1-4)
8. → P2/P3 za sljedeću iteraciju
