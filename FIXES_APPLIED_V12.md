# FIXES_APPLIED_V12

## Problem koji je riješen

U V11 se backend sanity-cap oslanjao na Google traffic snapshot iz `__BF_WAIT_SOURCES`. Ako backend source refresh nije imao spremljen `google-traffic-estimate` signal, UI je i dalje mogao prikazati 25–30 min iz BIHAMK/kamere čak i dok je trenutna Google ruta na karti bila plava i imala 0–2 min cestovnog zastoja.

To je bio razlog za situaciju: karta pokazuje plavu zonu i 1 min zastoja, ali kartica i marker prikazuju 30 min.

## Što je promijenjeno

### `src/App.jsx`

Dodana je frontend route sanity logika koja koristi trenutno učitanu Google rutu iz `/api/routes/:crossingId`:

- `getBaseDisplayedWait()` čita backend čekanje bez frontend route korekcije.
- `getDisplayedWait()` sada primjenjuje kratkotrajni `__BF_ROUTE_SANITY_WAITS` override kad Google ruta pokazuje plavu/protočnu zonu.
- `routeTrafficMeta()`, `routeLooksClear()`, `routeLooksHeavy()` analiziraju `delayMinutes`, `ratio` i `level` iz trenutne Google rute.
- `computeRouteSanityWait()` spušta visoke procjene kad je Google ruta plava:
  - BIHAMK/HAK/AMS “do X min” ili kombinirana soft procjena: cap oko 12 min.
  - Ako kamera javlja jaku kolonu: dopušta se do oko 20 min, ali ne 30+ dok je Google zona plava.
  - Admin override i dojave vozača se ne capaju.
- `updateRouteSanityWait()` se poziva nakon svakog učitavanja rute i osvježava globalni UI kroz `bf-route-sanity-updated` event.
- `getWaitSourceMeta()` prikazuje jasnu napomenu kad je čekanje spušteno zbog plave/protočne Google rute.

### `server/index.js`

- `waitSources` sada vraća i:
  - `rangeMin`
  - `rangeMax`
  - `confidenceHint`
  - `hasGoogleSignal`
  - `hasCameraSignal`
  - `hasStrongCameraQueue`
  - `hasSoftUpperBoundPublic`

Ta polja frontend koristi da razlikuje “meki javni upper bound” od jake kamere ili ručne/dojavne potvrde.

## Očekivano ponašanje

Primjer Maljevac:

- Google ruta plava
- cestovni zastoj 0–2 min
- BIHAMK kaže “nije duže od 30 min”
- kamera nema jaku kolonu

UI više ne prikazuje 25–30 min, nego otprilike 8–12 min s napomenom da plavo ne znači 0 min, ali sprječava visoku procjenu bez potvrde.

Ako je Google narančast/crven ili kamera/dvojave potvrde veliku kolonu, procjena se ne spušta agresivno.

## Provjera

- `node -c server/index.js` prošao.
- `npm run build` prošao.
