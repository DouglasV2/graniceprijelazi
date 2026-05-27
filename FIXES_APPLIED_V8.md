# V8 route calibration update

Zašto u V7 nije bilo ruta za Brod, Bijaču i Orašje:

- V7 je namjerno sakrio svaku rutu koja nema `routeGuard` / provjerene anchor točke.
- To je spriječilo čudne Google polyline prikaze koji kreću ili završavaju na nelogičnim mjestima.
- Brod, Bijača i Orašje su imali čekanja/kamere/promet, ali nisu imali uključenu validiranu cestovnu liniju za mapu.

Što je promijenjeno u V8:

- Dodan `routeGuard` za Bijaču.
- Dodane kalibrirane anchor točke i `routeGuard` za Brod.
- Dodane kalibrirane anchor točke i `routeGuard` za Orašje.
- `addCrossing` sada može primiti ručno definirane anchore umjesto generičkih offset točaka.
- Pending tekst je preformuliran da bude jasniji korisniku.
- Mapa i dalje prikazuje samo kratku provjerenu prometnu zonu oko prijelaza, ne cijelu čudnu start/end rutu.

Provjera:

- `node -c server/index.js`
- `npm run build`
- `npm run check`
