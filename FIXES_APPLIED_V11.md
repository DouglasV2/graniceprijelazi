# FIXES_APPLIED_V11

## Border wait estimate v11

Applied globally to all configured border crossings, not only Maljevac.

### Backend changes

- Google Routes is now a traffic sanity signal, not a static fallback multiplier.
  - Blue/normal Google traffic maps to a low baseline range (roughly 0-12 min) instead of inheriting the configured planning wait.
  - Orange/slow and red/heavy Google traffic can still increase the estimate.
- Public text like “zadržavanja nisu duža od 30 min” is treated as a soft upper bound.
  - It no longer becomes 23-25 minutes by itself.
  - The parsed baseline is around 35% of the upper bound, with lower confidence/weight.
- Final combined estimate applies sanity caps:
  - Google normal + camera clear + soft public source => keep estimate low/moderate.
  - Google normal does not force 0 min; it only prevents high waits without stronger evidence.
  - Driver reports, admin overrides, Google heavy traffic, or camera-visible queue can still push the estimate higher.
- Camera snapshot model now estimates queue + flow, not just visible vehicles.
  - Adds `flowVehicles15`, `queueTrend`, `waitRangeMin`, `waitRangeMax` in metadata.
  - Uses previous snapshot when available to distinguish rising/falling queues.

### Frontend changes

- Map route card now separates:
  - `Čekanje na granici`
  - `Vožnja kroz zonu`
  - `Dionica zone`
  - `Cestovni zastoj`
- Route labels on the map say `Zona vožnja` for control-zone routes, so the Google zone duration is not confused with border waiting time.
- Source metadata can display estimate ranges from the backend when available.

### Files changed

- `server/index.js`
- `src/App.jsx`
- `dist/index.html`
- `dist/assets/index-R3wU__e1.js`
- `dist/assets/index-BxquMrdu.css`
- `FIXES_APPLIED_V11.md`
