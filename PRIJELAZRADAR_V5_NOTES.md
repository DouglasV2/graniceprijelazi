# PrijelazRadar v5 - consumer UI polish

Ovaj patch rebrandira javni UI iz BorderFlow u PrijelazRadar i odvaja gornji tamnoplavi app header, bijelu navigaciju i glavni hero/banner u tri jasna vizualna bloka.

## Što je doradjeno

- Brand u UI-u: `PrijelazRadar`, logo inicijali `PR`.
- Header je kompaktni tamnoplavi topbar.
- Navigacija je zasebna bijela/sticky kartica ispod headera.
- Hero `Znaj kada krenuti...` je odvojen od headera i izgleda kao glavni korisnički banner.
- Navigacija je preimenovana iz admin/dashboard tona u korisnički ton:
  - `Sada` umjesto težeg `Pregled`
  - `Karta` umjesto samo `Mapa`
  - `Dojavi` umjesto `Dojave`
  - `Trendovi` umjesto `Prošlost`
  - admin-only tab je `Uredi stanje` i prikazuje se samo timu/admin korisniku
- Uklonjeni su javni tekstovi koji zvuče kao interni sustav ili tehnička admin aplikacija.
- Header više ne prikazuje tehnički API/status copy; korisnik vidi samo da se stanje automatski osvježava.
- HR/EN prijevod je dopunjen za novi brand/copy.

## Provjera

Pokrenuto i prošlo:

```bash
npm run check
```

To uključuje:

```bash
node -c server/index.js
npm run build
```
