# UX cleanup notes

Ova verzija je očišćena za pokazivanje korisniku i operatoru stranice.

## Što je promijenjeno

- Aplikacija se sada može otvoriti bez prisilne prijave.
- Header više nema `Admin prikaz`, `Sustav online` i veliki `Kako računamo?` gumb.
- Gore su ostali samo `?` za objašnjenje i `Prijava` / `Odjava`.
- Glavna navigacija je skraćena: Pregled, Moj put, Mapa, Dojave, a admin vidi još Objave.
- `Chat` je preimenovan u `Dojave`, jer je to jasnije običnom korisniku.
- `Povijest` je maknuta iz glavnog izbornika da početni pregled ne bude zatrpan.
- Gumbi `Kamere` i `Dojavi stanje` na početnom sažetku sada vode na stvarne ekrane.
- Status sustava je premješten u mali tehnički red unutar sažetka, nije više dominantan u headeru.

## Za prezentaciju

Korisniku prvo pokaži:
1. Pregled prijelaza
2. Moj put
3. Kamere preko gumba na kartici
4. Dojave
5. Admin/Objave nakon prijave

## 2026-05-25 dodatna UX dorada

- Vraćen je tab za povijest/trend pod nazivom **Prošlost** u glavnu navigaciju.
- Na Pregled sekciju dodan je search/filter za prijelaz, grad, rutu i opis stanja.
- Dodan je prazan rezultat s gumbom za brisanje pretrage.
