# PrijelazRadar v6 – primijenjene izmjene

## 1. Obavezna prijava
- Aplikacija više ne prikazuje javni shell bez korisničke prijave.
- Na ulazu se odmah prikazuje ekran za prijavu/registraciju.
- Registracija i login i dalje koriste backend auth endpointove i postojeću bazu/runtime store.
- Nakon prijave public state se dohvaća uz Bearer token.

## 2. User-friendly tekstovi i alternativa
- Pojednostavljen tekst o kombiniranoj procjeni izvora.
- U kartici „Najbolja alternativa” uklonjena je riječ „duže”.
- Razlika alternative sada ima ton:
  - zeleno kada alternativa štedi vrijeme,
  - plavo za malu razliku,
  - žuto/narančasto od 25 min,
  - crveno od 60 min.

## 3. Moj put – duže rute
- Dodana logika koja prepoznaje smjer za rute Njemačka/Austrija/Slovenija/Hrvatska ↔ BiH.
- Primjeri poput Njemačka → BiH automatski idu kao HR → BiH, a BiH → Njemačka kao BiH → HR.
- Offline/fallback procjena više nije fiksnih ~90 min za duge rute, nego koristi približnu udaljenost za poznate gradove/države.

## 4. Mapa – uklonjene nepouzdane linije izvan ceste
- Ako prijelaz nema ručno validiranu cestovnu liniju, app više ne crta rutu preko mape.
- Umjesto toga prikazuje poruku „Provjera rute”, a čekanja, kamere, markeri i Google traffic layer ostaju dostupni.
- Fallback/test ruta se više ne prikazuje kao ravna ili čudna linija preko terena.

## 5. Povijest – prirodniji tekst
- „Sat-po-sat prikaz” preimenovan je u „Satni prikaz”.
- Objašnjenje detalja je napisano prirodnije i manje robotski.

## Provjera
- `node -c server/index.js` prolazi.
- `npm run build` prolazi.
- `npm run check` prolazi.
