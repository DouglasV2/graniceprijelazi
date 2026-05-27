# Panel za tim - kratke upute

Panel za tim je zamišljen kao radna ploča za osobu koja održava Facebook/Telegram/web objave.
Ne treba tumačiti sve podatke ručno. Panel vodi kroz tri koraka.

## 1. Odaberi prijelaz i smjer

Odabere se granični prijelaz i smjer:

- HR → BiH
- BiH → HR

Sve brojke u panelu nakon toga vrijede samo za taj prijelaz i taj smjer.

## 2. Provjeri konačno čekanje

Panel prikazuje dvije brojke:

- **Procjena aplikacije** - automatska procjena iz konfiguracije, prometnih signala, kamera i dojava.
- **Ručna vrijednost** - broj koji admin može unijeti ako ima bolju informaciju s terena.

Ako admin unese ručnu vrijednost, ona ima prednost nad automatskom procjenom i ulazi u objavu kao **Admin potvrđeno**.

Gumb **Vrati automatski** briše ručnu korekciju i vraća stanje na **Procjena aplikacije**.

## 3. Kopiraj objavu

Desno je uvijek spreman tekst za objavu. Admin samo klikne:

- **Kopiraj** za dužu objavu
- **Kopiraj kratku objavu** za story / kratki update

Nakon kopiranja panel prikaže kratku potvrdu.

## 4. Export dnevnog izvještaja

U gornjem dijelu admin panela postoji **Export dnevnog izvještaja**.

Export skida CSV s pregledom svih prijelaza i oba smjera:

- automatsko čekanje
- ručna korekcija ako postoji
- konačno čekanje
- status izvora: `Procjena aplikacije` ili `Admin potvrđeno`
- napomena da je službeni izvor planiran za dodavanje/dogovor
- broj dojava za taj dan

## Što znače signali?

Panel ispod prikazuje zašto aplikacija daje neku brojku:

- aplikacijska procjena
- ručna korekcija
- potvrda s terena
- dojave vozača
- kamera / trake
- bottleneck, odnosno gdje nastaje čekanje

## Što znači odluka?

- **Objaviti odmah** - velika gužva, treba javni update.
- **Pripremiti objavu** - stanje je pojačano, objava je korisna.
- **Provjeriti dojave** - ima signala od vozača, ali treba provjera prije objave.
- **Samo web update** - nema potrebe spamati Facebook, dovoljno je da stanje bude u aplikaciji.

## Kamere i trake

Ako kamera ima kalibrirane trake, panel to prikazuje. Primjer: Gornji Varoš ima logiku gdje je krajnja lijeva traka EU, a ostale non-EU.

To znači da admin ne gleda samo sliku kamere, nego vidi i kako aplikacija tumači promet po trakama.
