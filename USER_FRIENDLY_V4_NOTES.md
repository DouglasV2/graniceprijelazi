# PrijelazRadar v4 staging UX notes

Ovaj patch dodaje user-friendly sloj za staging/test deploy.

## Dodano

- Vidljiviji smjer `HR → BiH` / `BiH → HR` s objašnjenjem smjera.
- Kartica **Najbolji izbor trenutno** na Pregledu.
- Operativni status prijelaza: `Otvoreno`, `Pojačano`, `Zatvoreno`, `Preusmjereno`, `Nepoznato`.
- `Ažurirano prije...` prikaz svježine izvora.
- Objašnjenje **Kombinirana procjena** bez prikaza konflikta izvora.
- Share link za konkretan prijelaz i smjer: `?crossing=...&direction=...&tab=...`.
- Favoriti i obavijesti: korisnik može spremiti pravilo “javi kad padne ispod 15 min”. Browser notification radi dok je app otvoren i browser dozvoli notifikacije.
- Dojave su proširene s tipovima: zatvoreno, detaljna kontrola, zastoj/nezgoda.
- Panel za tim ima ručni status rute, ne samo čekanje: otvoreno/auto, pojačano, zatvoreno, preusmjereno, nepoznato.
- Backend route endpoint poštuje admin status override i vraća zatvorenu/preusmjerenu rutu bez pokušaja prikaza krive Google zaobilaznice.
- Dodan HR/EN toggle za glavni UI i nove staging elemente.
- Mobile CSS dorade za pregled, mape, dojave i admin.

## Bitno za zatvorene rute

Ako Google route guard vidi ekstremnu zaobilaznicu ili admin označi rutu kao zatvorenu/preusmjerenu, app prikazuje korisniku jasan zatvoreni state i alternativu. Kada se ručni status vrati na `Otvoreno / auto provjera`, backend ponovno pokušava normalnu Google rutu; čim Google vrati validnu putanju kroz kalibrirane točke, ruta se prikazuje bez novog deploya.

## Testirano

- `node -c server/index.js`
- `npm run build`
- `npm run check`
- `/api/public/state` vraća `statusOverrides`
- `/api/routes/gradiska?direction=toBih` vraća payload
