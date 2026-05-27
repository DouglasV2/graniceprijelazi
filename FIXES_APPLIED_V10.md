# Fixes Applied V10

## Route anchors and guards

- Added `routeGuard` to `GP Gornji Varoš` so the new Gradiška bridge route is no longer treated as pending by the Google route guard layer.
- Added calibrated `anchors` with `routeGuard` for the remaining crossings that previously fell back to generic synthetic anchors:
  - GP Šamac
  - GP Svilaj
  - GP Izačić
  - GP Kamensko
  - GP Prisika
  - GP Vinjani Donji
  - GP Vinjani Gornji
  - GP Crveni Grm
- Introduced `calibratedAnchors()` / `calibratedRouteGuard()` helpers so future crossings can be added without the unsafe generic fallback.
- Updated frontend map marker coordinates for Orašje, Brod and the eight V10 crossings so UI pins match the backend border/control-zone anchors more closely.

## Public-source parser

- Reworked `parseDirectionalWaitsFromText()` to prioritize explicit minute/hour mentions with nearby directional context.
- Added support for direction phrases such as:
  - `ulaz u BiH/RS` → HR → BiH
  - `izlaz iz BiH/RS` → BiH → HR
  - `ulaz u HR` → BiH → HR
  - `izlaz iz HR` → HR → BiH
- Kept the older fallback heuristics for “duga kolona”, “pojačan ulaz/izlaz”, “nisu duža od X min” and “nema dužih zadržavanja”.

## AMS RS scope

- AMS RS parsing now calls the parser with `sourceSide: 'bih-rs'`.
- AMS RS snapshots now carry metadata that marks them as RS-side signals only, not full BiH-wide official status.
- AMS RS camera-page fallback has lower weight and explicit RS-side wording.

## Validation

Ran:

```bash
node -c server/index.js
npm ci
npm run check
```

Result:

- `server/index.js` syntax check passed.
- Vite production build passed.
- `npm audit` reported 0 vulnerabilities after installing from lockfile.

Additional targeted parser smoke tests were run against synthetic HAK/BIHAMK/AMS RS style text for explicit minute/hour values and directional phrases.
