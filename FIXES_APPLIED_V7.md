# V7 map route cleanup

Popravljeno za čudne rute na Google mapi:

- Default prikaz na karti više ne tretira lokalni border preview kao punu rutu s proizvoljnim početkom i krajem.
- Backend sada prvo traži Google Routes rutu kroz ručno kalibrirane točke, ali za prikaz na mapi reže polyline na provjerenu zonu oko graničnog prijelaza.
- Korisnik vidi "prometna zona" / "provjerena zona" umjesto da dobije dojam da je to kompletna ruta od čudnog starta do čudnog cilja.
- Maljevac ima stroži vizualni prikaz zone: prikazuje se kraća dionica oko prijelaza, bez udaljenih početnih i završnih točaka.
- Ako prijelaz nema ručno potvrđene anchor točke, ruta se ne crta dok ne bude validirana.

Provjera:
- `node -c server/index.js`
- `npm run build`
- `npm run check`
