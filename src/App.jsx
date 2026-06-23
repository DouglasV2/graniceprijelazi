
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Camera,
  Globe2,
  CheckCircle2,
  Clock,
  Copy,
  Crosshair,
  Download,
  Lock,
  LogOut,
  MapPin,
  Navigation,
  RefreshCw,
  Search,
  ShieldCheck,
  Share2,
  Truck,
  User,
} from 'lucide-react';
import { formatMinutes, hasKnownWait, isUsableMinuteValue, normalizeMinutes, formatWaitDisplay, shapeWaitDisplay } from './utils/wait-format.js';
import { cameraEstimateDecision, buildCameraQueueLabel, buildCameraTrustText, cameraStatusCopy } from './utils/camera-display.js';
import { loadGoogleMaps, mapsConstructorsReady } from './utils/google-maps-loader.js';
import { rankCrossingsByLocation, haversineKm } from './utils/crossing-recommendation.js';
import { useCrossingMeasurement } from './hooks/use-crossing-measurement.js';
import { resolveReportWaitMinutes, clampWaitMinutes, WAIT_QUICK_OPTIONS } from './utils/parse-wait-minutes.js';
import { routeGeometryValidated } from './utils/route-geometry.js';
import { computeHistoryInsights, compareNowToTypical, formatHourWindow } from './utils/history-insights.js';


function makeCrossingHistory(baseCars, baseTrucks, baseBuses, baseWait) {
  const slots = [
    ['06', 0.55, 0.72], ['09', 0.86, 0.9], ['12', 1.04, 1],
    ['15', 1.22, 1.18], ['18', 1.12, 1.08], ['22', 0.62, 0.7],
  ];
  return slots.map(([hour, demand, waitFactor]) => ({
    hour,
    cars: Math.max(20, Math.round(baseCars * demand)),
    trucks: Math.max(6, Math.round(baseTrucks * demand)),
    buses: Math.max(1, Math.round(baseBuses * demand)),
    wait: Math.max(6, Math.round(baseWait * waitFactor)),
  }));
}

function externalCamera({ id, label, source = 'HAK izvor', url, note, matchText, matchTexts, imageIndex }) {
  return {
    id,
    label,
    source,
    status: 'javna slika kroz aplikaciju',
    type: 'image',
    url,
    externalUrl: url,
    note: note || 'Slika se učitava kroz aplikacijski proxy. Original je dostupan preko gumba “Otvori izvor”.',
    ...(matchText ? { matchText } : {}),
    ...(Array.isArray(matchTexts) ? { matchTexts } : {}),
    ...(Number.isFinite(Number(imageIndex)) ? { imageIndex: Number(imageIndex) } : {}),
  };
}

// Neighbour-country labels per crossing. The internal direction key `toHr` means "leaving BiH";
// for a non-HR crossing it means "toward the neighbour" (Serbia / Crna Gora).
const NEIGHBOR_LABELS = { HR: 'HR', RS: 'Srbija', CG: 'Crna Gora' };
function neighborLabelOf(neighbor = 'HR') { return NEIGHBOR_LABELS[neighbor] || 'HR'; }
// The "A → B" direction label for a crossing. Prefers the crossing's own per-direction label
// (so existing data keeps working); falls back to the neighbour pair.
function dirPairLabel(crossing, direction) {
  const fromData = crossing?.directions?.[direction]?.label;
  if (fromData) return fromData;
  const n = neighborLabelOf(crossing?.neighbor);
  return direction === 'toBih' ? `${n} → BiH` : `BiH → ${n}`;
}

function makeBorderCrossing(config) {
  const {
    id, shortName, route, area, lat, lng, status, confidence, updatedAt,
    fieldConfirmed = false, fieldNote, cause, sponsor, extraDriveFromMainRoute,
    waits, segments, cameras, bestDays, historyBase, neighbor = 'HR',
  } = config;
  const neighborLabel = neighborLabelOf(neighbor);

  return {
    id,
    name: `GP ${shortName}`,
    shortName,
    neighbor,
    neighborLabel,
    route,
    area,
    lat,
    lng,
    status,
    confidence,
    updatedAt,
    fieldConfirmed,
    fieldConfirmedAt: fieldConfirmed ? 'prije 18 min' : 'nije potvrđeno',
    fieldNote,
    cause,
    sponsor,
    extraDriveFromMainRoute,
    directions: {
      toBih: {
        label: `${neighborLabel} → BiH`,
        cars: waits.toBih.cars,
        trucks: waits.toBih.trucks,
        buses: waits.toBih.buses,
        trend: waits.toBih.trend,
        bottleneckSide: waits.toBih.bottleneckSide,
        bottleneckText: waits.toBih.bottleneckText,
        waitAdvice: waits.toBih.waitAdvice,
        publishDecision: waits.toBih.publishDecision,
        publishReason: waits.toBih.publishReason,
        alertRules: waits.toBih.alertRules,
        segments: segments.toBih,
      },
      toHr: {
        label: `BiH → ${neighborLabel}`,
        cars: waits.toHr.cars,
        trucks: waits.toHr.trucks,
        buses: waits.toHr.buses,
        trend: waits.toHr.trend,
        bottleneckSide: waits.toHr.bottleneckSide,
        bottleneckText: waits.toHr.bottleneckText,
        waitAdvice: waits.toHr.waitAdvice,
        publishDecision: waits.toHr.publishDecision,
        publishReason: waits.toHr.publishReason,
        alertRules: waits.toHr.alertRules,
        segments: segments.toHr,
      },
    },
    cameras,
    history: makeCrossingHistory(historyBase.cars, historyBase.trucks, historyBase.buses, historyBase.wait),
    bestDays,
  };
}

const ADDITIONAL_CROSSINGS = [
  makeBorderCrossing({
    id: 'orasje', shortName: 'Orašje', route: 'Županja ↔ Orašje', area: 'Slavonija / Posavina', lat: 45.0405, lng: 18.7030,
    status: 'busy', confidence: 77, updatedAt: '14:27', fieldConfirmed: false,
    fieldNote: 'Pratimo obje strane prijelaza kroz HAK i BIHAMK izvore.',
    cause: 'Pojačan promet prema Posavini i izmjena smjena na prijelazu', sponsor: 'Kafić Sava', extraDriveFromMainRoute: 44,
    waits: {
      toBih: { cars: 34, trucks: 68, buses: 42, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Usporavanje nastaje nakon mosta prema BiH kontroli.', waitAdvice: 'Dobar izbor ako je Gradiška opterećena.', publishDecision: 'Web update', publishReason: 'Stanje je pojačano, ali bez kritičnog rasta.', alertRules: ['naraste preko 55 min', 'padne ispod 20 min', 'kamionska traka uspori osobna vozila'] },
      toHr: { cars: 38, trucks: 75, buses: 48, trend: 'rising', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz u HR može usporiti pri većem broju non‑EU putnika.', waitAdvice: 'Pratiti prije polaska ako ideš prema Županji.', publishDecision: 'Pratiti', publishReason: 'Trend prema HR lagano raste.', alertRules: ['naraste preko 60 min', 'EU/non‑EU razlika prijeđe 25 min', 'trend se ubrza'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 10, level: 'low' }, { label: 'Most', minutes: 8, level: 'low' }, { label: 'BiH kontrola', minutes: 16, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 12, level: 'medium' }, { label: 'Most', minutes: 8, level: 'low' }, { label: 'HR kontrola', minutes: 18, level: 'medium' }],
    },
    cameras: [
      {
        id: 'ora-hak-zupanja',
        label: 'Županja · HR strana',
        source: 'HAK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://www.hak.hr/info/kamere/79.jpg',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=44',
        note: 'HAK kamera za zonu Županja/Orašje. Ako izvor privremeno ne vrati sliku, otvori izvor u novoj kartici.',
      },
      {
        id: 'ora-hak-bih',
        label: 'Orašje · BiH strana',
        source: 'HAK/BIHAMK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://www.hak.hr/info/kamere/401.jpg',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=183',
        note: 'Slika BiH strane prijelaza, proxyjana kroz aplikaciju radi stabilnog prikaza.',
      },
      {
        id: 'ora-amsbih',
        label: 'Orašje · AMSBiH',
        source: 'AMSBiH direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://www.amsbih.ba/amsbih.ba/kamere/kamere/Lokacija20/0Orasje.jpg',
        externalUrl: 'https://bihamk.ba/spi/kamere',
        note: 'Dodatna javna kamera za Orašje. U aplikaciji ide preko backend proxyja.',
      },
    ],
    historyBase: { cars: 210, trucks: 82, buses: 14, wait: 32 }, bestDays: ['Ponedjeljak', 'Srijeda prije 11h', 'Nedjelja navečer'],
  }),
  makeBorderCrossing({
    id: 'brod', shortName: 'Brod', route: 'Slavonski Brod ↔ Brod', area: 'Slavonija / Posavina', lat: 45.1497, lng: 18.0033,
    status: 'busy', confidence: 80, updatedAt: '14:25', fieldConfirmed: true,
    fieldNote: 'Brod ima odvojene javne izvore za HR i BiH stranu.',
    cause: 'Gust gradski prilaz + kamionski valovi', sponsor: 'Auto servis Brod', extraDriveFromMainRoute: 36,
    waits: {
      toBih: { cars: 30, trucks: 72, buses: 40, trend: 'falling', bottleneckSide: 'BiH strana', bottleneckText: 'Osobna vozila prolaze solidno, ali kamionska traka stvara repove.', waitAdvice: 'Dobar kandidat za alternativu kod dužih čekanja na Gradiški.', publishDecision: 'Objavi kao alternativu', publishReason: 'Čekanje je umjereno i trend pada.', alertRules: ['padne ispod 20 min', 'kamioni prijeđu 90 min', 'postane bolji od planirane rute'] },
      toHr: { cars: 46, trucks: 88, buses: 58, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz u HR je glavni izvor čekanja u popodnevnom valu.', waitAdvice: 'Provjeriti kameru prije polaska prema Slavonskom Brodu.', publishDecision: 'Web update', publishReason: 'Pojačano, ali predvidljivo.', alertRules: ['naraste preko 70 min', 'padne ispod 25 min', 'trend krene rasti'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 8, level: 'low' }, { label: 'Most', minutes: 7, level: 'low' }, { label: 'BiH kontrola', minutes: 15, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 14, level: 'medium' }, { label: 'Most', minutes: 8, level: 'low' }, { label: 'HR kontrola', minutes: 24, level: 'medium' }],
    },
    cameras: [
      {
        id: 'bro-hak-sb-ulaz-hr',
        label: 'Slavonski Brod · ulaz u HR',
        source: 'HAK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=140',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=140',
        note: 'HAK stranica za Slavonski Brod ima više kamera; backend proxy uzima točno ovu sliku iz izvora.',
      },
      {
        id: 'bro-hak-sb-izlaz-hr',
        label: 'Slavonski Brod · izlaz iz HR',
        source: 'HAK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=140',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=140',
        note: 'Druga HAK slika s iste stranice Slavonski Brod.',
      },
      {
        id: 'bro-hak-bb-izlaz-hr',
        label: 'Bosanski Brod · izlaz iz HR u BiH',
        source: 'HAK/BIHAMK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=184',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=184',
        note: 'HAK/BIHAMK slika za BiH stranu Broda.',
      },
      {
        id: 'bro-hak-bb-ulaz-hr',
        label: 'Bosanski Brod · ulaz u HR',
        source: 'HAK/BIHAMK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=184',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=184',
        note: 'Druga HAK/BIHAMK slika s iste stranice Bosanski Brod.',
      },
      {
        id: 'bro-bihamk',
        label: 'Brod / BIHAMK',
        source: 'BIHAMK',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://bihamk.ba/spi/kamere',
        externalUrl: 'https://bihamk.ba/spi/kamere',
        matchTexts: ['GP Brod - Izlaz iz BiH', 'GP Brod - Ulaz u BiH', 'GP Brod', 'Bosanski Brod'],
        note: 'BIHAMK ima ulaz i izlaz za GP Brod. Backend traži Brod u listi kamera.',
      },
    ],
    historyBase: { cars: 235, trucks: 92, buses: 16, wait: 40 }, bestDays: ['Utorak', 'Četvrtak rano', 'Subota prije 8h'],
  }),
  makeBorderCrossing({
    id: 'samac', shortName: 'Šamac', route: 'Slavonski Šamac ↔ Šamac', area: 'Slavonija / Posavina', lat: 45.06135, lng: 18.49385,
    status: 'normal', confidence: 70, updatedAt: '14:21', fieldConfirmed: false,
    fieldNote: 'Koristan prijelaz za rasterećenje Posavine.', cause: 'Promet se mijenja ovisno o lokalnom prilazu', sponsor: 'Benzinska Šamac', extraDriveFromMainRoute: 58,
    waits: {
      toBih: { cars: 22, trucks: 44, buses: 26, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Trenutno nema izraženog zastoja na osobnim vozilima.', waitAdvice: 'Može biti dobra mirnija alternativa.', publishDecision: 'Ne objavljivati', publishReason: 'Stanje je uredno.', alertRules: ['naraste preko 40 min', 'padne ispod 15 min', 'pojavi se kamionski rep'] },
      toHr: { cars: 28, trucks: 54, buses: 32, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Lagano usporavanje pri ulazu u HR.', waitAdvice: 'Krenuti ako je najbliži prijelaz.', publishDecision: 'Web update', publishReason: 'Dovoljno za prikaz u aplikaciji.', alertRules: ['naraste preko 45 min', 'trend krene rasti', 'kamera pokaže dužu kolonu'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 7, level: 'low' }, { label: 'Most', minutes: 5, level: 'low' }, { label: 'BiH kontrola', minutes: 10, level: 'low' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 9, level: 'low' }, { label: 'Most', minutes: 6, level: 'low' }, { label: 'HR kontrola', minutes: 13, level: 'medium' }],
    },
    cameras: [externalCamera({ id: 'sam-hak', label: 'Slavonski Šamac', url: 'https://m.hak.hr/kamera.asp?g=2&k=300' })],
    historyBase: { cars: 150, trucks: 48, buses: 8, wait: 24 }, bestDays: ['Ponedjeljak', 'Srijeda', 'Petak rano'],
  }),
  makeBorderCrossing({
    id: 'svilaj', shortName: 'Svilaj', route: 'Svilaj ↔ Odžak', area: 'Slavonija / Posavina', lat: 45.10810, lng: 18.31310,
    status: 'normal', confidence: 72, updatedAt: '14:20', fieldConfirmed: false,
    fieldNote: 'Autocestovni prijelaz, koristan za duže rute.', cause: 'Stanje ovisi o autocestovnom prilazu i kontroli tereta', sponsor: 'Odmorište Svilaj', extraDriveFromMainRoute: 63,
    waits: {
      toBih: { cars: 20, trucks: 50, buses: 25, trend: 'falling', bottleneckSide: 'BiH strana', bottleneckText: 'Protok je stabilan na autocestovnom prilazu.', waitAdvice: 'Dobar izbor za putnike koji već koriste A5/A1 koridor.', publishDecision: 'Ne objavljivati', publishReason: 'Uredno stanje.', alertRules: ['naraste preko 45 min', 'kamioni prijeđu 80 min', 'ruta postane brža od Broda'] },
      toHr: { cars: 26, trucks: 58, buses: 30, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Kontrola prema HR zasad drži ritam.', waitAdvice: 'Koristan ako želiš izbjeći gradske prilaze.', publishDecision: 'Web update', publishReason: 'Uredno, ali korisno za usporedbu ruta.', alertRules: ['naraste preko 45 min', 'padne ispod 15 min', 'trend krene rasti'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 6, level: 'low' }, { label: 'Autocesta', minutes: 5, level: 'low' }, { label: 'BiH kontrola', minutes: 9, level: 'low' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 8, level: 'low' }, { label: 'Autocesta', minutes: 5, level: 'low' }, { label: 'HR kontrola', minutes: 13, level: 'medium' }],
    },
    cameras: [externalCamera({ id: 'svi-hak', label: 'Svilaj', url: 'https://m.hak.hr/kamera.asp?g=2&k=211' })],
    historyBase: { cars: 132, trucks: 62, buses: 7, wait: 22 }, bestDays: ['Utorak', 'Četvrtak', 'Subota ujutro'],
  }),
  makeBorderCrossing({
    id: 'izacic', shortName: 'Izačić', route: 'Ličko Petrovo Selo ↔ Izačić', area: 'Lika / USK', lat: 44.87558, lng: 15.76418,
    status: 'critical', confidence: 82, updatedAt: '14:30', fieldConfirmed: true,
    fieldNote: 'Čest kandidat za pojačan izlaz iz BiH prema HR.', cause: 'Turistički val + ulaz u EU kontrola', sponsor: 'Market Izačić', extraDriveFromMainRoute: 34,
    waits: {
      toBih: { cars: 36, trucks: 62, buses: 44, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Smjer prema BiH je pojačan, ali još prohodan.', waitAdvice: 'Može biti alternativa Maljevcu, ovisno o polazištu.', publishDecision: 'Web update', publishReason: 'Stanje je umjereno.', alertRules: ['naraste preko 60 min', 'padne ispod 25 min', 'Maljevac postane 30+ min lošiji'] },
      toHr: { cars: 78, trucks: 115, buses: 86, trend: 'rising', bottleneckSide: 'HR strana', bottleneckText: 'Glavni zastoj je na ulazu u EU, posebno u popodnevnim satima.', waitAdvice: 'Ako nisi već blizu prijelaza, provjeri alternativu.', publishDecision: 'Objavi odmah', publishReason: 'Čekanje prema HR je visoko i trend raste.', alertRules: ['padne ispod 40 min', 'naraste preko 100 min', 'alternativa postane bolja'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 10, level: 'medium' }, { label: 'Međuzona', minutes: 7, level: 'low' }, { label: 'BiH kontrola', minutes: 19, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 20, level: 'medium' }, { label: 'Međuzona', minutes: 12, level: 'medium' }, { label: 'HR kontrola', minutes: 46, level: 'high' }],
    },
    cameras: [
      externalCamera({ id: 'iza-hak-bih', label: 'BIH Izačić', url: 'https://m.hak.hr/kamera.asp?g=2&k=179' }),
      externalCamera({ id: 'iza-bihamk', label: 'Izačić / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Izačić', 'Izačić', 'Izacic'], note: 'BIHAMK popis kamera uključuje GP Izačić.' }),
    ],
    historyBase: { cars: 280, trucks: 74, buses: 18, wait: 66 }, bestDays: ['Utorak rano', 'Srijeda', 'Četvrtak prije 9h'],
  }),
  makeBorderCrossing({
    id: 'kamensko', shortName: 'Kamensko', route: 'Kamensko ↔ Tomislavgrad', area: 'Dalmacija / HBŽ', lat: 43.61124, lng: 16.97619,
    status: 'normal', confidence: 75, updatedAt: '14:22', fieldConfirmed: false,
    fieldNote: 'Planinski prilaz; važan za rute prema Tomislavgradu i Livnu.', cause: 'Sezonski promet i kontrola teretnih vozila', sponsor: 'Caffe Kamensko', extraDriveFromMainRoute: 48,
    waits: {
      toBih: { cars: 24, trucks: 48, buses: 28, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Protok je miran, bez velikog repa na prilazu.', waitAdvice: 'Dobar izbor za rute prema Livnu/Tomislavgradu.', publishDecision: 'Ne objavljivati', publishReason: 'Nema značajne gužve.', alertRules: ['naraste preko 45 min', 'kamioni prijeđu 80 min', 'trend krene rasti'] },
      toHr: { cars: 31, trucks: 56, buses: 34, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Lagani rast prema HR, ali zadržavanje je prihvatljivo.', waitAdvice: 'Provjeriti prije polaska ako je vikend.', publishDecision: 'Web update', publishReason: 'Stanje je korisno za prikaz rute.', alertRules: ['naraste preko 55 min', 'padne ispod 20 min', 'kamera pokaže rep'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 7, level: 'low' }, { label: 'Međuzona', minutes: 5, level: 'low' }, { label: 'BiH kontrola', minutes: 12, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 9, level: 'low' }, { label: 'Međuzona', minutes: 6, level: 'low' }, { label: 'HR kontrola', minutes: 16, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'kam-hak', label: 'Kamensko', url: 'https://m.hak.hr/kamera.asp?g=2&k=192' }),
      externalCamera({ id: 'kam-bihamk', label: 'Kamensko / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Kamensko', 'Kamensko'], note: 'BIHAMK popis kamera uključuje GP Kamensko.' }),
    ],
    historyBase: { cars: 145, trucks: 52, buses: 9, wait: 28 }, bestDays: ['Ponedjeljak', 'Utorak', 'Petak prije 12h'],
  }),
  makeBorderCrossing({
    id: 'prisika', shortName: 'Prisika', route: 'Aržano ↔ Prisika', area: 'Dalmacija / HBŽ', lat: 43.59485, lng: 16.98960,
    status: 'normal', confidence: 71, updatedAt: '14:19', fieldConfirmed: false,
    fieldNote: 'Manji prijelaz za lokalne i regionalne rute.', cause: 'Nema izraženog zastoja', sponsor: 'Gostionica Aržano', extraDriveFromMainRoute: 61,
    waits: {
      toBih: { cars: 18, trucks: 38, buses: 20, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Prijelaz je mirniji i često rasterećuje glavne pravce.', waitAdvice: 'Dobar ako ti ruta prirodno vodi preko Aržana.', publishDecision: 'Ne objavljivati', publishReason: 'Uredan promet.', alertRules: ['naraste preko 35 min', 'kamera pokaže kolonu', 'alternativa postane bolja'] },
      toHr: { cars: 21, trucks: 42, buses: 24, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Čekanje je nisko, ali se može brzo promijeniti vikendom.', waitAdvice: 'Krenuti ako je najkraći put.', publishDecision: 'Ne objavljivati', publishReason: 'Nema potrebe za objavom.', alertRules: ['naraste preko 40 min', 'padne ispod 10 min', 'trend krene rasti'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 5, level: 'low' }, { label: 'Međuzona', minutes: 4, level: 'low' }, { label: 'BiH kontrola', minutes: 9, level: 'low' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 6, level: 'low' }, { label: 'Međuzona', minutes: 4, level: 'low' }, { label: 'HR kontrola', minutes: 11, level: 'low' }],
    },
    cameras: [
      externalCamera({ id: 'pri-hak-arzano', label: 'Aržano', url: 'https://m.hak.hr/kamera.asp?g=2&k=193' }),
      externalCamera({ id: 'pri-hak-bih', label: 'BIH Prisika', url: 'https://m.hak.hr/kamera.asp?g=2&k=180' }),
      externalCamera({ id: 'pri-bihamk', label: 'Prisika / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Prisika (Aržano)', 'GP Prisika', 'Prisika', 'Aržano', 'Arzano'], note: 'BIHAMK popis kamera uključuje GP Prisika (Aržano).' }),
    ],
    historyBase: { cars: 110, trucks: 36, buses: 5, wait: 20 }, bestDays: ['Utorak', 'Srijeda', 'Nedjelja navečer'],
  }),
  makeBorderCrossing({
    id: 'vinjani-donji', shortName: 'Vinjani Donji', route: 'Vinjani Donji ↔ Gorica', area: 'Dalmacija / Hercegovina', lat: 43.42235, lng: 17.27500,
    status: 'busy', confidence: 76, updatedAt: '14:26', fieldConfirmed: false,
    fieldNote: 'Čest izbor za putnike prema Imotskom i Posušju.', cause: 'Sezonski promet prema Hercegovini', sponsor: 'Mjenjačnica Imotski', extraDriveFromMainRoute: 42,
    waits: {
      toBih: { cars: 37, trucks: 58, buses: 42, trend: 'rising', bottleneckSide: 'BiH strana', bottleneckText: 'Kolona prema BiH raste u poslijepodnevnim satima.', waitAdvice: 'Provjeriti prije kretanja iz Imotskog.', publishDecision: 'Pratiti', publishReason: 'Trend je u porastu.', alertRules: ['naraste preko 60 min', 'padne ispod 25 min', 'Vinjani Gornji postane bolji'] },
      toHr: { cars: 29, trucks: 52, buses: 34, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz prema HR je zasad stabilan.', waitAdvice: 'Može se koristiti ako je najbliži prijelaz.', publishDecision: 'Web update', publishReason: 'Stanje je umjereno.', alertRules: ['naraste preko 50 min', 'padne ispod 20 min', 'kamera pokaže dužu kolonu'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 10, level: 'medium' }, { label: 'Međuzona', minutes: 7, level: 'low' }, { label: 'BiH kontrola', minutes: 20, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 8, level: 'low' }, { label: 'Međuzona', minutes: 6, level: 'low' }, { label: 'HR kontrola', minutes: 15, level: 'medium' }],
    },
    cameras: [externalCamera({ id: 'vd-hak', label: 'Vinjani Donji', url: 'https://m.hak.hr/kamera.asp?g=2&k=39' })],
    historyBase: { cars: 190, trucks: 58, buses: 11, wait: 34 }, bestDays: ['Ponedjeljak', 'Četvrtak rano', 'Subota prije 8h'],
  }),
  makeBorderCrossing({
    id: 'vinjani-gornji', shortName: 'Vinjani Gornji', route: 'Vinjani Gornji ↔ Orahovlje', area: 'Dalmacija / Hercegovina', lat: 43.45945, lng: 17.28610,
    status: 'normal', confidence: 70, updatedAt: '14:18', fieldConfirmed: false,
    fieldNote: 'Manji prijelaz, koristan za usporedbu s Vinjanima Donjim.', cause: 'Lokalni promet i sezonski valovi', sponsor: 'OPG Vinjani', extraDriveFromMainRoute: 50,
    waits: {
      toBih: { cars: 24, trucks: 42, buses: 28, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Promet je mirniji nego na glavnom prijelazu.', waitAdvice: 'Dobra alternativa kad se Vinjani Donji napune.', publishDecision: 'Web update', publishReason: 'Korisno kao alternativa.', alertRules: ['naraste preko 45 min', 'padne ispod 15 min', 'postane najbolja ruta'] },
      toHr: { cars: 27, trucks: 46, buses: 30, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Čekanje je umjereno i stabilno.', waitAdvice: 'Provjeriti samo ako se očekuje vikend val.', publishDecision: 'Ne objavljivati', publishReason: 'Nema veće gužve.', alertRules: ['naraste preko 45 min', 'kamera pokaže kolonu', 'Vinjani Donji postane sporiji'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 7, level: 'low' }, { label: 'Međuzona', minutes: 5, level: 'low' }, { label: 'BiH kontrola', minutes: 12, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 8, level: 'low' }, { label: 'Međuzona', minutes: 5, level: 'low' }, { label: 'HR kontrola', minutes: 14, level: 'medium' }],
    },
    cameras: [externalCamera({ id: 'vg-hak', label: 'Vinjani Gornji', url: 'https://m.hak.hr/kamera.asp?g=2&k=282' })],
    historyBase: { cars: 142, trucks: 42, buses: 7, wait: 26 }, bestDays: ['Utorak', 'Srijeda', 'Petak prije 13h'],
  }),
  makeBorderCrossing({
    id: 'crveni-grm', shortName: 'Crveni Grm', route: 'Prolog ↔ Crveni Grm', area: 'Dalmacija / Hercegovina', lat: 43.16035, lng: 17.47755,
    status: 'normal', confidence: 73, updatedAt: '14:17', fieldConfirmed: false,
    fieldNote: 'Koristan za jug Hercegovine i alternativu Bijači.', cause: 'Promet prema Ljubuškom i sezonski povratci', sponsor: 'Restoran Ljubuški', extraDriveFromMainRoute: 46,
    waits: {
      toBih: { cars: 26, trucks: 48, buses: 30, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Prilaz prema BiH je umjeren i bez velikog zastoja.', waitAdvice: 'Može rasteretiti Bijaču ako se ona pojača.', publishDecision: 'Web update', publishReason: 'Korisno za usporedbu ruta.', alertRules: ['naraste preko 45 min', 'Bijača postane sporija', 'trend krene rasti'] },
      toHr: { cars: 33, trucks: 54, buses: 36, trend: 'rising', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz u HR lagano raste u popodnevnom periodu.', waitAdvice: 'Pratiti ako se ide prema Metkoviću ili autocesti.', publishDecision: 'Pratiti', publishReason: 'Trend prema HR raste.', alertRules: ['naraste preko 55 min', 'padne ispod 20 min', 'razlika s Bijačom prijeđe 20 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 8, level: 'low' }, { label: 'Međuzona', minutes: 6, level: 'low' }, { label: 'BiH kontrola', minutes: 12, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 10, level: 'medium' }, { label: 'Međuzona', minutes: 6, level: 'low' }, { label: 'HR kontrola', minutes: 17, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'cg-hak-bih', label: 'BIH Crveni Grm', url: 'https://m.hak.hr/kamera.asp?g=2&k=181' }),
      externalCamera({ id: 'cg-bihamk', label: 'Crveni Grm / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Crveni Grm', 'Crveni Grm'], note: 'BIHAMK popis kamera uključuje GP Crveni Grm.' }),
    ],
    historyBase: { cars: 156, trucks: 50, buses: 8, wait: 30 }, bestDays: ['Ponedjeljak', 'Srijeda', 'Nedjelja navečer'],
  }),
  // ── Additional HR↔BiH crossings (added 2026-06-23). Coords are best-effort — verify markers on deploy. ──
  makeBorderCrossing({
    id: 'gunja', shortName: 'Gunja', route: 'Gunja ↔ Brčko', area: 'Slavonija / Posavina', lat: 44.88236, lng: 18.81211,
    status: 'normal', confidence: 60, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Gunja ↔ Brčko — most preko Save, velik teretni i putnički pravac prema Brčkom/Tuzli.',
    cause: 'Tranzit prema Tuzli/Bijeljini + kamionski valovi', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 20, trucks: 50, buses: 26, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 60 min', 'padne ispod 20 min'] },
      toHr: { cars: 24, trucks: 55, buses: 30, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz u HR (EU kontrola) zna usporiti u špici.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 70 min', 'padne ispod 20 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 8, level: 'low' }, { label: 'Most (Sava)', minutes: 6, level: 'low' }, { label: 'BiH kontrola', minutes: 14, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 10, level: 'medium' }, { label: 'Most (Sava)', minutes: 6, level: 'low' }, { label: 'HR kontrola (EU)', minutes: 18, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'gun-hak-ulaz-hr', label: 'Ulaz u HR iz BiH', source: 'HAK', url: 'https://www.hak.hr/info/kamere/431.jpg' }),
      externalCamera({ id: 'gun-hak-izlaz-hr', label: 'Izlaz iz HR u BiH', source: 'HAK', url: 'https://www.hak.hr/info/kamere/432.jpg' }),
    ],
    historyBase: { cars: 190, trucks: 95, buses: 12, wait: 30 }, bestDays: ['Utorak', 'Srijeda prije 11h', 'Nedjelja navečer'],
  }),
  makeBorderCrossing({
    id: 'dvor', shortName: 'Dvor', route: 'Dvor ↔ Novi Grad', area: 'Banovina / Pounje', lat: 45.0606, lng: 16.3739,
    status: 'normal', confidence: 58, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Dvor na Uni ↔ Novi Grad (Bos. Novi) — glavni pravac Zagreb→Bihać/Banja Luka, most preko Une.',
    cause: 'Tranzit prema Bihaću/Banja Luci', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 18, trucks: 42, buses: 22, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 55 min', 'padne ispod 20 min'] },
      toHr: { cars: 22, trucks: 48, buses: 26, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz u HR (EU kontrola) povremeno usporava.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 65 min', 'padne ispod 20 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 7, level: 'low' }, { label: 'Most (Una)', minutes: 5, level: 'low' }, { label: 'BiH kontrola', minutes: 12, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 9, level: 'low' }, { label: 'Most (Una)', minutes: 5, level: 'low' }, { label: 'HR kontrola (EU)', minutes: 16, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'dvo-rs-in', label: 'Ulaz u Republiku Srpsku', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_10_GP_NG02/slika.jpg' }),
      externalCamera({ id: 'dvo-rs-out', label: 'Izlaz iz Republike Srpske', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_10_GP_NG01/slika.jpg' }),
    ],
    historyBase: { cars: 150, trucks: 70, buses: 10, wait: 24 }, bestDays: ['Ponedjeljak', 'Srijeda', 'Subota ujutro'],
  }),
  makeBorderCrossing({
    id: 'hrv-kostajnica', shortName: 'Hrv. Kostajnica', route: 'Hrvatska Kostajnica ↔ Bosanska Kostajnica', area: 'Banovina / Pounje', lat: 45.22029, lng: 16.54710,
    status: 'open', confidence: 55, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Hrvatska ↔ Bosanska Kostajnica — most preko Une, lokalni i regionalni promet.',
    cause: 'Lokalni i regionalni promet uz Unu', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 12, trucks: 28, buses: 16, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 40 min', 'padne ispod 10 min'] },
      toHr: { cars: 15, trucks: 32, buses: 18, trend: 'steady', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz u HR (EU kontrola) obično prohodan.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 45 min', 'padne ispod 10 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 5, level: 'low' }, { label: 'Most (Una)', minutes: 4, level: 'low' }, { label: 'BiH kontrola', minutes: 9, level: 'low' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 6, level: 'low' }, { label: 'Most (Una)', minutes: 4, level: 'low' }, { label: 'HR kontrola (EU)', minutes: 12, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'kos-rs-in', label: 'Ulaz u Republiku Srpsku', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_11_GP_KO02/slika.jpg' }),
      externalCamera({ id: 'kos-rs-out', label: 'Izlaz iz Republike Srpske', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_11_GP_KO01/slika.jpg' }),
    ],
    historyBase: { cars: 90, trucks: 30, buses: 6, wait: 16 }, bestDays: ['Ponedjeljak', 'Četvrtak', 'Subota ujutro'],
  }),
  makeBorderCrossing({
    id: 'metkovic', shortName: 'Metković', route: 'Metković ↔ Doljani', area: 'Dalmacija / Hercegovina', lat: 43.05058, lng: 17.66137,
    status: 'normal', confidence: 60, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Metković ↔ Doljani — pravac prema Mostaru/Sarajevu, velik ljetni promet (dolina Neretve).',
    cause: 'Sezonski tranzit prema Mostaru/Sarajevu', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 20, trucks: 40, buses: 24, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 55 min', 'padne ispod 20 min'] },
      toHr: { cars: 26, trucks: 48, buses: 30, trend: 'rising', bottleneckSide: 'HR strana', bottleneckText: 'Ulaz u HR (EU kontrola) ljeti zna stvarati duže repove.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 70 min', 'padne ispod 20 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz HR', minutes: 7, level: 'low' }, { label: 'Međuzona', minutes: 5, level: 'low' }, { label: 'BiH kontrola', minutes: 13, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 10, level: 'medium' }, { label: 'Međuzona', minutes: 6, level: 'low' }, { label: 'HR kontrola (EU)', minutes: 18, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'met-hak-ulaz-hr', label: 'Ulaz u HR iz BiH', source: 'HAK', url: 'https://www.hak.hr/info/kamere/319.jpg' }),
      externalCamera({ id: 'met-hak-izlaz-hr', label: 'Izlaz iz HR u BiH', source: 'HAK', url: 'https://www.hak.hr/info/kamere/321.jpg' }),
    ],
    historyBase: { cars: 170, trucks: 60, buses: 14, wait: 28 }, bestDays: ['Utorak', 'Četvrtak prije 10h', 'Nedjelja navečer'],
  }),
  // ── BiH ↔ Serbia / Montenegro (BIHAMK-sourced). `neighbor` drives the displayed direction labels. ──
  makeBorderCrossing({
    id: 'sepak', shortName: 'Šepak', route: 'Trbušnica ↔ Šepak', area: 'Semberija / Podrinje', lat: 44.54072, lng: 19.18474, neighbor: 'RS',
    status: 'busy', confidence: 58, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Šepak ↔ Trbušnica — glavni pravac Beograd–Sarajevo. Pratimo BIHAMK izvor i kameru.',
    cause: 'Tranzitni promet Beograd–Sarajevo + kamionski valovi', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 22, trucks: 55, buses: 28, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora i kamere.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 60 min', 'padne ispod 20 min'] },
      toHr: { cars: 26, trucks: 60, buses: 32, trend: 'steady', bottleneckSide: 'Srbija strana', bottleneckText: 'Ulaz u Srbiju zna usporiti u špici.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 60 min', 'padne ispod 20 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz Srbija', minutes: 8, level: 'low' }, { label: 'Most (Drina)', minutes: 6, level: 'low' }, { label: 'BiH kontrola', minutes: 14, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 10, level: 'medium' }, { label: 'Most (Drina)', minutes: 6, level: 'low' }, { label: 'Srbija kontrola', minutes: 16, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'sep-rs-in', label: 'Ulaz u Republiku Srpsku', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_06_GP_SP02/slika.jpg' }),
      externalCamera({ id: 'sep-rs-out', label: 'Izlaz iz Republike Srpske', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_06_GP_SP01/slika.jpg' }),
      externalCamera({ id: 'sep-bihamk', label: 'Šepak / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Šepak', 'Šepak', 'Sepak', 'Šepak - Loznica'], note: 'BIHAMK popis kamera uključuje GP Šepak.' }),
    ],
    historyBase: { cars: 180, trucks: 90, buses: 12, wait: 28 }, bestDays: ['Utorak', 'Srijeda prije 11h', 'Nedjelja navečer'],
  }),
  makeBorderCrossing({
    id: 'raca', shortName: 'B. Rača', route: 'Sremska Rača ↔ Bosanska Rača', area: 'Semberija / Srijem', lat: 44.91142, lng: 19.29694, neighbor: 'RS',
    status: 'busy', confidence: 58, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Bosanska Rača ↔ Sremska Rača — najveći prijelaz prema Srbiji, most preko Save.',
    cause: 'Glavni tranzit prema Srbiji i koridor Vc', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 24, trucks: 60, buses: 30, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 70 min', 'padne ispod 25 min'] },
      toHr: { cars: 30, trucks: 70, buses: 38, trend: 'rising', bottleneckSide: 'Srbija strana', bottleneckText: 'Ulaz u Srbiju u špici zna stvarati duže repove.', waitAdvice: 'Provjeri live izvor prije polaska.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 80 min', 'padne ispod 25 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz Srbija', minutes: 9, level: 'low' }, { label: 'Most (Sava)', minutes: 7, level: 'low' }, { label: 'BiH kontrola', minutes: 16, level: 'medium' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 12, level: 'medium' }, { label: 'Most (Sava)', minutes: 7, level: 'low' }, { label: 'Srbija kontrola', minutes: 20, level: 'medium' }],
    },
    cameras: [
      externalCamera({ id: 'rac-rs-in', label: 'Ulaz u Republiku Srpsku', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_02_GP_RA02/slika.jpg' }),
      externalCamera({ id: 'rac-rs-out', label: 'Izlaz iz Republike Srpske', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_02_GP_RA01/slika.jpg' }),
    ],
    historyBase: { cars: 220, trucks: 110, buses: 16, wait: 34 }, bestDays: ['Utorak', 'Četvrtak prije 11h', 'Nedjelja navečer'],
  }),
  makeBorderCrossing({
    id: 'hum', shortName: 'Hum', route: 'Šćepan Polje ↔ Hum', area: 'Hercegovina / Pivska planina', lat: 43.34905, lng: 18.84489, neighbor: 'CG',
    status: 'open', confidence: 55, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Hum ↔ Šćepan Polje — planinski prijelaz prema Crnoj Gori (rafting/turistički pravac).',
    cause: 'Sezonski turistički promet prema Crnoj Gori', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 14, trucks: 30, buses: 18, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora.', waitAdvice: 'Mali prijelaz, ljeti zna biti gužve.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 40 min', 'padne ispod 15 min'] },
      toHr: { cars: 16, trucks: 34, buses: 20, trend: 'steady', bottleneckSide: 'Crna Gora strana', bottleneckText: 'Ulaz u Crnu Goru ljeti zna usporiti.', waitAdvice: 'Mali prijelaz, ljeti zna biti gužve.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 40 min', 'padne ispod 15 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz CG', minutes: 6, level: 'low' }, { label: 'Most', minutes: 4, level: 'low' }, { label: 'BiH kontrola', minutes: 10, level: 'low' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 7, level: 'low' }, { label: 'Most', minutes: 4, level: 'low' }, { label: 'CG kontrola', minutes: 12, level: 'medium' }],
    },
    cameras: [
      // Crna Gora ima živu MUP kameru, ali kao HLS video stream (ne sliku koju možemo proxati/analizirati)
      // → vanjski "otvori uživo" link. Šćepan Polje preglednik (ulaz + izlaz).
      { id: 'hum-mne-scepan', label: 'Live kamere — Šćepan Polje (Crna Gora / MUP)', source: 'MNE MUP', status: 'live video (vanjski izvor)', external: true, externalUrl: 'http://kamere.mup.gov.me/kamere.php?kamere=Scepan_polje' },
    ],
    historyBase: { cars: 90, trucks: 20, buses: 10, wait: 18 }, bestDays: ['Ponedjeljak', 'Srijeda', 'Nedjelja prije podne'],
  }),
  makeBorderCrossing({
    id: 'deleusa', shortName: 'Deleuša', route: 'Vraćenovići ↔ Deleuša', area: 'Istočna Hercegovina', lat: 42.86194, lng: 18.47980, neighbor: 'CG',
    status: 'open', confidence: 52, updatedAt: 'live', fieldConfirmed: false,
    fieldNote: 'Deleuša ↔ Vraćenovići — prijelaz na pravcu Bileća–Nikšić prema Crnoj Gori.',
    cause: 'Lokalni i tranzitni promet Bileća–Nikšić', sponsor: '', extraDriveFromMainRoute: 0,
    waits: {
      toBih: { cars: 12, trucks: 26, buses: 15, trend: 'steady', bottleneckSide: 'BiH strana', bottleneckText: 'Procjena iz BIHAMK izvora.', waitAdvice: 'Manji prijelaz; provjeri live izvor.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 35 min', 'padne ispod 12 min'] },
      toHr: { cars: 14, trucks: 30, buses: 18, trend: 'steady', bottleneckSide: 'Crna Gora strana', bottleneckText: 'Ulaz u Crnu Goru zna usporiti.', waitAdvice: 'Manji prijelaz; provjeri live izvor.', publishDecision: 'Pratiti', publishReason: 'Koristi live izvor.', alertRules: ['naraste preko 35 min', 'padne ispod 12 min'] },
    },
    segments: {
      toBih: [{ label: 'Prilaz CG', minutes: 5, level: 'low' }, { label: 'Međuzona', minutes: 3, level: 'low' }, { label: 'BiH kontrola', minutes: 9, level: 'low' }],
      toHr: [{ label: 'Prilaz BiH', minutes: 6, level: 'low' }, { label: 'Međuzona', minutes: 3, level: 'low' }, { label: 'CG kontrola', minutes: 11, level: 'medium' }],
    },
    cameras: [
      // Crna Gora MUP živa kamera = HLS video stream (ne slika) → vanjski "otvori uživo" link.
      { id: 'deleusa-mne-vracenovici', label: 'Live kamere — Vraćenovići (Crna Gora / MUP)', source: 'MNE MUP', status: 'live video (vanjski izvor)', external: true, externalUrl: 'http://kamere.mup.gov.me/kamere.php?kamere=Vracenovici' },
    ],
    historyBase: { cars: 70, trucks: 16, buses: 8, wait: 15 }, bestDays: ['Ponedjeljak', 'Srijeda', 'Nedjelja prije podne'],
  }),
];

const CROSSINGS = [
  {
    id: 'maljevac',
    name: 'GP Maljevac',
    shortName: 'Maljevac',
    route: 'Cetingrad ↔ Velika Kladuša',
    area: 'Karlovačka / USK',
    // marker je poravnat s kalibriranom točkom prijelaza koju backend koristi za rutu
    lat: 45.19583,
    lng: 15.79639,
    status: 'busy',
    confidence: 62,
    updatedAt: 'live',
    fieldConfirmed: false,
    fieldConfirmedAt: '',
    fieldNote: 'Čekanje se puni iz javnih izvora, kamera, izmjerenih prelazaka ili potvrde tima.',
    cause: 'Live procjena iz javnih izvora + kamera/izmjerenih prelazaka kada su dostupni',
    sponsor: 'Mjenjačnica Kordun',
    extraDriveFromMainRoute: 0,
    directions: {
      toBih: {
        label: 'HR → BiH',
        cars: 23,
        trucks: 55,
        buses: 32,
        trend: 'steady',
        bottleneckSide: 'BiH strana',
        bottleneckText: 'Procjena se ažurira iz BIHAMK/AMS/kamera/izmjerenih prelazaka ili potvrde tima.',
        waitAdvice: 'Provjeriti live izvor prije odluke o alternativi.',
        publishDecision: 'Pratiti',
        publishReason: 'Za javnu objavu koristi live izvor ili potvrdu tima.',
        alertRules: ['padne ispod 30 min', 'naraste preko 90 min', 'alternativa postane bolja'],
        segments: [
          { label: 'Prilaz HR', minutes: 5, level: 'low' },
          { label: 'Međuzona', minutes: 4, level: 'low' },
          { label: 'BiH kontrola', minutes: 14, level: 'medium' },
        ],
      },
      toHr: {
        label: 'BiH → HR',
        cars: 48,
        trucks: 90,
        buses: 60,
        trend: 'steady',
        bottleneckSide: 'HR strana',
        bottleneckText: 'Kolona se stvara prije HR kontrole.',
        waitAdvice: 'Može se pratiti još 20–30 min prije odluke.',
        publishDecision: 'Web update',
        publishReason: 'Stanje je pojačano, ali dovoljno je ažurirati web prikaz.',
        alertRules: ['padne ispod 25 min', 'naraste preko 60 min', 'trend krene rasti'],
        segments: [
          { label: 'Prilaz BiH', minutes: 10, level: 'low' },
          { label: 'Međuzona', minutes: 8, level: 'low' },
          { label: 'HR kontrola', minutes: 30, level: 'high' },
        ],
      },
    },
    cameras: [
      {
        id: 'mal-hak-hr-entry',
        label: 'Ulaz u HR iz BiH',
        source: 'HAK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://www.hak.hr/info/kamere/429.jpg',
        externalUrl: 'https://gpmaljevac.com/granicni-prijelaz-maljevac/',
        note: 'Direktna slika iz javno prikazane HAK kamere. Ako HAK prikaže “slika nije dostupna”, aplikacija prikazuje isto stanje kao izvor.',
      },
      {
        id: 'mal-hak-hr-exit',
        label: 'Izlaz iz HR u BiH',
        source: 'HAK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://www.hak.hr/info/kamere/430.jpg',
        externalUrl: 'https://gpmaljevac.com/granicni-prijelaz-maljevac/',
        note: 'Druga HAK kamera za smjer prema BiH. Slika se osvježava prilikom pregleda.',
      },
      {
        id: 'mal-bihamk-kladusa',
        label: 'Velika Kladuša',
        source: 'BIHAMK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://video-nadzor.bihamk.ba/videosurveillence/AUTOBHS.jpg',
        externalUrl: 'https://gpmaljevac.com/granicni-prijelaz-maljevac/',
        note: 'BiH strana iz javno prikazanog izvora. Korisno za potvrdu prilaza prema prijelazu.',
      },
    ],
    history: [
      { hour: '06', cars: 120, trucks: 34, buses: 8, wait: 22 },
      { hour: '09', cars: 210, trucks: 49, buses: 14, wait: 38 },
      { hour: '12', cars: 310, trucks: 70, buses: 20, wait: 55 },
      { hour: '15', cars: 420, trucks: 88, buses: 28, wait: 75 },
      { hour: '18', cars: 370, trucks: 62, buses: 19, wait: 64 },
      { hour: '22', cars: 180, trucks: 45, buses: 7, wait: 30 },
    ],
    bestDays: ['Utorak', 'Srijeda', 'Četvrtak ujutro'],
  },
  {
    id: 'gradiska',
    name: 'GP Gradiška',
    shortName: 'Gradiška',
    route: 'Stara Gradiška ↔ Gradiška',
    area: 'Slavonija / Posavina',
    lat: 45.14530,
    lng: 17.25210,
    status: 'busy',
    confidence: 79,
    updatedAt: '14:31',
    fieldConfirmed: true,
    fieldConfirmedAt: 'prije 14 min',
    fieldNote: 'Osobna vozila prolaze brže od kamiona.',
    cause: 'Kamionska traka sporija',
    sponsor: 'Autopraonica Sava',
    extraDriveFromMainRoute: 28,
    directions: {
      toBih: {
        label: 'HR → BiH', cars: 32, trucks: 65, buses: 42, trend: 'falling', bottleneckSide: 'BiH strana',
        bottleneckText: 'Osobna vozila idu solidno, kamioni sporije.', waitAdvice: 'Isplati se kao alternativa ako ti obilazak nije velik.',
        publishDecision: 'Objavi kao alternativu', publishReason: 'Maljevac je lošiji, a Gradiška može uštedjeti vrijeme.',
        alertRules: ['padne ispod 20 min', 'naraste preko 45 min', 'Maljevac bude 30+ min lošiji'],
        segments: [{ label: 'Prilaz HR', minutes: 9, level: 'low' }, { label: 'Međuzona', minutes: 7, level: 'low' }, { label: 'BiH kontrola', minutes: 16, level: 'medium' }],
      },
      toHr: {
        label: 'BiH → HR', cars: 40, trucks: 80, buses: 55, trend: 'steady', bottleneckSide: 'HR strana',
        bottleneckText: 'Usporavanje je na HR kontroli.', waitAdvice: 'Ako nisi u žurbi, pričekaj kratki update.',
        publishDecision: 'Web update', publishReason: 'Nema velike promjene za hitan post.',
        alertRules: ['padne ispod 25 min', 'naraste preko 55 min', 'trend krene rasti'],
        segments: [{ label: 'Prilaz BiH', minutes: 12, level: 'medium' }, { label: 'Međuzona', minutes: 8, level: 'low' }, { label: 'HR kontrola', minutes: 20, level: 'medium' }],
      },
    },
    cameras: [
      {
        id: 'gra-hak-page',
        label: 'Bosanska Gradiška / HAK',
        source: 'HAK direktna slika',
        status: 'javna slika kroz aplikaciju',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=185',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=185',
        note: 'HAK slika za GP Bosanska Gradiška učitava se kroz proxy.',
      },
      {
        id: 'gra-rs-in',
        label: 'Ulaz u Republiku Srpsku',
        source: 'AMS RS',
        status: 'aktivna javna slika',
        type: 'image',
        url: 'https://gp.satwork.net/AMSRS_17_GP_CA02/slika.jpg',
        externalUrl: 'https://ams-rs.com/en/granicni-prelaz-gradiska/',
        note: 'AMS RS kamera; slika se osvježava u aplikaciji cache-busting parametrom.',
      },
      {
        id: 'gra-rs-out',
        label: 'Izlaz iz Republike Srpske',
        source: 'AMS RS',
        status: 'aktivna javna slika',
        type: 'image',
        url: 'https://gp.satwork.net/AMSRS_17_GP_CA01/slika.jpg',
        externalUrl: 'https://ams-rs.com/en/granicni-prelaz-gradiska/',
        note: 'AMS RS kamera; slika se osvježava u aplikaciji cache-busting parametrom.',
      },
    ],
    history: [
      { hour: '06', cars: 90, trucks: 42, buses: 5, wait: 18 },
      { hour: '09', cars: 170, trucks: 66, buses: 9, wait: 26 },
      { hour: '12', cars: 260, trucks: 94, buses: 14, wait: 32 },
      { hour: '15', cars: 330, trucks: 120, buses: 21, wait: 45 },
      { hour: '18', cars: 290, trucks: 105, buses: 16, wait: 40 },
      { hour: '22', cars: 130, trucks: 60, buses: 6, wait: 22 },
    ],
    bestDays: ['Ponedjeljak navečer', 'Srijeda', 'Subota rano'],
  },

  {
    id: 'gornji-varos',
    name: 'GP Gornji Varoš',
    shortName: 'Gornji Varoš',
    route: 'Gornji Varoš ↔ Gradiška Novi Most',
    area: 'Brod-Posavina / Posavina',
    // Real crossing position (OSM): state border mid-Sava on the new D5/E-661 bridge.
    lat: 45.14930,
    lng: 17.20450,
    status: 'busy',
    confidence: 84,
    updatedAt: '14:34',
    fieldConfirmed: true,
    fieldConfirmedAt: 'prije 9 min',
    fieldNote: 'Novi prijelaz na autocestovnom mostu; čekanje se puni iz javnih izvora i kamera.',
    cause: 'Razdvajanje kolona po dokumentima + kamionski valovi nakon otvaranja smjera',
    sponsor: 'Servis Posavina',
    extraDriveFromMainRoute: 18,
    directions: {
      toBih: {
        label: 'HR → BiH',
        cars: 42,
        trucks: 74,
        buses: 48,
        trend: 'steady',
        bottleneckSide: 'BiH strana',
        bottleneckText: 'Kolona prema BiH najviše se stvara u desnim zonama kontrole i povremeno se prelijeva prema prilazu.',
        waitAdvice: 'Dobar rasteretni prijelaz za Gradišku; provjeri live izvor prije odluke.',
        publishDecision: 'Web update',
        publishReason: 'Čekanje je pojačano, ali smjer još ima protočne intervale.',
        alertRules: ['naraste preko 70 min', 'padne ispod 25 min', 'kamionska traka blokira prilaz'],
        segments: [
          { label: 'Prilaz HR', minutes: 11, level: 'medium' },
          { label: 'Kontrola HR', minutes: 12, level: 'medium' },
          { label: 'BiH kontrola', minutes: 19, level: 'medium' },
        ],
      },
      toHr: {
        label: 'BiH → HR',
        cars: 56,
        trucks: 96,
        buses: 63,
        trend: 'rising',
        bottleneckSide: 'HR strana',
        bottleneckText: 'Ulaz u HR (Schengen) ima detaljniju kontrolu putnika i dokumenata, pa kolona zna rasti u popodnevnim satima.',
        waitAdvice: 'Provjeri live izvor i kameru prije polaska prema HR.',
        publishDecision: 'Pratiti',
        publishReason: 'Trend prema HR raste; koristi live izvor.',
        alertRules: ['naraste preko 90 min', 'padne ispod 40 min', 'protok padne ispod 40 voz/h'],
        segments: [
          { label: 'Prilaz BiH', minutes: 15, level: 'medium' },
          { label: 'Međuzona', minutes: 9, level: 'low' },
          { label: 'HR kontrola', minutes: 32, level: 'high' },
        ],
      },
    },
    cameras: [
      {
        id: 'gv-hak-queue-9',
        label: 'Gornji Varoš · kamera 9',
        source: 'HAK direktna slika',
        imageIndex: 0,
        status: 'javna slika kroz aplikaciju',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=303',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=303',
        previewImage: '/camera-snapshots/gornji-varos-hak.png',
        note: 'HAK kamera za Gornji Varoš — prikaz cijele zone kontrole.',
      },
      {
        id: 'gv-hak-plaza-4',
        label: 'Gornji Varoš · zona kontrole',
        source: 'HAK direktna slika',
        imageIndex: 1,
        status: 'javna slika kroz aplikaciju',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=303',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=303',
        previewImage: '/camera-snapshots/gornji-varos-hak.png',
        note: 'Drugi kadar istog prijelaza — zona kontrole.',
      },
    ],
    history: [
      { hour: '06', cars: 86, trucks: 38, buses: 5, wait: 16 },
      { hour: '09', cars: 185, trucks: 62, buses: 10, wait: 29 },
      { hour: '12', cars: 248, trucks: 92, buses: 15, wait: 38 },
      { hour: '15', cars: 330, trucks: 118, buses: 22, wait: 54 },
      { hour: '18', cars: 305, trucks: 106, buses: 17, wait: 48 },
      { hour: '22', cars: 118, trucks: 55, buses: 6, wait: 24 },
    ],
    bestDays: ['Ponedjeljak rano', 'Srijeda', 'Četvrtak prije 10h'],
  },
  {
    id: 'bijaca',
    name: 'GP Bijača',
    shortName: 'Bijača',
    route: 'Nova Sela ↔ Bijača',
    area: 'Dalmacija / Hercegovina',
    lat: 43.12340,
    lng: 17.56780,
    status: 'normal',
    confidence: 74,
    updatedAt: '14:29',
    fieldConfirmed: false,
    fieldConfirmedAt: 'nije potvrđeno',
    fieldNote: 'Trenutno samo prometni signal i povijesni uzorak.',
    cause: 'Nema izraženog zastoja',
    sponsor: 'Restoran Hercegovina',
    extraDriveFromMainRoute: 52,
    directions: {
      toBih: {
        label: 'HR → BiH', cars: 18, trucks: 35, buses: 20, trend: 'steady', bottleneckSide: 'Nema zastoja', bottleneckText: 'Sva tri segmenta su uredna.',
        waitAdvice: 'Nema potrebe čekati. Može se krenuti.', publishDecision: 'Ne objavljivati', publishReason: 'Nema značajne gužve. Dovoljno za web prikaz.',
        alertRules: ['naraste preko 35 min', 'trend krene rasti', 'alternativa se pogorša'],
        segments: [{ label: 'Prilaz HR', minutes: 5, level: 'low' }, { label: 'Međuzona', minutes: 4, level: 'low' }, { label: 'BiH kontrola', minutes: 9, level: 'low' }],
      },
      toHr: {
        label: 'BiH → HR', cars: 24, trucks: 45, buses: 24, trend: 'rising', bottleneckSide: 'HR strana', bottleneckText: 'Lagani rast prema HR, ali nije kritično.',
        waitAdvice: 'Krenuti sada ako si blizu prijelaza.', publishDecision: 'Pratiti', publishReason: 'Trend raste, ali čekanje je još prihvatljivo.',
        alertRules: ['padne ispod 15 min', 'naraste preko 45 min', 'trend se ubrza'],
        segments: [{ label: 'Prilaz BiH', minutes: 7, level: 'low' }, { label: 'Međuzona', minutes: 5, level: 'low' }, { label: 'HR kontrola', minutes: 12, level: 'medium' }],
      },
    },
    cameras: [
      {
        id: 'bij-hak-ulaz-hr',
        label: 'Nova Sela / Bijača · ulaz u HR',
        source: 'HAK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=137',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=137',
        note: 'Proxy koristi stvarnu HAK JPEG sliku 201, jer grupna stranica k=137 ne odgovara direktnom JPG-u 137.',
      },
      {
        id: 'bij-hak-izlaz-hr',
        label: 'Nova Sela / Bijača · izlaz iz HR',
        source: 'HAK direktna slika',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://m.hak.hr/kamera.asp?g=2&k=137',
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=137',
        note: 'Proxy koristi stvarnu HAK JPEG sliku 202, jer grupna stranica k=137 ne odgovara direktnom JPG-u 138.',
      },
      {
        id: 'bij-bihamk-page',
        label: 'Bijača / BIHAMK',
        source: 'BIHAMK',
        status: 'aktivna slika iz javnog izvora',
        type: 'image',
        url: 'https://bihamk.ba/spi/kamere',
        externalUrl: 'https://bihamk.ba/spi/kamere',
        matchTexts: ['GP Bijača', 'Bijača', 'Bijaca'],
        note: 'BIHAMK popis kamera uključuje GP Bijača. Backend traži Bijaču u listi kamera.',
      },
    ],
    history: [
      { hour: '06', cars: 60, trucks: 22, buses: 3, wait: 8 },
      { hour: '09', cars: 110, trucks: 34, buses: 5, wait: 12 },
      { hour: '12', cars: 160, trucks: 48, buses: 7, wait: 18 },
      { hour: '15', cars: 210, trucks: 62, buses: 10, wait: 24 },
      { hour: '18', cars: 190, trucks: 52, buses: 8, wait: 20 },
      { hour: '22', cars: 80, trucks: 30, buses: 3, wait: 10 },
    ],
    bestDays: ['Ponedjeljak', 'Utorak', 'Četvrtak navečer'],
  },
  ...ADDITIONAL_CROSSINGS,
];

const TABS_USER = ['Pregled', 'Moj put', 'Mapa', 'Povijest'];
const TABS_ADMIN = ['Pregled', 'Moj put', 'Mapa', 'Povijest', 'Admin'];

const NAV_META = {
  Pregled: { label: 'Pregled', hint: 'čekanja uživo' },
  'Moj put': { label: 'Moj put', hint: 'najbolji izbor' },
  Mapa: { label: 'Karta', hint: 'rute i kamere' },
  Povijest: { label: 'Prošlost', hint: 'kada krenuti' },
  Admin: { label: 'Uredi stanje', hint: 'za tim' },
};

const NAV_ICONS = {
  Pregled: ShieldCheck,
  'Moj put': Navigation,
  Mapa: MapPin,
  Povijest: Clock,
  Admin: User,
};

const MEASUREMENT_ZONES = {
  maljevac: {
    toBih: { from: 'Maljevac · HR prilaz kontroli', via: 'GP Maljevac', to: 'BiH izlaz iz kontrole' },
    toHr: { from: 'BiH prilaz kontroli', via: 'GP Maljevac', to: 'Maljevac · HR izlaz iz kontrole' },
  },
  gradiska: {
    toBih: { from: 'Stara Gradiška · HR prilaz', via: 'GP Gradiška', to: 'Gradiška · BiH izlaz' },
    toHr: { from: 'Gradiška · BiH prilaz', via: 'GP Gradiška', to: 'Stara Gradiška · HR izlaz' },
  },
  'gornji-varos': {
    toBih: { from: 'Gornji Varoš · HR prilaz', via: 'GP Gornji Varoš', to: 'Gradiška Novi Most · BiH izlaz' },
    toHr: { from: 'Gradiška Novi Most · BiH prilaz', via: 'GP Gornji Varoš', to: 'Gornji Varoš · HR izlaz' },
  },
  bijaca: {
    toBih: { from: 'Nova Sela · HR prilaz', via: 'GP Bijača', to: 'Bijača · BiH izlaz' },
    toHr: { from: 'Bijača · BiH prilaz', via: 'GP Bijača', to: 'Nova Sela · HR izlaz' },
  },

  orasje: {
    toBih: { from: 'Županja · HR prilaz', via: 'GP Orašje', to: 'Orašje · BiH izlaz' },
    toHr: { from: 'Orašje · BiH prilaz', via: 'GP Orašje', to: 'Županja · HR izlaz' },
  },
  brod: {
    toBih: { from: 'Slavonski Brod · HR prilaz', via: 'GP Brod', to: 'Brod · BiH izlaz' },
    toHr: { from: 'Brod · BiH prilaz', via: 'GP Brod', to: 'Slavonski Brod · HR izlaz' },
  },
  samac: {
    toBih: { from: 'Slavonski Šamac · HR prilaz', via: 'GP Šamac', to: 'Šamac · BiH izlaz' },
    toHr: { from: 'Šamac · BiH prilaz', via: 'GP Šamac', to: 'Slavonski Šamac · HR izlaz' },
  },
  svilaj: {
    toBih: { from: 'Svilaj · HR prilaz', via: 'GP Svilaj', to: 'Odžak · BiH izlaz' },
    toHr: { from: 'Odžak · BiH prilaz', via: 'GP Svilaj', to: 'Svilaj · HR izlaz' },
  },
  izacic: {
    toBih: { from: 'Ličko Petrovo Selo · HR prilaz', via: 'GP Izačić', to: 'Izačić · BiH izlaz' },
    toHr: { from: 'Izačić · BiH prilaz', via: 'GP Izačić', to: 'Ličko Petrovo Selo · HR izlaz' },
  },
  kamensko: {
    toBih: { from: 'Kamensko · HR prilaz', via: 'GP Kamensko', to: 'Tomislavgrad · BiH izlaz' },
    toHr: { from: 'Tomislavgrad · BiH prilaz', via: 'GP Kamensko', to: 'Kamensko · HR izlaz' },
  },
  prisika: {
    toBih: { from: 'Aržano · HR prilaz', via: 'GP Prisika', to: 'Prisika · BiH izlaz' },
    toHr: { from: 'Prisika · BiH prilaz', via: 'GP Prisika', to: 'Aržano · HR izlaz' },
  },
  'vinjani-donji': {
    toBih: { from: 'Vinjani Donji · HR prilaz', via: 'GP Vinjani Donji', to: 'Gorica · BiH izlaz' },
    toHr: { from: 'Gorica · BiH prilaz', via: 'GP Vinjani Donji', to: 'Vinjani Donji · HR izlaz' },
  },
  'vinjani-gornji': {
    toBih: { from: 'Vinjani Gornji · HR prilaz', via: 'GP Vinjani Gornji', to: 'Orahovlje · BiH izlaz' },
    toHr: { from: 'Orahovlje · BiH prilaz', via: 'GP Vinjani Gornji', to: 'Vinjani Gornji · HR izlaz' },
  },
  'crveni-grm': {
    toBih: { from: 'Prolog · HR prilaz', via: 'GP Crveni Grm', to: 'Crveni Grm · BiH izlaz' },
    toHr: { from: 'Crveni Grm · BiH prilaz', via: 'GP Crveni Grm', to: 'Prolog · HR izlaz' },
  },
};

const VEHICLE_LABELS = {
  car: 'Osobno vozilo',
  van: 'Kombi',
  truck: 'Kamion',
  bus: 'Autobus',
};

const LANE_GROUP_LABELS = {
  eu: { label: 'EU kolona', short: 'EU', helper: 'EU / EEA / CH dokumenti' },
  nonEu: { label: 'Non‑EU kolona', short: 'Non‑EU', helper: 'sve ostale putovnice' },
};

function normalizeVehicleCounts(raw = {}) {
  return {
    cars: Math.max(0, Number(raw.cars ?? raw.car ?? 0) || 0),
    vans: Math.max(0, Number(raw.vans ?? raw.van ?? 0) || 0),
    trucks: Math.max(0, Number(raw.trucks ?? raw.truck ?? 0) || 0),
    buses: Math.max(0, Number(raw.buses ?? raw.bus ?? 0) || 0),
  };
}

function totalVehicleCounts(counts = {}) {
  const normalized = normalizeVehicleCounts(counts);
  return normalized.cars + normalized.vans + normalized.trucks + normalized.buses;
}

function splitVehicleCounts(counts = {}, share = 0.5) {
  const normalized = normalizeVehicleCounts(counts);
  const first = {
    cars: Math.max(0, Math.round(normalized.cars * share)),
    vans: Math.max(0, Math.round(normalized.vans * share)),
    trucks: Math.max(0, Math.round(normalized.trucks * share)),
    buses: Math.max(0, Math.round(normalized.buses * share)),
  };
  return [first, {
    cars: Math.max(0, normalized.cars - first.cars),
    vans: Math.max(0, normalized.vans - first.vans),
    trucks: Math.max(0, normalized.trucks - first.trucks),
    buses: Math.max(0, normalized.buses - first.buses),
  }];
}

function buildLaneGroups(frame, passed15, wait, confidence, calibration, direction) {
  const profile = calibration?.profiles?.[direction] || { eu: direction === 'toHr' ? 0.38 : 0.48, nonEu: direction === 'toHr' ? 0.62 : 0.52, euWait: 0.86, nonEuWait: 1.16 };
  const euShare = Math.max(0.2, Math.min(0.8, Number(profile.eu ?? 0.45)));
  const [euCounts, nonEuCounts] = splitVehicleCounts(frame, euShare);
  const passedEu = Math.max(0, Math.round((passed15 || 0) * euShare));
  const passedNonEu = Math.max(0, (passed15 || 0) - passedEu);
  const totalFrame = Math.max(1, totalVehicleCounts(frame));

  return {
    eu: {
      key: 'eu',
      ...LANE_GROUP_LABELS.eu,
      counts: euCounts,
      visibleTotal: totalVehicleCounts(euCounts),
      share: Math.round((totalVehicleCounts(euCounts) / totalFrame) * 100),
      passed15: passedEu,
      wait: Math.max(3, Math.round((wait || 0) * Number(profile.euWait ?? 0.86))),
      confidence: Math.min(98, Math.max(55, Math.round((confidence || 80) + 3))),
    },
    nonEu: {
      key: 'nonEu',
      ...LANE_GROUP_LABELS.nonEu,
      counts: nonEuCounts,
      visibleTotal: totalVehicleCounts(nonEuCounts),
      share: Math.round((totalVehicleCounts(nonEuCounts) / totalFrame) * 100),
      passed15: passedNonEu,
      wait: Math.max(3, Math.round((wait || 0) * Number(profile.nonEuWait ?? 1.16))),
      confidence: Math.min(98, Math.max(55, Math.round((confidence || 80) - 1))),
    },
  };
}

function aggregateLaneProfile(laneSignals = []) {
  const base = {
    eu: { key: 'eu', ...LANE_GROUP_LABELS.eu, counts: { cars: 0, vans: 0, trucks: 0, buses: 0 }, visibleTotal: 0, passed15: 0, wait: 0, confidence: 0 },
    nonEu: { key: 'nonEu', ...LANE_GROUP_LABELS.nonEu, counts: { cars: 0, vans: 0, trucks: 0, buses: 0 }, visibleTotal: 0, passed15: 0, wait: 0, confidence: 0 },
  };

  const weights = { eu: 0, nonEu: 0 };
  laneSignals.forEach((signal) => {
    Object.entries(signal.laneGroups || {}).forEach(([key, group]) => {
      if (!base[key]) return;
      const counts = normalizeVehicleCounts(group.counts || {});
      base[key].counts.cars += counts.cars;
      base[key].counts.vans += counts.vans;
      base[key].counts.trucks += counts.trucks;
      base[key].counts.buses += counts.buses;
      base[key].visibleTotal += Number(group.visibleTotal || totalVehicleCounts(counts) || 0);
      base[key].passed15 += Number(group.passed15 || 0);
      base[key].wait += Number(group.wait || 0) * Math.max(1, Number(group.visibleTotal || 1));
      base[key].confidence += Number(group.confidence || 0);
      weights[key] += Math.max(1, Number(group.visibleTotal || 1));
    });
  });

  Object.keys(base).forEach((key) => {
    base[key].wait = weights[key] ? Math.round(base[key].wait / weights[key]) : 0;
    base[key].confidence = laneSignals.length ? Math.round(base[key].confidence / laneSignals.length) : 0;
  });

  const total = base.eu.visibleTotal + base.nonEu.visibleTotal || 1;
  base.eu.share = Math.round((base.eu.visibleTotal / total) * 100);
  base.nonEu.share = Math.round((base.nonEu.visibleTotal / total) * 100);
  return base;
}

function laneDifferenceMinutes(profile = {}) {
  return Math.abs(Number(profile.nonEu?.wait || 0) - Number(profile.eu?.wait || 0));
}

function laneSignalText(profile = {}) {
  const diff = laneDifferenceMinutes(profile);
  if (!profile.eu?.wait || !profile.nonEu?.wait) return 'Čekamo odvojeno očitanje EU i non‑EU kolone.';
  if (diff < 10) return 'EU i non‑EU kolone su približno ujednačene.';
  const slower = Number(profile.nonEu.wait) > Number(profile.eu.wait) ? 'Non‑EU' : 'EU';
  return `${slower} kolona je sporija za oko ${formatMinutes(diff)}.`;
}

// EU/Non-EU lane split is real only where we have lane calibration anchors on
// at least one camera. Showing it elsewhere would invent numbers from a 0.5/0.5
// fallback split, which misleads users. Gornji Varoš is currently the only
// crossing with proper lane zones configured.
function crossingHasLaneCalibration(crossing) {
  if (!crossing || !Array.isArray(crossing.cameras)) return false;
  return crossing.cameras.some((camera) => {
    const cal = camera?.laneCalibration;
    if (!cal) return false;
    const zones = Array.isArray(cal.zones) ? cal.zones : [];
    const profiles = cal.profiles || {};
    return zones.length > 0 || profiles.toBih || profiles.toHr;
  });
}


const statusMeta = {
  unknown: { label: 'Čeka izvor', className: 'status-muted' },
  normal: { label: 'Otvoreno', className: 'status-green' },
  busy: { label: 'Pojačano', className: 'status-yellow' },
  critical: { label: 'Gužva', className: 'status-red' },
  closed: { label: 'Zatvoreno', className: 'status-red' },
  redirected: { label: 'Preusmjereno', className: 'status-yellow' },
};

const OPERATIONAL_STATUS_META = {
  open: { label: 'Otvoreno', short: 'Otvoreno', className: 'open', waitStatus: 'normal', userNote: 'Ruta je prohodna kada Google i ručni status ne javljaju blokadu.' },
  busy: { label: 'Pojačano', short: 'Gužva', className: 'busy', waitStatus: 'busy', userNote: 'Prijelaz je otvoren, ali očekuje se sporiji prolaz.' },
  closed: { label: 'Zatvoreno', short: 'Zatvoreno', className: 'closed', waitStatus: 'closed', userNote: 'Ruta preko ovog prijelaza trenutno nije prohodna.' },
  redirected: { label: 'Preusmjereno', short: 'Preusmjereno', className: 'redirected', waitStatus: 'redirected', userNote: 'Promet ide preko preporučene alternative dok se ova ruta ne otvori.' },
  unknown: { label: 'Nepoznato', short: 'Provjera', className: 'unknown', waitStatus: 'unknown', userNote: 'Nema dovoljno svježih podataka za sigurnu odluku.' },
};

const trendMeta = {
  rising: { label: 'raste', icon: '↗' },
  steady: { label: 'stabilno', icon: '→' },
  falling: { label: 'pada', icon: '↘' },
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const API_TIMEOUT_MS = 8500;
// How often the headline/marker state is polled. Kept short so a cleared/forming queue shows up
// within ~30 s; live signals (route/camera/admin refresh) also push an immediate sync reload.
const PUBLIC_STATE_POLL_MS = Number(import.meta.env.VITE_PUBLIC_STATE_POLL_MS) || 30000;
// Custom DOM event used to push an immediate public-state reload when a fresh live signal lands
// (route fetch persisted a Google snapshot, camera panel rescanned, admin forced a refresh).
const LIVE_SIGNAL_EVENT = 'bf-live-signal-updated';
// Stable, module-level dispatcher so passing it as a prop (e.g. CameraPanel.onLiveSignalUpdated)
// does NOT change identity each render — otherwise effects that depend on it re-run in a loop.
function dispatchLiveSignal() {
  window.dispatchEvent(new Event(LIVE_SIGNAL_EVENT));
}

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function fetchJson(path, options = {}) {
  const { timeoutMs = API_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl(path), {
      // Never serve a cached border estimate — the whole point is live data. Combined with the
      // per-request cache-busting query on /api/public/state this defeats browser + proxy caches.
      cache: 'no-store',
      ...fetchOptions,
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}



const UI_TEXT_EN = {
  'Pregled': 'Overview',
  'Moj put': 'My trip',
  'Karta': 'Map',
  'Mapa': 'Map',
  'Prošlost': 'History',
  'Uredi stanje': 'Update status',
  'za tim': 'team only',
  'Admin': 'Team',
  'čekanja uživo': 'live waits',
  'stanje sada': 'current status',
  'najbolji izbor': 'best choice',
  'najbolja ruta': 'best route',
  'rute i kamere': 'routes and cameras',
  'rute uživo': 'live routes',
  'stanje s puta': 'road reports',
  'stanje s terena': 'field reports',
  'kada krenuti': 'when to leave',
  'trend i povijest': 'trend and history',
  'upravljanje': 'management',
  'Granični promet uživo': 'Live border traffic',
  'PrijelazRadar ti na jednom mjestu pokazuje čekanja, rute i kamere za HR → BiH i BiH → HR.': 'PrijelazRadar shows waits, routes and cameras for HR → BiH and BiH → HR in one place.',
  'Stanje na granici uživo': 'Live border status',
  'Tim': 'Team',
  'Uredi stanje za vozače': 'Update driver status',
  'Ovdje tim može potvrditi čekanje, označiti zatvoren prijelaz ili dodati kratku poruku koja pomaže vozačima prije polaska.': 'Your team can confirm waits, mark a crossing closed, or add a short message that helps drivers before leaving.',
  'Podaci se osvježavaju automatski. Najnovije stanje vidiš u karticama prijelaza.': 'Data refreshes automatically. The latest status is shown in the crossing cards.',
  'Oba smjera aktivna': 'Both directions active',
  'Znaj kada krenuti i koji prijelaz odabrati.': 'Know when to leave and which crossing to choose.',
  'PrijelazRadar ti na jednom mjestu pokazuje čekanja, rute i kamere za HR → BiH i BiH → HR.': 'PrijelazRadar shows waits, routes and cameras for HR → BiH and BiH → HR in one place.',
  'Odabrani prijelaz': 'Selected crossing',
  'Trenutno čekanje': 'Current wait',
  'Smjer prikaza': 'Selected direction',
  'Prijelaz': 'Crossing',
  'Kamere': 'Cameras',
  'Prijava': 'Sign in',
  'Odjava': 'Sign out',
  'Stanje za vozače': 'Driver overview',
  'Odaberi smjer. Preporuke i obavijesti računaju se posebno za HR → BiH i BiH → HR.': 'Choose a direction. Recommendations and alerts are calculated separately for HR → BiH and BiH → HR.',
  'Najbrže': 'Fastest',
  'Najsporije': 'Slowest',
  'Prosjek': 'Average',
  'Čeka izvor': 'Waiting for source',
  'bez svježe brojke': 'no fresh value',
  'osobna vozila': 'passenger cars',
  'Najbolji izbor trenutno': 'Best choice now',
  'Detalji': 'Details',
  'Podijeli': 'Share',
  'Link kopiran': 'Link copied',
  'Javi kad padne ispod 15 min': 'Notify below 15 min',
  'Obavijesti pokrivaju oba smjera': 'Alerts cover both directions',
  'Okvirna procjena': 'Estimate',
  'App ne bira jedan izvor naslijepo.': 'The app does not rely on one source blindly.',
  'Pretraži prijelaz, grad ili rutu... npr. Maljevac, Gradiška, Bihać': 'Search a crossing, city or route... e.g. Maljevac, Gradiška, Bihać',
  'Svi prijelazi': 'All crossings',
  'Favoriti': 'Favorites',
  'Favorit': 'Favorite',
  '+ Favorit': '+ Favorite',
  'Status': 'Status',
  'Trend': 'Trend',
  'Sljedeći korak': 'Next step',
  'Otvoreno': 'Open',
  'Mirno': 'Open',
  'Pojačano': 'Busy',
  'Gužva': 'Heavy',
  'Zatvoreno': 'Closed',
  'Preusmjereno': 'Redirected',
  'Nepoznato': 'Unknown',
  'Provjera': 'Check',
  'Ažurirano': 'Updated',
  'Ruta trenutno nije prohodna': 'Route is currently not passable',
  'Prikaži alternativnu rutu': 'Show alternative route',
  'Rute i promet': 'Routes and traffic',
  'Promet': 'Traffic',
  'Sve granice': 'All borders',
  'Fokus granica': 'Focus border',
  'Granice na mapi': 'Borders on map',
  'Prikaži sve': 'Show all',
  'Samo odabrana': 'Selected only',
  'Traži prijelaz...': 'Search crossing...',
  'Najbolji prijelaz za tvoju rutu': 'Best crossing for your trip',
  'Odakle': 'From',
  'Kamo': 'To',
  'Planirani prijelaz': 'Planned crossing',
  'Vozilo': 'Vehicle',
  'Osobno vozilo': 'Passenger car',
  'Kamion': 'Truck',
  'Autobus': 'Bus',
  'Preporuka': 'Recommendation',
  'Ukupno': 'Total',
  'Ruta': 'Route',
  'Granica': 'Border',
  'Što se događa na prijelazu?': 'What is happening at the crossing?',
  'Poruka do 120 znakova': 'Message up to 120 characters',
  'Sažetak zajednice': 'Community summary',
  'Sve': 'All',
  'Prošao uredno': 'Passed smoothly',
  'Uredno': 'Clear',
  'Gužva / sporo': 'Queue / slow',
  'Zatvoreno / ne puštaju': 'Closed / not passing',
  'Policija / detaljna kontrola': 'Police / detailed control',
  'Kada je najbolje krenuti?': 'When is the best time to leave?',
  'Upravljanje stanjem prijelaza': 'Manage crossing status',
  'Operativni status': 'Operational status',
  'Trenutno za prikaz': 'Current public display',
  'Korekcija čekanja': 'Wait override',
  'Ručna vrijednost': 'Manual value',
  'Vrati live': 'Restore live',
  'Javna objava': 'Public post',
  'Tekst spreman za kopiranje': 'Text ready to copy',
  'Kopiraj': 'Copy',
  'Signali': 'Signals',
  'Što utječe na prikazano čekanje': 'What affects the shown wait',
  'Snapshot provjera': 'Snapshot check',
  'Otvori izvor': 'Open source',
  'Osvježi prikaz': 'Refresh view',
  'Procjena iz kamera': 'Camera estimate',
  'Zadnjih 15 min': 'Last 15 min',
  'Protok': 'Flow',
  'Ritam': 'Rhythm',
  'U koloni': 'In queue',
  'Pouzdanost': 'Confidence',
};
const UI_TEXT_HR = Object.fromEntries(Object.entries(UI_TEXT_EN).map(([hr, en]) => [en, hr]));

function translateTextValue(value, language) {
  const raw = String(value || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const map = language === 'en' ? UI_TEXT_EN : UI_TEXT_HR;
  const translated = map[trimmed];
  if (!translated) return raw;
  return raw.replace(trimmed, translated);
}

function useUiLanguage(language) {
  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'hr';
    const translateNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const next = translateTextValue(node.nodeValue, language);
        if (next !== node.nodeValue) node.nodeValue = next;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName?.toLowerCase();
      if (['script', 'style', 'noscript'].includes(tag)) return;
      if (node.placeholder) node.placeholder = translateTextValue(node.placeholder, language);
      if (node.title) node.title = translateTextValue(node.title, language);
      node.childNodes.forEach(translateNode);
    };
    const id = window.requestAnimationFrame(() => translateNode(document.body));
    return () => window.cancelAnimationFrame(id);
  });
}

function LanguageToggle({ value, onChange }) {
  return (
    <div className="language-toggle" aria-label="Jezik aplikacije">
      <Globe2 size={14}/>
      <button type="button" className={value === 'hr' ? 'active' : ''} onClick={() => onChange('hr')}>HR</button>
      <button type="button" className={value === 'en' ? 'active' : ''} onClick={() => onChange('en')}>EN</button>
    </div>
  );
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// formatMinutes / hasKnownWait / isUsableMinuteValue / normalizeMinutes / formatWaitDisplay
// are imported from ./utils/wait-format so they can be unit-tested in isolation.

function getStatusOverride(crossingId, directionKey) {
  const key = `${crossingId}:${directionKey}`;
  const overrides = globalThis.__BF_STATUS_OVERRIDES || {};
  return overrides[key] || null;
}

function isClosedOperationalStatus(status) {
  return status === 'closed' || status === 'redirected';
}

function getOperationalStatus(crossing, directionKey, wait, sourceMeta = {}) {
  const override = getStatusOverride(crossing.id, directionKey);
  if (override?.status && override.status !== 'open') {
    const meta = OPERATIONAL_STATUS_META[override.status] || OPERATIONAL_STATUS_META.unknown;
    return { ...meta, status: override.status, note: override.note || meta.userNote, updatedAt: override.updatedAt, replacementCrossingId: override.replacementCrossingId || '' };
  }
  const waitStatus = statusFromWait(wait);
  if (sourceMeta?.displayReady === false && !hasKnownWait(wait)) {
    return { ...OPERATIONAL_STATUS_META.unknown, status: 'unknown', note: sourceMeta.note || OPERATIONAL_STATUS_META.unknown.userNote, updatedAt: sourceMeta.updatedAt };
  }
  if (waitStatus === 'critical') return { ...OPERATIONAL_STATUS_META.busy, label: 'Velika gužva', short: 'Gužva', status: 'busy', note: 'Prijelaz je otvoren, ali čekanje je visoko.', updatedAt: sourceMeta.updatedAt };
  if (waitStatus === 'busy') return { ...OPERATIONAL_STATUS_META.busy, status: 'busy', note: OPERATIONAL_STATUS_META.busy.userNote, updatedAt: sourceMeta.updatedAt };
  return { ...OPERATIONAL_STATUS_META.open, status: 'open', note: OPERATIONAL_STATUS_META.open.userNote, updatedAt: sourceMeta.updatedAt };
}

function formatLastUpdated(value) {
  if (!value) return 'čeka osvježenje';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMin = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (diffMin < 1) return 'upravo ažurirano';
  if (diffMin < 60) return `ažurirano prije ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `ažurirano prije ${diffH} h`;
  return date.toLocaleString('hr-HR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function getFreshnessMeta(sourceMeta = {}, crossing = null) {
  const value = sourceMeta?.updatedAt || crossing?.updatedAt || '';
  const date = value ? new Date(value) : null;
  const diffMin = date && !Number.isNaN(date.getTime()) ? Math.max(0, Math.round((Date.now() - date.getTime()) / 60000)) : null;
  const stale = diffMin !== null && diffMin > 15;
  return {
    label: formatLastUpdated(value),
    stale,
    className: stale ? 'stale' : 'fresh',
    minutes: diffMin,
  };
}

function buildShareUrl(crossingId, directionKey, tab = 'Mapa') {
  const url = new URL(window.location.href);
  url.searchParams.set('crossing', crossingId);
  url.searchParams.set('direction', directionKey);
  url.searchParams.set('tab', tab);
  return url.toString();
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  const ok = document.execCommand('copy');
  input.remove();
  return ok;
}

function getOptionBorderMinutes(option = {}) {
  if (option.waitUnknown || option.borderDelayKnown === false) return null;
  const value = option.borderZastojMinutes ?? option.borderDelayMinutes ?? option.borderMinutes;
  return hasKnownWait(value) ? Number(value) : null;
}

function nowHHMM() {
  return new Date().toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
}

function getDirection(crossing, selectedDirection) {
  return crossing.directions[selectedDirection];
}

function getDefaultCameraId(crossing) {
  return crossing.cameras.find((cam) => cam.id.includes('bihamk') || cam.label.toLowerCase().includes('velika kladuša'))?.id || crossing.cameras[0]?.id || '';
}

function statusFromWait(wait) {
  if (!hasKnownWait(wait)) return 'unknown';
  const n = Number(wait);
  if (n >= 65) return 'critical';
  if (n >= 30) return 'busy';
  return 'normal';
}

function deterministicSeed(text) {
  return String(text).split('').reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 11), 0);
}

function nearestHistorySlot(crossing, hour) {
  return crossing.history.reduce((best, item) => {
    const diff = Math.abs(Number(item.hour) - hour);
    const bestDiff = Math.abs(Number(best.hour) - hour);
    return diff < bestDiff ? item : best;
  }, crossing.history[0]);
}

function buildCameraHistorySeries(crossing) {
  return Array.from({ length: 13 }, (_, index) => 7 + index).map((hour) => {
    const base = nearestHistorySlot(crossing, hour);
    const seed = deterministicSeed(`${crossing.id}-${hour}`);
    const wave = 0.88 + ((seed % 19) / 100);
    const cars = Math.max(8, Math.round(base.cars * wave));
    const vans = Math.max(1, Math.round((base.vans || base.cars * 0.18) * (0.86 + ((seed % 13) / 100))));
    const trucks = Math.max(1, Math.round(base.trucks * (0.84 + ((seed % 11) / 100))));
    const buses = Math.max(0, Math.round(base.buses * (0.78 + ((seed % 9) / 100))));
    const totalDemand = cars + vans + trucks + buses;
    const wait = Math.max(5, Math.round(base.wait * (0.92 + ((seed % 17) / 100))));
    const throughput = Math.max(14, Math.round(totalDemand * Math.max(0.22, 0.72 - wait / 180)));
    const rhythmSeconds = Math.round(3600 / Math.max(throughput, 1));
    const queueVehicles = Math.max(0, Math.round((wait / 60) * throughput * 0.74));
    return {
      hour: String(hour).padStart(2, '0'),
      cars,
      vans,
      trucks,
      buses,
      totalDemand,
      passed: throughput,
      throughput,
      rhythmSeconds,
      queueVehicles,
      wait,
    };
  });
}

function getCameraAnalytics(crossing, selectedDirection) {
  const direction = getDirection(crossing, selectedDirection);
  const now = new Date();
  const hour = Math.min(19, Math.max(7, now.getHours()));
  const slot = buildCameraHistorySeries(crossing).find((item) => Number(item.hour) === hour) || buildCameraHistorySeries(crossing)[0];
  const liveWait = getDisplayedWait(crossing, selectedDirection, {});
  const hasLiveWait = hasKnownWait(liveWait);
  const calcWait = hasLiveWait ? Number(liveWait) : 0;
  const throughputPerHour = hasLiveWait ? Math.max(10, Math.round(slot.throughput * (calcWait > 60 ? 0.82 : calcWait > 30 ? 0.94 : 1.08))) : 0;
  const passed15 = Math.max(2, Math.round(throughputPerHour / 4));
  const totalSlotDemand = Math.max(slot.totalDemand || 1, 1);
  const carShare = Math.max(0.46, Math.min(0.78, slot.cars / totalSlotDemand));
  const vanShare = Math.max(0.06, Math.min(0.22, (slot.vans || 0) / totalSlotDemand));
  const truckShare = Math.max(0.08, Math.min(0.34, slot.trucks / totalSlotDemand));
  const cars15 = Math.round(passed15 * carShare);
  const vans15 = Math.round(passed15 * vanShare);
  const trucks15 = Math.round(passed15 * truckShare);
  const buses15 = Math.max(0, passed15 - cars15 - vans15 - trucks15);
  const queueVehicles = hasLiveWait ? Math.max(0, Math.round((calcWait / 60) * throughputPerHour * 0.72)) : 0;
  const frameVehicles = hasLiveWait ? {
    car: Math.max(1, Math.round(queueVehicles / 9)),
    van: Math.max(0, Math.round(queueVehicles / 18)),
    truck: Math.max(0, Math.round(queueVehicles / 28)),
    bus: Math.max(0, Math.round(queueVehicles / 45)),
  } : { car: 0, van: 0, truck: 0, bus: 0 };
  const reliability = hasLiveWait ? Math.min(96, Math.max(62, crossing.confidence + (crossing.fieldConfirmed ? 5 : -3) - (calcWait > 70 ? 4 : 0))) : 0;
  const rhythmSeconds = Math.round(3600 / Math.max(throughputPerHour, 1));
  const trendLabel = trendMeta[direction.trend]?.label || 'stabilno';
  const laneSignals = crossing.cameras.map((cam, index) => {
    const frame = {
      cars: Math.max(0, Math.round(frameVehicles.car * (0.7 + index * 0.12))),
      vans: Math.max(0, Math.round(frameVehicles.van * (0.64 + index * 0.12))),
      trucks: Math.max(0, Math.round(frameVehicles.truck * (0.6 + index * 0.16))),
      buses: Math.max(0, Math.round(frameVehicles.bus * (0.5 + index * 0.12))),
    };
    const visibleTotal = frame.cars + frame.vans + frame.trucks + frame.buses;
    const signalPassed15 = Math.max(0, Math.round(passed15 * (0.34 + index * 0.07)));
    const confidence = hasLiveWait ? Math.max(58, Math.min(96, reliability - index * 4 + (cam.type === 'image' ? 2 : -2))) : 0;
    return {
      id: cam.id,
      label: cam.label,
      source: cam.source,
      confidence,
      frame,
      visibleTotal,
      detections: [],
      roi: cam.laneCalibration?.roi,
      laneZones: cam.laneCalibration?.zones || [],
      countLine: { label: 'linija prolaska' },
      passed15: signalPassed15,
      laneGroups: buildLaneGroups(frame, signalPassed15, hasLiveWait ? calcWait : 0, confidence, cam.laneCalibration, selectedDirection),
    };
  });
  const laneProfile = aggregateLaneProfile(laneSignals);

  return {
    updatedAt: nowHHMM(),
    state: hasLiveWait ? statusFromWait(calcWait) : 'unknown',
    wait: hasLiveWait ? calcWait : null,
    trend: direction.trend,
    trendLabel,
    confidence: reliability,
    throughputPerHour,
    passed15,
    rhythmSeconds,
    queueVehicles,
    frameVehicles,
    vehicleMix15: { cars: cars15, vans: vans15, trucks: trucks15, buses: buses15 },
    laneProfile,
    laneSignals,
    message: !hasLiveWait
      ? 'Čeka se svježe očitanje kamere ili javnog izvora.'
      : calcWait >= 65
        ? 'Protok je usporen i kolona raste kroz zonu prijelaza.'
        : calcWait >= 30
          ? 'Protok je pojačan, ali vozila se još kreću u pravilnim intervalima.'
          : 'Protok je uredan i nema ozbiljnog zadržavanja u zoni.',
  };
}

function formatRhythm(seconds) {
  if (!Number.isFinite(Number(seconds))) return '—';
  if (seconds < 60) return `${seconds}s / vozilo`;
  return `${Math.round(seconds / 60)} min / vozilo`;
}

function confidenceLabel(confidence) {
  const c = Number(confidence || 0);
  if (c >= 75) return 'Visoka pouzdanost';
  if (c >= 55) return 'Srednja pouzdanost';
  return 'Niska pouzdanost';
}

// Prefer the backend confidence engine's explicit level (visoka/srednja/niska/nedovoljno)
// over the raw numeric score, so the UI is honest about how much to trust the number.
function confidenceMetaLabel(sourceMeta = {}) {
  const level = sourceMeta.confidenceLevel;
  if (level === 'visoka') return { label: 'Visoka pouzdanost', tone: 'green' };
  if (level === 'srednja') return { label: 'Srednja pouzdanost', tone: 'amber' };
  if (level === 'niska') return { label: 'Niska pouzdanost', tone: 'red' };
  if (level === 'nedovoljno') return { label: 'Nedovoljno podataka', tone: 'grey' };
  return { label: confidenceLabel(sourceMeta.confidence), tone: Number(sourceMeta.confidence || 0) >= 75 ? 'green' : Number(sourceMeta.confidence || 0) >= 55 ? 'amber' : 'red' };
}

function trafficClassFromWait(wait) {
  if (!hasKnownWait(wait)) return 'unknown';
  const n = Number(wait);
  if (n >= 65) return 'critical';
  if (n >= 30) return 'busy';
  return 'normal';
}

function getBaseDisplayedWait(crossing, directionKey, overrides = {}) {
  const key = `${crossing.id}:${directionKey}`;
  const statusOverride = getStatusOverride(crossing.id, directionKey);
  if (isClosedOperationalStatus(statusOverride?.status)) return null;
  const liveWaits = globalThis.__BF_EFFECTIVE_WAITS || {};
  const liveSources = globalThis.__BF_WAIT_SOURCES || {};
  if (Object.prototype.hasOwnProperty.call(overrides || {}, key)) return Number(overrides[key]);
  const source = liveSources[key];
  if (source?.displayReady === false || source?.sourceType === 'static-fallback' || source?.sourceType === 'no-live-source') return null;
  if (Object.prototype.hasOwnProperty.call(liveWaits, key) && hasKnownWait(liveWaits[key])) return Number(liveWaits[key]);
  return null;
}

function getRouteSanityEntry(key) {
  const entries = globalThis.__BF_ROUTE_SANITY_WAITS || {};
  const entry = entries[key];
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > Number(entry.expiresAt)) {
    delete entries[key];
    return null;
  }
  return entry;
}

function getDisplayedWait(crossing, directionKey, overrides = {}) {
  const key = `${crossing.id}:${directionKey}`;
  const baseWait = getBaseDisplayedWait(crossing, directionKey, overrides);
  if (!hasKnownWait(baseWait)) return baseWait;
  if (Object.prototype.hasOwnProperty.call(overrides || {}, key)) return Number(overrides[key]);
  const routeSanity = getRouteSanityEntry(key);
  if (routeSanity && hasKnownWait(routeSanity.wait)) return Number(routeSanity.wait);
  return Number(baseWait);
}

function getWaitForMath(crossing, directionKey, overrides = {}, unknownValue = 999) {
  const wait = getDisplayedWait(crossing, directionKey, overrides);
  return hasKnownWait(wait) ? Number(wait) : unknownValue;
}

function getBaseWaitSourceMeta(crossing, directionKey, overrides = {}) {
  const key = `${crossing.id}:${directionKey}`;
  const statusOverride = getStatusOverride(crossing.id, directionKey);
  if (isClosedOperationalStatus(statusOverride?.status)) {
    const meta = OPERATIONAL_STATUS_META[statusOverride.status] || OPERATIONAL_STATUS_META.closed;
    return { label: meta.label, className: meta.className, note: statusOverride.note || meta.userNote, confidence: 98, updatedAt: statusOverride.updatedAt, displayReady: false, statusOverride };
  }
  if (Object.prototype.hasOwnProperty.call(overrides || {}, key)) {
    return { label: 'Tim potvrdio', className: 'manual', note: 'Ručna vrijednost ima prednost nad javnim izvorima i procjenom.', displayReady: true };
  }
  const liveSources = globalThis.__BF_WAIT_SOURCES || {};
  if (liveSources[key]) {
    const source = liveSources[key];
    if (source.displayReady === false || source.sourceType === 'static-fallback' || source.sourceType === 'no-live-source') {
      return {
        label: source.label || 'Čeka live izvor',
        className: source.className || 'pending',
        note: source.note || 'Nema svježeg javnog izvora, kamere, izmjerenog prelaska ili potvrde tima.',
        confidence: source.confidence,
        updatedAt: source.updatedAt,
        displayReady: false,
      };
    }
    return {
      label: source.label || 'Javni izvor',
      className: source.className || 'official',
      sourceType: source.sourceType,
      hasGoogleSignal: source.hasGoogleSignal,
      hasCameraSignal: source.hasCameraSignal,
      hasStrongCameraQueue: source.hasStrongCameraQueue,
      hasHardPublicSignal: source.hasHardPublicSignal,
      hasSoftUpperBoundPublic: source.hasSoftUpperBoundPublic,
      googleClearWhileQueue: source.googleClearWhileQueue,
      visualBand: source.visualBand,
      visualConflict: source.visualConflict,
      visualCongestionConflict: source.visualCongestionConflict,
      conflictKind: source.conflictKind,
      googleTraffic: source.googleTraffic,
      googleTrafficSeverity: source.googleTrafficSeverity,
      googleTrafficConflict: source.googleTrafficConflict,
      note: source.note || 'Vrijednost je izračunata iz javnih izvora, kamera i izmjerenih prelazaka.',
      explanation: source.explanation,
      explanationPayload: source.explanationPayload,
      confidence: source.confidence,
      confidenceHint: source.confidenceHint,
      confidenceLevel: source.confidenceLevel,
      confidenceScore: source.confidenceScore,
      confidenceDowngradeReasons: source.confidenceDowngradeReasons,
      calibration: source.calibration,
      precision: source.precision,
      independentSources: source.independentSources,
      hasMeasuredSession: source.hasMeasuredSession,
      rangeMin: source.rangeMin,
      rangeMax: source.rangeMax,
      updatedAt: source.updatedAt,
      displayReady: true,
    };
  }
  return { label: 'Čeka live izvor', className: 'pending', note: 'Stanje još nije stiglo iz javnog izvora, kamera, izmjerenih prelazaka ili potvrde tima.', displayReady: false };
}

function getWaitSourceMeta(crossing, directionKey, overrides = {}) {
  const key = `${crossing.id}:${directionKey}`;
  const baseMeta = getBaseWaitSourceMeta(crossing, directionKey, overrides);
  const routeSanity = getRouteSanityEntry(key);
  if (!routeSanity || baseMeta.displayReady === false || Object.prototype.hasOwnProperty.call(overrides || {}, key)) return baseMeta;
  return {
    ...baseMeta,
    label: baseMeta.label || 'Okvirna procjena',
    className: routeSanity.className || baseMeta.className || 'combined',
    note: routeSanity.note || baseMeta.note,
    rangeMin: routeSanity.rangeMin ?? baseMeta.rangeMin,
    rangeMax: routeSanity.rangeMax ?? baseMeta.rangeMax,
    routeSanity: true,
  };
}

function routeTrafficMeta(route = {}) {
  const delayMinutes = Math.max(0, Number(route.delayMinutes ?? route.googleDelayMinutes ?? 0) || 0);
  const ratio = Math.max(0.1, Number(route.ratio ?? (route.staticMinutes ? Number(route.durationMinutes || 0) / Math.max(1, Number(route.staticMinutes)) : 1)) || 1);
  const level = String(route.level || (delayMinutes >= 8 || ratio >= 1.35 ? 'heavy' : delayMinutes >= 3 || ratio >= 1.12 ? 'slow' : 'normal'));
  return { delayMinutes, ratio, level };
}

function routeLooksClear(route = null) {
  if (!route) return false;
  const { delayMinutes, ratio, level } = routeTrafficMeta(route);
  return (level === 'normal' && delayMinutes <= 2 && ratio < 1.12) || (delayMinutes <= 2.5 && ratio < 1.6);
}

function routeLooksHeavy(route = null) {
  if (!route) return false;
  if (routeLooksClear(route)) return false;
  const { delayMinutes, ratio, level } = routeTrafficMeta(route);
  return level === 'heavy' || delayMinutes >= 8 || ratio >= 1.35;
}

function sourceLooksProtected(meta = {}) {
  return ['admin-override', 'driver-reports'].includes(meta.sourceType) || meta.className === 'manual' || /dojav/i.test(meta.label || '');
}

// Authoritative-about-the-booth signals: an official hard public number, a strong camera
// queue, or the backend's explicit "Google clear but booth queue" flag. The frontend route
// sanity cap must NEVER pull these down — Google blue only describes the approach road, not
// the queue at the control booth. Mirrors the server-side fusion policy.
function sourceHasAuthoritativeQueue(meta = {}) {
  return meta.hasHardPublicSignal === true
    || meta.hasStrongCameraQueue === true
    || meta.googleClearWhileQueue === true
    // A camera VISIBLY shows a queue (override raised the number, or the visual-congestion conflict
    // flagged it). Google blue on the APPROACH must never trim a booth queue the camera can see —
    // this is what kept the map at "od 12 min" while the overview already showed the raised estimate.
    || meta.conflictKind === 'camera-congestion'
    || meta.sourceType === 'camera-congestion-override'
    || meta.visualCongestionConflict === true;
}

function sourceLooksSoftUpperBound(meta = {}) {
  const text = `${meta.label || ''} ${meta.note || ''}`.toLowerCase();
  return text.includes('gornja granica') || text.includes('do x min') || text.includes('do 30') || text.includes('nije du') || text.includes('soft') || text.includes('bihamk');
}

function computeRouteSanityWait(baseWait, sourceMeta = {}, route = null) {
  // Never re-cap a protected source (admin/reports) or an authoritative booth-queue signal
  // (official hard number / strong camera / backend googleClearWhileQueue). A blue Google road
  // must not override HAK/MUP/BIHAMK/AMS or a visible camera queue — the wait is at the booth.
  if (!hasKnownWait(baseWait) || !route || sourceLooksProtected(sourceMeta) || sourceHasAuthoritativeQueue(sourceMeta) || routeLooksHeavy(route)) return null;
  const currentWait = Number(baseWait);
  if (!Number.isFinite(currentWait) || currentWait <= 15) return null;
  const { delayMinutes, ratio } = routeTrafficMeta(route);
  const isClear = routeLooksClear(route);
  if (!isClear) return null;

  // Only soft-bound / Google-dominated combined estimates reach here. Strong camera/official
  // signals were already excluded above, so this only trims genuinely Google-led numbers.
  const softUpperBound = sourceMeta.hasSoftUpperBoundPublic === true || sourceLooksSoftUpperBound(sourceMeta) || sourceMeta.className === 'combined' || sourceMeta.sourceType === 'combined-estimate';
  const cap = softUpperBound ? 12 : 18;
  const wait = Math.min(currentWait, cap);
  if (wait >= currentWait) return null;
  return {
    wait,
    baseWait: currentWait,
    rangeMin: softUpperBound ? 4 : 6,
    rangeMax: softUpperBound ? 14 : 20,
    className: 'combined route-sanity',
    expiresAt: Date.now() + 3 * 60 * 1000,
    note: `Google promet je normalan${delayMinutes > 0 ? ` (${formatMinutes(delayMinutes)} cestovnog zastoja)` : ''}, a nema tvrdog službenog signala, jake kamere ni izmjerenih prelazaka, pa se visoka procjena ne prikazuje. Plavo ne znači 0 min. Trenutna procjena je oko ${formatMinutes(wait)}.`,
  };
}

function updateRouteSanityWait(crossing, directionKey, route = null, overrides = {}) {
  const key = `${crossing.id}:${directionKey}`;
  globalThis.__BF_ROUTE_SANITY_WAITS = globalThis.__BF_ROUTE_SANITY_WAITS || {};
  const before = globalThis.__BF_ROUTE_SANITY_WAITS[key]?.wait ?? null;
  const baseWait = getBaseDisplayedWait(crossing, directionKey, overrides);
  const sourceMeta = getBaseWaitSourceMeta(crossing, directionKey, overrides);
  const sanity = computeRouteSanityWait(baseWait, sourceMeta, route);
  if (sanity) {
    globalThis.__BF_ROUTE_SANITY_WAITS[key] = sanity;
  } else {
    delete globalThis.__BF_ROUTE_SANITY_WAITS[key];
  }
  const after = globalThis.__BF_ROUTE_SANITY_WAITS[key]?.wait ?? null;
  if (before !== after && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bf-route-sanity-updated', { detail: { key, before, after } }));
  }
}

function alternativesFor(selectedId, selectedDirection, overrides) {
  const selected = CROSSINGS.find((c) => c.id === selectedId) || CROSSINGS[0];
  const selectedWait = getDisplayedWait(selected, selectedDirection, overrides);

  return CROSSINGS
    .filter((crossing) => crossing.id !== selected.id)
    .map((crossing) => {
      const wait = getDisplayedWait(crossing, selectedDirection, overrides);
      const borderSaving = hasKnownWait(selectedWait) && hasKnownWait(wait) ? Number(selectedWait) - Number(wait) : null;
      const extraDrive = crossing.extraDriveFromMainRoute;
      const netBenefit = hasKnownWait(borderSaving) ? Number(borderSaving) - extraDrive : -999;
      return { ...crossing, wait, borderSaving, extraDrive, netBenefit };
    })
    .sort((a, b) => b.netBenefit - a.netBenefit);
}

function getAlternativeDeltaMeta(netBenefit) {
  const value = Number(netBenefit);
  if (!Number.isFinite(value) || value <= -900) {
    return {
      label: 'Nema dovoljno podataka',
      className: 'unknown',
      note: 'Nemamo dovoljno svježih podataka za pouzdanu usporedbu. Provjeri oba prijelaza prije polaska.',
    };
  }
  if (value >= 15) {
    return {
      label: `Ušteda ~${formatMinutes(value)}`,
      className: 'better',
      note: `Ušteda oko ${formatMinutes(value)} ako ideš preko ove alternative (uključuje dodatnu vožnju).`,
    };
  }
  if (value > 0) {
    return {
      label: 'Alternativa može biti brža',
      className: 'better',
      note: `Mala prednost — ušteda je oko ${formatMinutes(value)}.`,
    };
  }
  if (value >= -10) {
    return {
      label: 'Razlika je mala',
      className: 'neutral',
      note: 'Oba prijelaza imaju slično očekivano čekanje.',
    };
  }
  if (value >= -30) {
    return {
      label: 'Planirani prijelaz je bolji izbor',
      className: 'warning',
      note: 'Alternativa trenutno ne donosi uštedu.',
    };
  }
  return {
    label: 'Planirani prijelaz je puno bolji',
    className: 'critical',
    note: 'Alternativa bi zahtijevala znatno dulje putovanje.',
  };
}

function getAdminDecision({ wait, direction, hasManualOverride }) {
  if (!hasKnownWait(wait)) {
    return { tone: 'watch', title: 'Čeka se live izvor', label: 'Provjeri izvor', reason: 'Još nema dovoljno svježih podataka za sigurnu objavu.' };
  }
  const normalizedDecision = String(direction.publishDecision || '').toLowerCase();
  if (wait >= 75) {
    return { tone: 'critical', title: 'Objaviti odmah', label: 'Hitna objava', reason: 'Čekanje je visoko i korisnicima treba jasan update odmah.' };
  }
  if (wait >= 45 || normalizedDecision.includes('objavi')) {
    return { tone: 'warning', title: 'Pripremiti objavu', label: 'Preporučena objava', reason: hasManualOverride ? 'Korekcija tima je unesena, objava je spremna za kopiranje.' : direction.publishReason };
  }
  return { tone: 'calm', title: 'Stanje je mirno', label: 'Nije potrebna objava', reason: 'Stanje je dovoljno mirno za prikaz u aplikaciji bez zasebne objave.' };
}

function getAdminConfidence({ crossing, hasManualOverride }) {
  let score = Number(crossing.confidence || 60);
  if (crossing.fieldConfirmed) score += 8;
  if (hasManualOverride) score += 10;
  if (crossing.cameras?.some((cam) => cam.laneCalibration?.zones?.length)) score += 4;
  return Math.max(35, Math.min(98, Math.round(score)));
}

function getAdminSourceRows({ crossing, direction, baseWait, finalWait, hasManualOverride }) {
  const cameraCount = crossing.cameras?.length || 0;
  const laneAware = crossing.cameras?.some((cam) => cam.laneCalibration?.zones?.length);
  return [
    { label: 'Live izvor', value: formatMinutes(baseWait), note: hasKnownWait(baseWait) ? 'Vrijednost je stigla iz povezanih izvora.' : 'Nema svježe vrijednosti za prikaz.', tone: hasKnownWait(baseWait) ? 'blue' : 'muted' },
    { label: 'Ručna korekcija člana tima', value: hasManualOverride ? formatMinutes(finalWait) : 'nije unesena', note: hasManualOverride ? 'Ova brojka ide u objavu i ima prednost nad procjenom.' : 'Ako imaš bolju informaciju s terena, unesi je ovdje.', tone: hasManualOverride ? 'green' : 'muted' },
    { label: 'Teren', value: crossing.fieldConfirmed ? 'potvrđeno' : 'nije potvrđeno', note: crossing.fieldConfirmed ? crossing.fieldNote : 'Prije veće objave poželjno je provjeriti kameru ili stanje na terenu.', tone: crossing.fieldConfirmed ? 'green' : 'muted' },
    { label: 'Kamera / trake', value: laneAware ? 'kalibrirane trake' : `${cameraCount} izvor(a)`, note: laneAware ? 'Kamera razlikuje namjenu traka, npr. EU i non‑EU.' : 'Kamera služi kao ručna vizualna provjera.', tone: laneAware ? 'green' : 'muted' },
    { label: 'Bottleneck', value: direction.bottleneckSide, note: direction.bottleneckText, tone: statusFromWait(finalWait) === 'critical' ? 'red' : hasKnownWait(finalWait) ? 'blue' : 'muted' },
  ];
}

function buildAdminPost({ selectedCrossing, direction, wait, confidence, decision, sourceLabel }) {
  const truckLine = hasKnownWait(wait) ? '🚛 Kamioni: provjeriti posebnu traku prije polaska' : '🚛 Kamioni: čeka se potvrda';
  return `🚦 ${selectedCrossing.name}

Smjer: ${direction.label}
🚗 Osobna vozila: ${formatMinutes(wait)}
${truckLine}

Status: ${(statusMeta[statusFromWait(wait)] || statusMeta.unknown).label}
Izvor: ${sourceLabel || 'čeka se live izvor'}
Ažurirano: ${selectedCrossing.updatedAt}

${direction.waitAdvice}

Napomena: stanje na granici može se brzo promijeniti. Provjerite aplikaciju prije polaska.`;
}

function FieldBadge({ crossing }) {
  return crossing.fieldConfirmed ? (
    <span className="field-badge confirmed">Tim/teren</span>
  ) : (
    <span className="field-badge unconfirmed">Live izvor</span>
  );
}

function DirectionToggle({ value, onChange, compact = false, neighbor = 'HR' }) {
  const n = neighborLabelOf(neighbor);
  return (
    <div className={compact ? 'direction-toggle compact-direction-toggle' : 'direction-toggle direction-toggle-large'} aria-label="Odaberi smjer putovanja">
      <button className={value === 'toBih' ? 'active' : ''} onClick={() => onChange('toBih')} type="button">
        <span>{n} → BiH</span>
        {!compact && <small>prema BiH</small>}
      </button>
      <button className={value === 'toHr' ? 'active' : ''} onClick={() => onChange('toHr')} type="button">
        <span>BiH → {n}</span>
        {!compact && <small>prema {n}</small>}
      </button>
    </div>
  );
}

function SystemStatus({ compact = false }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const payload = await fetchJson('/api/health', { timeoutMs: 4200 });
        if (!cancelled) setHealth(payload);
      } catch {
        if (!cancelled) setHealth({ ok: false });
      }
    }

    loadHealth();
    const timer = window.setInterval(loadHealth, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const routesReady = health?.integrations?.routes === 'configured';
  const cameraReady = health?.integrations?.cameraIngest === 'ready';
  const label = health?.ok ? 'Sustav online' : 'Status nedostupan';
  const details = health?.ok
    ? `Rute: ${routesReady ? 'aktivne' : 'nisu povezane'} · Kamere: ${cameraReady ? 'spremne' : 'provjera'}`
    : 'Backend trenutno nije odgovorio na status provjeru.';

  return <span className={`${health?.ok ? 'system-pill online' : 'system-pill degraded'} ${compact ? 'compact' : ''}`} title={details}>{compact ? (health?.ok ? 'online' : 'provjera') : label}</span>;
}

function AuthScreen({ setCurrentUser, compact = false, onCancel }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const googleBtnRef = useRef(null);
  const [googleClientId, setGoogleClientId] = useState(null);

  // Discover whether Google Sign-In is enabled (client ID is public; fetched at runtime → no rebuild).
  useEffect(() => {
    let cancelled = false;
    fetchJson('/api/config')
      .then((cfg) => { if (!cancelled && cfg?.googleAuth?.enabled && cfg.googleAuth.clientId) setGoogleClientId(cfg.googleAuth.clientId); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Load Google Identity Services + render the official button once we have a client ID.
  useEffect(() => {
    if (!googleClientId) return undefined;
    let cancelled = false;
    const onCredential = (response) => {
      if (response?.credential) submitAuth('/api/auth/google', { credential: response.credential });
    };
    const renderButton = () => {
      const gid = window.google?.accounts?.id;
      if (cancelled || !gid || !googleBtnRef.current) return;
      gid.initialize({ client_id: googleClientId, callback: onCredential });
      googleBtnRef.current.innerHTML = '';
      gid.renderButton(googleBtnRef.current, { theme: 'outline', size: 'large', width: 280, text: 'continue_with', logo_alignment: 'center' });
    };
    if (window.google?.accounts?.id) { renderButton(); return () => { cancelled = true; }; }
    let script = document.getElementById('gis-script');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true; script.defer = true; script.id = 'gis-script';
      document.head.appendChild(script);
    }
    script.addEventListener('load', renderButton);
    return () => { cancelled = true; script.removeEventListener('load', renderButton); };
  }, [googleClientId]);

  async function submitAuth(path, body) {
    setIsSubmitting(true);
    setMessage('');
    try {
      const payload = await fetchJson(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!payload?.ok) throw new Error(payload?.error || 'Prijava nije uspjela.');
      setCurrentUser({ ...payload.user, token: payload.token });
    } catch (error) {
      setMessage(error?.message || 'Server trenutno nije dostupan.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function login(event) {
    event.preventDefault();
    submitAuth('/api/auth/login', { email, password });
  }

  function register(event) {
    event.preventDefault();
    submitAuth('/api/auth/register', { name, email, password });
  }

  function forgot(event) {
    event.preventDefault();
    setMessage('Za reset lozinke kontaktiraj podršku.');
  }

  const submit = mode === 'register' ? register : mode === 'forgot' ? forgot : login;

  return (
    <main className={compact ? 'auth-page compact-auth-page' : 'auth-page'}>
      <section className="auth-card production-auth-card">
        {onCancel && <button type="button" className="auth-close-button" onClick={onCancel} aria-label="Zatvori prijavu">×</button>}
        <div className="auth-brand">
          <div className="brand-mark">PR</div>
          <div>
            <strong>PrijelazRadar</strong>
            <span>Promet na granici</span>
          </div>
        </div>
        <h1>{mode === 'login' ? 'Prijava' : mode === 'register' ? 'Registracija' : 'Zaboravljena lozinka'}</h1>
        <p>Prijavi se računom za PrijelazRadar. Pristup za tim omogućuje korekciju čekanja i poruka za vozače.</p>

        {googleClientId && (
          <div className="google-auth">
            <div ref={googleBtnRef} className="google-auth-button" />
            <div className="auth-divider"><span>ili</span></div>
          </div>
        )}

        <form onSubmit={submit} className="auth-form">
          {mode === 'register' && (
            <label>
              <span>Ime</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bruno" autoComplete="name" />
            </label>
          )}
          <label>
            <span>Email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" />
          </label>
          {mode !== 'forgot' && (
            <label>
              <span>Lozinka</span>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </label>
          )}
          {message && <div className="form-message">{message}</div>}
          <button className="primary-button" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Provjeravam…' : mode === 'login' ? 'Prijavi se' : mode === 'register' ? 'Registriraj se' : 'Prikaži upute'}</button>
        </form>

        <div className="auth-actions">
          <button type="button" onClick={() => setMode('login')}>Prijava postojećeg korisnika</button>
          <button type="button" onClick={() => setMode('register')}>Novi račun</button>
          <button type="button" onClick={() => setMode('forgot')}>Zaboravljena lozinka</button>
        </div>
      </section>
    </main>
  );
}

function RoadSign({ crossing, direction, wait, sourceMeta = {} }) {
  // Use the conflict-aware display (formatWaitDisplay reads sourceMeta) so the headline pill
  // never shows a confident raw number when the camera contradicts it (Maljevac/Šamac fix).
  const kind = sourceMeta.conflictKind;
  const conflict = sourceMeta.visualConflict || sourceMeta.visualCongestionConflict || Boolean(kind);
  // Always COMMIT to a number — the pill explains WHAT drives it, it never tells people to go check
  // official sources elsewhere (that defeats the app). The headline number is the committed figure.
  const conflictText =
    kind === 'camera-congestion' ? 'kamera vidi gužvu — procjena povišena'
    : kind === 'congestion' ? 'kamera vidi veću gužvu'
    : kind === 'clear-high' ? 'kamera ne vidi takvu kolonu'
    : kind === 'google-jam' ? 'gužva na prilaznoj cesti'
    : 'procjena iz više izvora';
  const congestionKind = kind === 'camera-congestion' || kind === 'congestion' || kind === 'google-jam';
  const status = conflict
    ? { className: 'busy', label: congestionKind ? 'Gužva' : 'Pazi' }
    : (statusMeta[statusFromWait(wait)] || statusMeta.unknown);
  return (
    <article className={`road-sign${conflict ? ' road-sign-conflict' : ''}`}>
      <div>
        <span>{crossing.shortName}</span>
        <b>{direction.label}</b>
      </div>
      <strong>{hasKnownWait(wait) ? formatWaitDisplay(wait, sourceMeta) : '—'}</strong>
      <small>{!hasKnownWait(wait) ? 'nema svježeg izvora' : conflict ? conflictText : 'osobna vozila'}</small>
      <em className={`status ${status.className}`}>{status.label}</em>
    </article>
  );
}

function SegmentBar({ segments }) {
  const total = Math.max(segments.reduce((sum, segment) => sum + segment.minutes, 0), 1);
  return (
    <div className="segments">
      <div className="segment-track">
        {segments.map((segment) => <span key={segment.label} className={`segment segment-${segment.level}`} style={{ width: `${(segment.minutes / total) * 100}%` }} />)}
      </div>
      <div className="segment-list">
        {segments.map((segment) => (
          <div key={segment.label}>
            <span><i className={`dot dot-${segment.level}`} />{segment.label}</span>
            <strong>{formatMinutes(segment.minutes)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, hint, tone, icon }) {
  return (
    <article className={`stat-card ${tone || ''}`}>
      <span>{icon}{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </article>
  );
}

function TermsModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="terms-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="kicker">Napomena</span>
            <h2>Kako računamo stanje?</h2>
          </div>
          <button type="button" onClick={onClose} className="icon-button">×</button>
        </div>
        <p>PrijelazRadar kombinira prometne rute, kamere, javne izvore, potvrde s terena i izmjerene prelaske uživo.</p>
        <p>Podaci nisu službeni podatak granične policije. Stanje se može promijeniti brzo.</p>
        <button type="button" className="primary-button" onClick={onClose}>Razumijem</button>
      </section>
    </div>
  );
}

function DetailModal({ crossing, selectedDirection, overrides, onClose, onTrack, tracked, setTripCrossing, setSelectedCrossing, setActiveTab, addNotificationRule }) {
  if (!crossing) return null;
  const direction = getDirection(crossing, selectedDirection);
  const wait = getDisplayedWait(crossing, selectedDirection, overrides);
  const sourceMeta = getWaitSourceMeta(crossing, selectedDirection, overrides);
  const operational = getOperationalStatus(crossing, selectedDirection, wait, sourceMeta);
  const freshness = getFreshnessMeta(sourceMeta, crossing);
  const waitLabel = formatWaitDisplay(wait, sourceMeta);
  const alternatives = alternativesFor(crossing.id, selectedDirection, overrides);
  const bestAlt = alternatives[0];
  const bestAltWait = bestAlt ? getDisplayedWait(bestAlt, selectedDirection, overrides) : null;
  const bestAltMeta = bestAlt ? getWaitSourceMeta(bestAlt, selectedDirection, overrides) : null;
  const altDeltaMeta = getAlternativeDeltaMeta(bestAlt?.netBenefit);
  const dataKnown = sourceMeta?.displayReady !== false && hasKnownWait(wait);
  const confMeta = confidenceMetaLabel(sourceMeta);
  const headline = dataKnown
    ? `${waitLabel} · ${direction.label}`
    : `Stanje za ${direction.label} još nije stiglo iz live izvora`;
  const subline = dataKnown
    ? (direction.waitAdvice || operational.note || sourceMeta.note || '')
    : (sourceMeta?.note || 'Čim stigne svjež javni izvor, kamera ili izmjereni prelazak, ovdje će se prikazati čekanje.');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="detail-modal overview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="overview-head-copy">
            <span className="kicker">Pregled prijelaza</span>
            <h2>{crossing.name}</h2>
            <div className="overview-head-pills">
              <span className={`operational-pill ${operational.className}`}>{operational.label}</span>
              <span className={`freshness-pill ${freshness.className}`}>{freshness.label}</span>
              {dataKnown && <span className={`confidence-pill conf-${confMeta.tone}`} title="Koliko je procjena pouzdana">{confMeta.label}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Zatvori">×</button>
        </div>

        <article className={`overview-hero-card ${dataKnown ? operational.className : 'pending'}`}>
          <div className="overview-hero-copy">
            <span className="overview-hero-eyebrow">Trenutno čekanje</span>
            <strong className="overview-hero-wait">{dataKnown ? waitLabel : '—'}</strong>
            <p className="overview-hero-sub">{headline}</p>
            <p className="overview-hero-note">{subline}</p>
          </div>
          <div className="overview-hero-actions">
            <button type="button" className="primary-button" onClick={() => { setTripCrossing(crossing.id); setSelectedCrossing(crossing); setActiveTab('Moj put'); onClose(); }}>Dodaj u Moj put</button>
            <ShareRouteButton crossing={crossing} selectedDirection={selectedDirection} />
          </div>
        </article>

        <div className="overview-grid">
          <article className="overview-card">
            <span>Najbolja alternativa</span>
            {bestAlt ? (
              <>
                <h3>{bestAlt.shortName || bestAlt.name}</h3>
                <strong>{bestAltMeta?.displayReady !== false && hasKnownWait(bestAltWait) ? formatWaitDisplay(bestAltWait, bestAltMeta) : '—'}</strong>
                <small className={`alternative-delta ${altDeltaMeta.className}`}>{altDeltaMeta.label}</small>
                <p>{altDeltaMeta.note}</p>
              </>
            ) : (
              <>
                <h3>—</h3>
                <p>Trenutno nemamo bolju alternativu za ovaj smjer.</p>
              </>
            )}
          </article>
          <article className="overview-card">
            <span>Izvor procjene</span>
            <h3>{sourceMeta.label || 'Čeka izvor'}</h3>
            <p>{sourceMeta.explanation || sourceMeta.note || 'Procjena se osvježava čim stigne svjež signal.'}</p>
            {dataKnown && <small className={`alternative-delta ${confMeta.tone === 'green' ? 'better' : confMeta.tone === 'red' ? 'critical' : confMeta.tone === 'amber' ? 'warning' : 'neutral'}`}>{confMeta.label}{sourceMeta.independentSources ? ` · ${sourceMeta.independentSources} izvor(a)` : ''}</small>}
          </article>
          <article className="overview-card">
            <span>Što napraviti sada</span>
            <h3>{dataKnown ? direction.waitAdvice : 'Pričekaj svježu procjenu'}</h3>
            <p>{dataKnown ? direction.bottleneckText : 'Ako moraš krenuti odmah, provjeri preporuku ili odaberi najbližu alternativu.'}</p>
          </article>
        </div>

        {dataKnown && <WhyThisEstimate payload={sourceMeta.explanationPayload} confMeta={confMeta} meta={sourceMeta} />}

        <div className="modal-actions">
          <button type="button" className={tracked ? 'ghost-button active' : 'ghost-button'} onClick={() => onTrack(crossing.id)}>{tracked ? '★ Favorit' : '+ Favorit'}</button>
          {addNotificationRule && <button type="button" className="ghost-button" onClick={() => addNotificationRule({ crossingId: crossing.id, direction: selectedDirection, type: 'below_wait', threshold: 15 })}>Javi kad padne ispod 15 min</button>}
        </div>
      </section>
    </div>
  );
}


// "Zašto ova procjena?" — the transparency view (spec V5 §3/§4). Shows every source the
// fusion saw: its value, contribution %, trust, role and honest flags, whether sources
// conflict, and explicitly that Google never dictates the booth wait.
const ROLE_LABELS = { lead: 'glavni izvor', support: 'podrška', helper: 'pomoćni (prilaz)', excluded: 'isključeno' };
const KIND_LABELS = { official: 'Službeni izvor', camera: 'Kamera', google: 'Google promet', measured: 'Izmjereno čekanje' };

function WhyThisEstimate({ payload, confMeta, meta = {} }) {
  const [open, setOpen] = useState(false);
  if (!payload || !Array.isArray(payload.sources) || !payload.sources.length) return null;
  const hasGoogle = payload.sources.some((s) => s.kind === 'google');
  const cal = meta.calibration || {};
  const downgrades = Array.isArray(meta.confidenceDowngradeReasons) ? meta.confidenceDowngradeReasons : [];
  return (
    <section className="why-estimate">
      <button type="button" className="why-estimate-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>Zašto ova procjena?</span>
        <small>{confMeta?.label || ''} · {open ? 'sakrij' : 'prikaži izvore'}</small>
      </button>
      {open && (
        <div className="why-estimate-body">
          <p className="why-estimate-calibration">
            <strong>Pouzdanost: {confMeta?.label || '—'}.</strong>{' '}
            {cal.hasData
              ? `Temeljeno na ${cal.sampleSize} izmjerenih prolazaka (povijesna pogreška ~${cal.bucketMae} min, P90 ${cal.bucketP90} min).`
              : 'Još nemamo dovoljno izmjerenih prolazaka da empirijski potvrdimo visoku pouzdanost za ovu vrstu procjene.'}
          </p>
          {downgrades.length > 0 && (
            <p className="why-estimate-note">Snižena pouzdanost: {downgrades.join('; ')}.</p>
          )}
          {payload.conflict?.detected && (
            <p className="why-estimate-conflict">⚠️ Izvori se ne slažu (raspon {payload.conflict.spreadMinutes} min) pa je procjena prikazana kao širi raspon i s nižom pouzdanošću.</p>
          )}
          {hasGoogle && !payload.googleAsAuthority && (
            <p className="why-estimate-note">Google promet ovdje opisuje samo prilaznu cestu i <strong>ne određuje čekanje na granici</strong> — mjerodavni su službeni izvor, kamera ili izmjereni prelasci.</p>
          )}
          <ul className="why-estimate-sources">
            {payload.sources.map((s, i) => (
              <li key={`${s.kind}-${i}`} className={`why-source role-${s.role}`}>
                <div className="why-source-head">
                  <strong>{KIND_LABELS[s.kind] || s.label}</strong>
                  <span className={`why-role-badge role-${s.role}`}>{ROLE_LABELS[s.role] || s.role}</span>
                </div>
                <div className="why-source-meta">
                  {hasKnownWait(s.value) && <span>{formatMinutes(s.value)}</span>}
                  {s.used ? <span>{s.contributionPct}% težine</span> : <span>0%</span>}
                  <span>pouzdanost {Math.round((s.trust || 0) * 100)}%</span>
                  {Number.isFinite(s.ageMinutes) && s.ageMinutes > 0 && <span>otprije {s.ageMinutes} min</span>}
                </div>
                {s.flags?.length > 0 && (
                  <div className="why-source-flags">{s.flags.map((f, fi) => <em key={fi}>{f}</em>)}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ShareRouteButton({ crossing, selectedDirection, tab = 'Mapa', label = 'Podijeli' }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    const url = buildShareUrl(crossing.id, selectedDirection, tab);
    try {
      if (navigator.share) await navigator.share({ title: `PrijelazRadar · ${crossing.shortName}`, text: `${crossing.shortName} ${dirPairLabel(crossing, selectedDirection)}`, url });
      else await copyToClipboard(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return <button type="button" className="share-route-button" onClick={share}><Share2 size={14}/> {copied ? 'Link kopiran' : label}</button>;
}

function BestNowCard({ best, selectedDirection, overrides, setSelectedCrossing, openDetail, addNotificationRule }) {
  if (!best) return null;
  const wait = getDisplayedWait(best, selectedDirection, overrides);
  const sourceMeta = getWaitSourceMeta(best, selectedDirection, overrides);
  const operational = getOperationalStatus(best, selectedDirection, wait, sourceMeta);
  const freshness = getFreshnessMeta(sourceMeta, best);
  const direction = getDirection(best, selectedDirection);
  const canNotifyLow = hasKnownWait(wait) && wait > 15;
  return (
    <article className={`best-now-card status-${operational.className}`}>
      <div className="best-now-copy">
        <span className="kicker">Najbolji izbor trenutno</span>
        <h3>{operational.status === 'closed' ? 'Trenutno nema otvorene preporuke' : best.shortName}</h3>
        <p>{operational.status === 'open' || operational.status === 'busy' ? `${direction.label}: ${formatWaitDisplay(wait, sourceMeta)} · ${direction.waitAdvice}` : operational.note}</p>
        <div className="best-now-meta-row">
          <span className={`operational-pill ${operational.className}`}>{operational.label}</span>
          <span className={`freshness-pill ${freshness.className}`}>{freshness.label}</span>
          <span className={`source-badge mini ${sourceMeta.className}`}>{sourceMeta.label}</span>
        </div>
      </div>
      <div className="best-now-actions">
        <button type="button" className="primary-button" onClick={() => { setSelectedCrossing(best); openDetail(best); }}>Detalji</button>
        <ShareRouteButton crossing={best} selectedDirection={selectedDirection} />
        {addNotificationRule && canNotifyLow && <button type="button" className="ghost-button" onClick={() => addNotificationRule({ crossingId: best.id, direction: selectedDirection, type: 'below_wait', threshold: 15 })}>Javi kad padne ispod 15 min</button>}
      </div>
    </article>
  );
}

function SourceExplanationCard() {
  return (
    <article className="source-explanation-card">
      <div>
        <span className="kicker">Procjena čekanja</span>
        <strong>App ne bira jedan izvor naslijepo.</strong>
      </div>
      <p>Procjena se slaže iz više tragova: HAK, BIHAMK/AMS, Google promet, kamere, izmjereni prelasci uživo i provjera tima. Najviše vjerujemo svježim i potvrđenim informacijama, a ako tim označi zatvaranje ili preusmjeravanje, to odmah ima prednost.</p>
    </article>
  );
}

// Location recommendation: "which crossing is best for me right now?" One-shot current location
// (NO continuous pings, NO raw trail, NO other users). Ranks by driveTime + wait + reliability.
function LocationRecommendation({ selectedDirection, setSelectedCrossing, openDetail, overrides = {} }) {
  const [status, setStatus] = useState('idle'); // idle | loading | ready | denied | error | empty
  const [pos, setPos] = useState(null);
  const [rec, setRec] = useState(null);
  const [hidden, setHidden] = useState(false);

  const compute = useCallback((userPos) => {
    const candidates = CROSSINGS.map((c) => {
      const waitMin = getDisplayedWait(c, selectedDirection, overrides);
      const meta = getWaitSourceMeta(c, selectedDirection, overrides);
      return { id: c.id, name: c.shortName || c.name, lat: c.lat, lng: c.lng, waitMin: hasKnownWait(waitMin) ? Number(waitMin) : null, confidence: meta.confidenceLevel || meta.confidenceHint || null };
    });
    return rankCrossingsByLocation(userPos, candidates);
  }, [selectedDirection, overrides]);

  // Recompute when the direction changes (or after we get a position).
  useEffect(() => {
    if (!pos) return;
    const r = compute(pos);
    setRec(r);
    setStatus(r.best ? 'ready' : 'empty');
  }, [pos, compute]);

  function useMyLocation() {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { setStatus('error'); return; }
    setStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (err) => setStatus(err && err.code === 1 ? 'denied' : 'error'),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    );
  }

  if (hidden) return null;
  const pick = (id) => { const c = CROSSINGS.find((x) => x.id === id); if (c) { setSelectedCrossing(c); openDetail?.(c); } };
  const dirLabel = selectedDirection === 'toBih' ? 'HR → BiH' : 'BiH → HR';
  // Same shared wait formatter as sidebar/marker/overlay — no "0 min" vs "do 5 min" drift here.
  const waitLabelFor = (id, fallbackMin) => {
    const c = CROSSINGS.find((x) => x.id === id);
    if (!c) return formatMinutes(fallbackMin);
    return formatWaitDisplay(getDisplayedWait(c, selectedDirection, overrides), getWaitSourceMeta(c, selectedDirection, overrides));
  };

  return (
    <article className="loc-rec-card">
      {status === 'idle' && (
        <>
          <div className="loc-rec-head"><Crosshair size={16} aria-hidden="true" /><strong>Pronađi najbolji prijelaz prema tvojoj lokaciji</strong></div>
          <p>Usporedit ćemo vrijeme vožnje i čekanje na granici za {dirLabel}. Ne spremamo tvoju rutu i ne prikazujemo tvoju lokaciju drugima.</p>
          <div className="loc-rec-actions">
            <button type="button" className="loc-rec-cta" onClick={useMyLocation}>Koristi moju lokaciju</button>
            <button type="button" className="loc-rec-secondary" onClick={() => setHidden(true)}>Ne sada</button>
          </div>
        </>
      )}
      {status === 'loading' && <p className="loc-rec-status">Dohvaćam lokaciju…</p>}
      {status === 'denied' && <p className="loc-rec-status">Lokacija nije uključena. I dalje možeš ručno odabrati prijelaz.</p>}
      {status === 'error' && <p className="loc-rec-status">Nismo uspjeli dohvatiti lokaciju. <button type="button" className="loc-rec-link" onClick={useMyLocation}>Pokušaj ponovno</button></p>}
      {status === 'empty' && <p className="loc-rec-status">Nemamo dovoljno podataka za pouzdanu preporuku. Prikazujemo prijelaze ručno ispod.</p>}
      {status === 'ready' && rec?.best && (
        <>
          <div className="loc-rec-head"><Navigation size={16} aria-hidden="true" /><strong>Najbolja opcija sada · {dirLabel}</strong></div>
          <button type="button" className="loc-rec-best" onClick={() => pick(rec.best.id)}>
            <div className="loc-rec-best-top"><b>{rec.best.name}</b><span>oko {formatMinutes(rec.best.totalMin)} ukupno</span></div>
            <div className="loc-rec-best-detail">Vožnja {rec.best.driveApprox ? '≈ ' : ''}{formatMinutes(rec.best.driveMin)} · Čekanje {waitLabelFor(rec.best.id, rec.best.waitMin)}{rec.best.confidence ? ` · pouzdanost ${rec.best.confidence}` : ''}</div>
            <div className="loc-rec-badges">{rec.best.badges.map((b) => <span key={b}>{b}</span>)}</div>
          </button>
          {rec.similar && <p className="loc-rec-status">Slične opcije — provjeri stanje prije polaska.</p>}
          {rec.alternatives.length > 0 && (
            <div className="loc-rec-alts">
              <span>Alternative</span>
              {rec.alternatives.map((a) => (
                <button type="button" key={a.id} onClick={() => pick(a.id)}>
                  <b>{a.name}</b><span>oko {formatMinutes(a.totalMin)}</span>
                </button>
              ))}
            </div>
          )}
          <p className="loc-rec-note">Računamo vrijeme vožnje + trenutno čekanje na granici.{rec.best.driveApprox ? ' Vrijeme vožnje je okvirno.' : ''} Ne spremamo tvoju rutu.</p>
        </>
      )}
    </article>
  );
}

function PublicView({ selectedDirection, setSelectedDirection, selectedCrossing, setSelectedCrossing, trackedIds, toggleTracked, openDetail, overrides, addNotificationRule }) {
  const [searchQuery, setSearchQuery] = useState('');
  const sorted = useMemo(() => [...CROSSINGS].sort((a, b) => getWaitForMath(a, selectedDirection, overrides) - getWaitForMath(b, selectedDirection, overrides)), [selectedDirection, overrides]);
  const filtered = useMemo(() => {
    const query = normalizeSearchText(searchQuery.trim());
    if (!query) return sorted;
    return sorted.filter((crossing) => {
      const direction = getDirection(crossing, selectedDirection);
      return [crossing.name, crossing.shortName, crossing.route, crossing.area, crossing.cause, crossing.fieldNote, direction.label, direction.waitAdvice, direction.bottleneckText]
        .map(normalizeSearchText)
        .some((value) => value.includes(query));
    });
  }, [searchQuery, selectedDirection, sorted]);
  const knownRows = sorted.filter((c) => hasKnownWait(getDisplayedWait(c, selectedDirection, overrides)));
  const best = knownRows[0] || sorted[0];
  const worst = knownRows.length ? knownRows[knownRows.length - 1] : sorted[sorted.length - 1];
  const avg = knownRows.length ? Math.round(knownRows.reduce((sum, c) => sum + Number(getDisplayedWait(c, selectedDirection, overrides)), 0) / knownRows.length) : null;
  const confirmed = CROSSINGS.filter((c) => c.fieldConfirmed).length;

  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="kicker">Pregled</span>
          <h2>Stanje za vozače</h2>
          <p className="screen-subtitle">Odaberi smjer. Preporuke i obavijesti računaju se posebno za HR → BiH i BiH → HR.</p>
        </div>
        <DirectionToggle value={selectedDirection} onChange={setSelectedDirection} neighbor={selectedCrossing?.neighbor} />
      </div>
      <div className="stats-grid">
        <StatCard label="Najbrže" value={knownRows.length ? best.shortName : '—'} hint={knownRows.length ? formatWaitDisplay(getDisplayedWait(best, selectedDirection, overrides), getWaitSourceMeta(best, selectedDirection, overrides)) : 'čekam live izvor'} tone="green" icon={<Navigation size={14} />} />
        <StatCard label="Najsporije" value={knownRows.length ? worst.shortName : '—'} hint={knownRows.length ? formatWaitDisplay(getDisplayedWait(worst, selectedDirection, overrides), getWaitSourceMeta(worst, selectedDirection, overrides)) : 'čekam live izvor'} tone="red" icon={<AlertTriangle size={14} />} />
        <StatCard label="Prosjek" value={formatMinutes(avg)} hint="osobna vozila" icon={<Clock size={14} />} />
        <StatCard label="Čeka izvor" value={CROSSINGS.length - knownRows.length} hint="bez svježe brojke" icon={<ShieldCheck size={14} />} />
      </div>
      <LocationRecommendation selectedDirection={selectedDirection} setSelectedCrossing={setSelectedCrossing} openDetail={openDetail} overrides={overrides} />
      <BestNowCard best={best} selectedDirection={selectedDirection} overrides={overrides} setSelectedCrossing={setSelectedCrossing} openDetail={openDetail} addNotificationRule={addNotificationRule} />
      <article className="direction-scope-card">
        <div><Bell size={16} /><strong>Obavijesti pokrivaju oba smjera</strong></div>
        <p>Trenutno gledaš <b>{dirPairLabel(selectedCrossing, selectedDirection)}</b>. Prebaci smjer iznad i aplikacija prikazuje posebna čekanja, kamere, povijest i pragove obavijesti za taj smjer.</p>
      </article>
      <SourceExplanationCard />
      <div className="overview-filter-card">
        <label className="overview-search">
          <Search size={18} />
          <span className="sr-only">Pretraži prijelaze</span>
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Pretraži prijelaz, grad ili rutu... npr. Maljevac, Gradiška, Bihać" />
        </label>
        <div className="overview-filter-meta"><strong>{filtered.length}</strong><span>od {sorted.length} prijelaza</span></div>
      </div>
      <div className="crossing-list">
        {filtered.map((crossing) => {
          const direction = getDirection(crossing, selectedDirection);
          const wait = getDisplayedWait(crossing, selectedDirection, overrides);
          const sourceMeta = getWaitSourceMeta(crossing, selectedDirection, overrides);
          const operational = getOperationalStatus(crossing, selectedDirection, wait, sourceMeta);
          const status = statusMeta[operational.waitStatus || statusFromWait(wait)] || statusMeta.unknown;
          const trend = trendMeta[direction.trend];
          const freshness = getFreshnessMeta(sourceMeta, crossing);
          return (
            <article className={selectedCrossing?.id === crossing.id ? `crossing-row active op-${operational.className}` : `crossing-row op-${operational.className}`} key={crossing.id}>
              <button type="button" className="row-open" onClick={() => { setSelectedCrossing(crossing); openDetail(crossing); }}>
                <div className="mini-sign"><span>{crossing.shortName}</span><small>{crossing.area}</small></div>
                <div className="row-copy">
                  <div><h3>{crossing.name}</h3><span className={`status ${status.className}`}>{status.label}</span><FieldBadge crossing={crossing} /></div>
                  <p>{crossing.route}</p>
                  <small className={`freshness-line ${freshness.className}`}>{freshness.label}</small>
                </div>
              </button>
              <div className="metric"><span>Status</span><strong>{operational.short}</strong><small className={`source-badge mini ${sourceMeta.className}`}>{sourceMeta.label}</small></div>
              <div className="metric"><span>Trend</span><strong>{trend.icon} {trend.label}</strong></div>
              <div className="metric wide"><span>Sljedeći korak</span><strong>{direction.waitAdvice}</strong></div>
              <div className="row-action-stack"><button type="button" className={trackedIds.includes(crossing.id) ? 'follow-button active' : 'follow-button'} onClick={() => toggleTracked(crossing.id)}>{trackedIds.includes(crossing.id) ? '★ Favorit' : '+ Favorit'}</button><ShareRouteButton crossing={crossing} selectedDirection={selectedDirection} /></div>
            </article>
          );
        })}
        {!filtered.length && (
          <article className="empty-filter-state">
            <strong>Nema pronađenih prijelaza.</strong>
            <span>Probaj upisati naziv prijelaza, grad, rutu ili obriši filter.</span>
            <button type="button" onClick={() => setSearchQuery('')}>Obriši pretragu</button>
          </article>
        )}
      </div>
    </section>
  );
}

function TripPassModal({ currentUser, onClose }) {
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const ent = currentUser?.entitlements;

  useEffect(() => {
    let cancelled = false;
    fetchJson('/api/billing/config').then((c) => { if (!cancelled) setConfig(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function buy(product) {
    if (!currentUser?.token) return;
    setBusy(product); setError('');
    try {
      const res = await fetchJson('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentUser.token}` },
        body: JSON.stringify({ product }),
      });
      if (res?.url) { window.location.href = res.url; return; }
      throw new Error('no-url');
    } catch {
      setError('Pokretanje naplate nije uspjelo. Pokušaj ponovno.');
      setBusy('');
    }
  }

  const fmt = (iso) => { try { return new Date(iso).toLocaleString('hr-HR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

  return (
    <div className="trippass-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="trippass-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="auth-close-button" onClick={onClose} aria-label="Zatvori">×</button>
        <h2>Trip Pass</h2>
        {ent?.hasActivePass ? (
          <p className="trippass-active">✓ Pass je aktivan{ent.tripPassUntil ? ` — do ${fmt(ent.tripPassUntil)}` : ent.subscriptionUntil ? ` (pretplata do ${fmt(ent.subscriptionUntil)})` : ''}.</p>
        ) : (
          <p>Osnovne procjene čekanja su besplatne. Trip Pass otključava <strong>neograničene alarme</strong> i napredne funkcije.</p>
        )}
        {!currentUser?.token && <p className="form-message">Prvo se prijavi da kupiš Trip Pass.</p>}
        {config && !config.enabled && <p className="form-message">Naplata trenutno nije dostupna.</p>}
        {config?.enabled && currentUser?.token && (
          <div className="trippass-options">
            {config.products?.trippass24h?.available && (
              <button type="button" className="primary-button" disabled={!!busy} onClick={() => buy('trippass24h')}>
                {busy === 'trippass24h' ? 'Otvaram…' : `Trip Pass ${config.tripPassHours || 24} h`}
              </button>
            )}
            {config.products?.monthly?.available && (
              <button type="button" className="logout-button" disabled={!!busy} onClick={() => buy('monthly')}>
                {busy === 'monthly' ? 'Otvaram…' : 'Mjesečna pretplata'}
              </button>
            )}
          </div>
        )}
        {error && <div className="form-message">{error}</div>}
      </div>
    </div>
  );
}

function TripPlanner({ selectedDirection, setSelectedDirection, tripCrossing, setTripCrossing, selectedCrossing, setSelectedCrossing, setActiveTab, overrides, currentUser }) {
  const [origin, setOrigin] = useState('Zagreb');
  const [destination, setDestination] = useState('Cazin');
  const [vehicle, setVehicle] = useState('car');
  const [tripPayload, setTripPayload] = useState({ live: false, options: [] });
  const [routeHistory, setRouteHistory] = useLocalStorage('bf_route_search_history_v1', []);
  const [isLoading, setIsLoading] = useState(false);
  const lastSavedSearchRef = useRef('');
  const selected = CROSSINGS.find((c) => c.id === tripCrossing) || selectedCrossing || CROSSINGS[0];
  const inferredDirection = inferTripDirection(origin, destination);
  const tripDirection = inferredDirection || selectedDirection;

  useEffect(() => {
    if (inferredDirection && inferredDirection !== selectedDirection) setSelectedDirection(inferredDirection);
  }, [inferredDirection, selectedDirection, setSelectedDirection]);

  function selectTripCrossing(id) {
    const crossing = CROSSINGS.find((item) => item.id === id) || CROSSINGS[0];
    setTripCrossing(crossing.id);
    setSelectedCrossing(crossing);
  }
  const estimatedOptions = useMemo(() => estimatedTripOptions(origin, destination, tripDirection, vehicle, overrides), [origin, destination, tripDirection, vehicle, overrides]);
  const options = tripPayload.options?.length ? tripPayload.options : estimatedOptions;
  const bestOption = options[0];
  const selectedOption = options.find((option) => option.crossingId === selected.id) || estimatedOptions.find((option) => option.crossingId === selected.id) || bestOption;

  useEffect(() => {
    let cancelled = false;
    async function loadTripOptions() {
      if (!origin.trim() || !destination.trim()) return;
      setIsLoading(true);
      try {
        const params = new URLSearchParams({ origin, destination, direction: tripDirection, vehicle });
        const payload = await fetchJson(`/api/trip-options?${params.toString()}`);
        if (!cancelled) setTripPayload(payload);
      } catch {
        if (!cancelled) setTripPayload({ live: false, options: [] });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    const timer = window.setTimeout(loadTripOptions, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [origin, destination, tripDirection, vehicle]);

  useEffect(() => {
    if (!origin.trim() || !destination.trim() || !bestOption || bestOption.waitUnknown || isLoading) return;
    const signature = [origin.trim().toLowerCase(), destination.trim().toLowerCase(), tripDirection, vehicle, bestOption.crossingId, bestOption.totalMinutes].join('|');
    if (lastSavedSearchRef.current === signature) return;
    lastSavedSearchRef.current = signature;

    const entry = {
      id: `${Date.now()}-${bestOption.crossingId}`,
      origin: origin.trim(),
      destination: destination.trim(),
      direction: tripDirection,
      vehicle,
      bestCrossingId: bestOption.crossingId,
      bestCrossingName: bestOption.crossingName || bestOption.shortName,
      totalMinutes: bestOption.totalMinutes,
      live: Boolean(tripPayload.live),
      createdAt: new Date().toISOString(),
    };

    setRouteHistory((previous) => [entry, ...(previous || []).filter((item) => `${item.origin}|${item.destination}|${item.direction}|${item.vehicle}` !== `${entry.origin}|${entry.destination}|${entry.direction}|${entry.vehicle}`)].slice(0, 8));

    if (currentUser?.token) {
      fetchJson('/api/route-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentUser.token}` },
        body: JSON.stringify(entry),
      }).catch(() => {});
    }
  }, [origin, destination, tripDirection, vehicle, bestOption, isLoading, tripPayload.live, currentUser?.token, setRouteHistory]);

  function restoreRouteSearch(item) {
    setOrigin(item.origin || '');
    setDestination(item.destination || '');
    setVehicle(item.vehicle || 'car');
    setSelectedDirection(item.direction === 'toHr' ? 'toHr' : 'toBih');
    if (item.bestCrossingId) selectTripCrossing(item.bestCrossingId);
  }

  const delta = selectedOption && bestOption ? selectedOption.totalMinutes - bestOption.totalMinutes : 0;
  const selectedZone = getZone(selected, tripDirection);

  return (
    <section className="screen trip-planner-screen">
      <div className="screen-head">
        <div>
          <span className="kicker">Moj put</span>
          <h2>Najbolji prijelaz za tvoju rutu</h2>
          <p className="screen-subtitle">Uspoređujemo rutu preko svakog prijelaza, promet na cesti i očekivano čekanje na granici — radi i za duže rute poput Njemačka ↔ BiH.</p>
        </div>
        <DirectionToggle value={selectedDirection} onChange={setSelectedDirection} neighbor={selectedCrossing?.neighbor} />
      </div>
      <div className="trip-grid production-trip-grid">
        <div className="trip-form route-search-card">
          <label><span>Odakle</span><input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="npr. Zagreb" /></label>
          <label><span>Kamo</span><input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="npr. Cazin" /></label>
          <label><span>Planirani prijelaz</span><select value={tripCrossing} onChange={(e) => selectTripCrossing(e.target.value)}>{CROSSINGS.map((c) => <option key={c.id} value={c.id}>{c.shortName}</option>)}</select></label>
          <label><span>Vozilo</span><select value={vehicle} onChange={(event) => setVehicle(event.target.value)}><option value="car">Osobno vozilo</option><option value="truck">Kamion</option><option value="bus">Autobus</option></select></label>
          <p className="trip-direction-hint">{inferredDirection ? `Smjer je prepoznat kao ${tripDirection === 'toHr' ? 'BiH → HR' : 'HR → BiH'}.` : 'Možeš upisati grad ili adresu u Njemačkoj, Austriji, Sloveniji, Hrvatskoj ili BiH.'}</p>
          <div className="zone-compact">
            <span>Zona mjerenja</span>
            <strong>{selectedZone.from}</strong>
            <i>preko {selectedZone.via}</i>
            <strong>{selectedZone.to}</strong>
          </div>
          <div className="route-history-panel">
            <div className="route-history-head"><span>Zadnje pretrage ruta</span><b>{routeHistory.length}</b></div>
            {(routeHistory || []).slice(0, 4).map((item) => (
              <button key={item.id} type="button" onClick={() => restoreRouteSearch(item)}>
                <strong>{item.origin} → {item.destination}</strong>
                <span>{item.bestCrossingName || item.bestCrossingId} · {formatMinutes(item.totalMinutes)} · {item.direction === 'toHr' ? 'BiH → HR' : 'HR → BiH'}</span>
              </button>
            ))}
            {!routeHistory.length && <p>Pretrage će se spremati ovdje nakon prvog izračuna.</p>}
          </div>
        </div>

        <article className={`recommend-card smart-recommend ${bestOption?.level === 'heavy' ? 'risk' : ''}`}>
          <span className="kicker">Preporuka</span>
          <h3>{bestOption ? `Najbolje preko ${bestOption.shortName}` : 'Unesi rutu'}</h3>
          <p>{bestOption?.waitUnknown ? 'Ruta je izračunata, ali čekanje na granici čeka live izvor/tim/kameru/izmjereni prelazak.' : tripPayload.live ? 'Izračun koristi stvarnu rutu i trenutno stanje prijelaza.' : 'Procjena koristi zadnje poznato stanje prijelaza dok se rute ne osvježe.'}</p>
          {bestOption && (
            <div className="recommend-metrics">
              <div><span>Ukupno</span><b>{formatMinutes(bestOption.totalMinutes)}</b></div>
              <div><span>Ruta</span><b>{formatMinutes(bestOption.routeDurationMinutes)}</b></div>
              <div><span>Granica</span><b>{formatMinutes(getOptionBorderMinutes(bestOption))}</b></div>
            </div>
          )}
          <div className="trip-state-line">
            <span>{isLoading ? 'Ažuriram rute…' : bestOption?.waitUnknown ? 'Čekanje nije prikazano bez live izvora' : tripPayload.live ? 'Rute su ažurirane' : 'Procjena stanja'}</span>
            {selectedOption && delta > 0 && <strong>{formatMinutes(delta)} sporije preko planiranog prijelaza</strong>}
          </div>
        </article>
      </div>

      <div className="route-options-grid">
        {options.slice(0, 4).map((option, index) => {
          const isBest = index === 0;
          const isSelected = option.crossingId === selected.id;
          const zone = option.zone || getZone(CROSSINGS.find((crossing) => crossing.id === option.crossingId) || selected, tripDirection);
          return (
            <article key={option.id || option.crossingId} className={`route-option-card ${isBest ? 'best' : ''} ${isSelected ? 'selected' : ''}`} onClick={() => selectTripCrossing(option.crossingId)}>
              <div className="route-option-top">
                <span>{isBest ? 'Preporučeno' : isSelected ? 'Planirano' : 'Alternativa'}</span>
                <b>{levelLabel(option.level)}</b>
              </div>
              <h3>{option.crossingName}</h3>
              <strong>{formatMinutes(option.totalMinutes)}</strong>
              <div className="route-option-breakdown">
                <span>Vožnja {formatMinutes(option.routeDurationMinutes)}</span>
                <span>Granica {formatMinutes(getOptionBorderMinutes(option))}</span>
                {option.distanceKm ? <span>{formatDistanceKm(option.distanceKm)}</span> : null}
              </div>
              <p>{zone.from} → {zone.to}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function getMarkerTone(crossing, selectedDirection = 'toBih', overrides = {}) {
  const wait = getDisplayedWait(crossing, selectedDirection, overrides);
  if (!hasKnownWait(wait)) return 'unknown';
  if (wait >= 65) return 'critical';
  if (wait >= 30) return 'busy';
  return 'normal';
}

function getRouteToneColor(level, primary = false) {
  // The route line itself should look like Google Maps: blue for selected route,
  // lighter blue for alternatives. Real traffic colors come from TrafficLayer and
  // Routes API speedReadingIntervals, not from our own zastoj guess.
  if (!primary) return '#8bb5ff';
  return '#3b28ff';
}

function getTrafficSegmentColor(speedOrLevel) {
  if (speedOrLevel === 'TRAFFIC_JAM' || speedOrLevel === 'jam') return '#d93025';
  if (speedOrLevel === 'SLOW' || speedOrLevel === 'slow') return '#f9ab00';
  if (speedOrLevel === 'NORMAL' || speedOrLevel === 'normal') return '#1a73e8';
  return '#3b28ff';
}

function trafficLabel(speedOrLevel) {
  if (speedOrLevel === 'TRAFFIC_JAM' || speedOrLevel === 'jam') return 'gužva';
  if (speedOrLevel === 'SLOW' || speedOrLevel === 'slow') return 'usporeno';
  if (speedOrLevel === 'NORMAL' || speedOrLevel === 'normal') return 'protočno';
  return 'signal';
}

function formatDistanceKm(km) {
  const n = Number(km);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('hr-HR', { maximumFractionDigits: 1 })} km`;
}

function getZone(crossing, selectedDirection) {
  return MEASUREMENT_ZONES[crossing.id]?.[selectedDirection] || {
    from: crossing.route.split('↔')[0]?.trim() || crossing.shortName,
    via: crossing.name,
    to: crossing.route.split('↔')[1]?.trim() || crossing.shortName,
  };
}

const TRIP_PLACE_COORDS = [
  { keys: ['zagreb', 'hrvatska', 'croatia'], lat: 45.815, lng: 15.981 },
  { keys: ['split'], lat: 43.508, lng: 16.440 },
  { keys: ['rijeka'], lat: 45.327, lng: 14.442 },
  { keys: ['osijek'], lat: 45.555, lng: 18.695 },
  { keys: ['munchen', 'muenchen', 'münchen', 'minhen', 'bavarska'], lat: 48.137, lng: 11.575 },
  { keys: ['stuttgart'], lat: 48.775, lng: 9.182 },
  { keys: ['frankfurt'], lat: 50.110, lng: 8.682 },
  { keys: ['koln', 'köln', 'cologne'], lat: 50.938, lng: 6.960 },
  { keys: ['dortmund'], lat: 51.514, lng: 7.465 },
  { keys: ['berlin', 'njemacka', 'njemačka', 'germany', 'deutschland'], lat: 52.520, lng: 13.405 },
  { keys: ['bec', 'beč', 'vienna', 'wien', 'austria', 'österreich'], lat: 48.208, lng: 16.373 },
  { keys: ['ljubljana', 'slovenija', 'slovenia'], lat: 46.056, lng: 14.505 },
  { keys: ['sarajevo', 'bosna', 'bih', 'bosnia', 'herzegovina'], lat: 43.856, lng: 18.413 },
  { keys: ['banja luka', 'banjaluka'], lat: 44.772, lng: 17.191 },
  { keys: ['cazin'], lat: 44.966, lng: 15.943 },
  { keys: ['bihac', 'bihać'], lat: 44.812, lng: 15.868 },
  { keys: ['tuzla'], lat: 44.538, lng: 18.676 },
  { keys: ['zenica'], lat: 44.203, lng: 17.907 },
  { keys: ['mostar'], lat: 43.343, lng: 17.808 },
];

const BIH_TRIP_WORDS = ['bih', 'bosna', 'bosnia', 'herzegovina', 'sarajevo', 'banja luka', 'banjaluka', 'cazin', 'bihac', 'bihać', 'tuzla', 'zenica', 'mostar', 'travnik', 'prijedor', 'doboj'];
const NORTH_WEST_TRIP_WORDS = ['hrvatska', 'croatia', 'zagreb', 'split', 'rijeka', 'osijek', 'njemacka', 'njemačka', 'germany', 'deutschland', 'munchen', 'muenchen', 'münchen', 'minhen', 'stuttgart', 'frankfurt', 'berlin', 'koln', 'köln', 'dortmund', 'austria', 'österreich', 'wien', 'vienna', 'bec', 'beč', 'slovenija', 'slovenia', 'ljubljana'];

function textHasAnyPlace(value, words) {
  const normalized = normalizeSearchText(value);
  return words.some((word) => normalized.includes(normalizeSearchText(word)));
}

function inferTripDirection(origin, destination) {
  const originIsBih = textHasAnyPlace(origin, BIH_TRIP_WORDS);
  const destinationIsBih = textHasAnyPlace(destination, BIH_TRIP_WORDS);
  const originIsNorthWest = textHasAnyPlace(origin, NORTH_WEST_TRIP_WORDS);
  const destinationIsNorthWest = textHasAnyPlace(destination, NORTH_WEST_TRIP_WORDS);
  if (originIsBih && destinationIsNorthWest) return 'toHr';
  if (originIsNorthWest && destinationIsBih) return 'toBih';
  return null;
}

function matchTripCoord(value) {
  const normalized = normalizeSearchText(value);
  return TRIP_PLACE_COORDS.find((place) => place.keys.some((key) => normalized.includes(normalizeSearchText(key)))) || null;
}

function tripDistanceKm(a, b) {
  if (!a || !b) return null;
  const toRad = (value) => Number(value || 0) * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function estimatedBaseTripMinutes(origin, destination) {
  const from = matchTripCoord(origin);
  const to = matchTripCoord(destination);
  const distance = tripDistanceKm(from, to);
  if (!distance) return 90;
  const drivingKm = distance * 1.22;
  return Math.max(55, Math.round((drivingKm / 82) * 60));
}

function estimatedTripOptions(origin, destination, selectedDirection, vehicle = 'car', overrides = {}) {
  const baseTripMinutes = estimatedBaseTripMinutes(origin, destination);
  return CROSSINGS.map((crossing) => {
    const wait = getDisplayedWait(crossing, selectedDirection, overrides);
    const knownWait = hasKnownWait(wait) ? Number(wait) : null;
    const routeDurationMinutes = baseTripMinutes + crossing.extraDriveFromMainRoute;
    return {
      id: crossing.id,
      crossingId: crossing.id,
      crossingName: crossing.name,
      shortName: crossing.shortName,
      direction: selectedDirection,
      routeDurationMinutes,
      borderZastojMinutes: knownWait,
      borderDelayKnown: knownWait !== null,
      waitUnknown: knownWait === null,
      totalMinutes: routeDurationMinutes + (knownWait || 0),
      distanceKm: 0,
      googleZastojMinutes: 0,
      level: statusFromWait(knownWait),
      zone: getZone(crossing, selectedDirection),
      offline: true,
    };
  }).sort((a, b) => a.totalMinutes - b.totalMinutes);
}

function levelLabel(level) {
  if (level === 'unknown') return 'čeka izvor';
  if (level === 'heavy' || level === 'critical') return 'gužva';
  if (level === 'slow' || level === 'busy') return 'pojačano';
  return 'protočno';
}

function routeAvailabilityMeta(payload = {}) {
  if (payload.closed || payload.routeStatus === 'closed_or_blocked' || payload.routeStatus === 'route_unavailable') {
    return { label: payload.routeStatus === 'route_unavailable' ? 'Ruta nedostupna' : 'Zatvoreno', className: 'closed' };
  }
  // Honest non-closure state: geometry unverified, wait still valid (T2).
  if (payload.routeStatus === 'route_unverified') return { label: 'Ruta nije potvrđena', className: 'pending' };
  if (payload.routeStatus === 'calibrated_fallback') return { label: 'Kalibrirana zona', className: 'pending' };
  if (payload.routeHidden || payload.routeStatus === 'pending_verification') return { label: 'Provjera rute', className: 'pending' };
  if (payload.live) return { label: 'Ažurirano', className: 'live' };
  if (payload.routes?.length) return { label: 'Validirana ruta', className: 'official' };
  return { label: 'Nema rute', className: 'unavailable' };
}

function makeRouteLabelElement(route) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `gm-route-label ${route.primary ? 'primary' : ''}`;
  const isZone = route.displayMode === 'control_zone';
  el.innerHTML = `
    <span>${isZone ? 'Zona vožnja' : (route.primary ? 'Ruta' : 'Alt.')}</span>
    <strong>${formatMinutes(route.durationMinutes)}</strong>
    <small>${formatDistanceKm(route.distanceKm)}</small>
  `;
  return el;
}

function makeMarkerElement(crossing, isActive, selectedDirection = 'toBih', overrides = {}) {
  const wait = getDisplayedWait(crossing, selectedDirection, overrides);
  const sourceMeta = getWaitSourceMeta(crossing, selectedDirection, overrides);
  const tone = getMarkerTone(crossing, selectedDirection, overrides);
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className = `gm-border-marker gm-border-marker-${tone}${isActive ? ' active' : ''}`;
  const waitLabel = formatWaitDisplay(wait, sourceMeta);
  marker.innerHTML = `
    <span class="gm-marker-dot"></span>
    <strong>${crossing.shortName}</strong>
    <small>Live · ${waitLabel}</small>
    <em class="gm-marker-source ${sourceMeta.className || 'pending'}">${sourceMeta.label}</em>
  `;
  return marker;
}

function makeInfoContent(crossing, selectedDirection, overrides = {}) {
  const direction = getDirection(crossing, selectedDirection);
  const wait = getDisplayedWait(crossing, selectedDirection, overrides);
  const sourceMeta = getWaitSourceMeta(crossing, selectedDirection, overrides);
  const status = statusMeta[statusFromWait(wait)] || statusMeta.unknown;
  return `
    <div class="gm-info-card">
      <div class="gm-info-top">
        <strong>${crossing.name}</strong>
        <span class="gm-info-status ${status.className}">${status.label}</span>
      </div>
      <p>${crossing.route}</p>
      <div class="gm-info-grid">
        <div><span>Smjer</span><b>${direction.label}</b></div>
        <div><span>Osobna</span><b>${hasKnownWait(wait) ? formatWaitDisplay(wait, sourceMeta) : '—'}</b></div>
        <div><span>Izvor</span><b>${sourceMeta.label}</b></div>
        <div><span>Potvrda</span><b>${crossing.fieldConfirmed ? 'Teren' : 'Signal'}</b></div>
      </div>
      <p class="gm-info-note">${crossing.cause}</p>
    </div>
  `;
}

function StaticMapPlaceholder({ selectedDirection, selectedCrossing, setSelectedCrossing, visibleCrossings = CROSSINGS, overrides = {} }) {
  const mapCrossings = visibleCrossings.length ? visibleCrossings : [selectedCrossing];
  const latValues = mapCrossings.map((crossing) => crossing.lat);
  const lngValues = mapCrossings.map((crossing) => crossing.lng);
  const minLat = Math.min(...latValues);
  const maxLat = Math.max(...latValues);
  const minLng = Math.min(...lngValues);
  const maxLng = Math.max(...lngValues);

  function markerPosition(crossing) {
    const left = 8 + ((crossing.lng - minLng) / Math.max(maxLng - minLng, 0.1)) * 84;
    const top = 12 + ((maxLat - crossing.lat) / Math.max(maxLat - minLat, 0.1)) * 72;
    return { left: `${Math.round(left)}%`, top: `${Math.round(top)}%` };
  }

  return (
    <div className="map-canvas">
      <div className="map-road vertical" />
      <div className="map-road diagonal" />
      {mapCrossings.map((crossing) => {
        const wait = getDisplayedWait(crossing, selectedDirection, overrides);
        return (
        <button
          key={crossing.id}
          type="button"
          className={selectedCrossing.id === crossing.id ? 'map-marker active' : 'map-marker'}
          style={markerPosition(crossing)}
          onClick={() => setSelectedCrossing(crossing)}
          title={crossing.name}
        >
          <MapPin size={20} />
          <span>{crossing.shortName}</span>
          <small>Live · {hasKnownWait(wait) ? formatWaitDisplay(wait, getWaitSourceMeta(crossing, selectedDirection, overrides)) : 'čeka izvor'}</small>
        </button>
        );
      })}
      <div className="map-note">Karta trenutno nije dostupna.</div>
    </div>
  );
}

function GoogleMapView({ selectedDirection, selectedCrossing, setSelectedCrossing, showTraffic, focusTraffic, visibleCrossings = CROSSINGS, overrides = {}, stateVersion = 0, measurement }) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const mapId = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || '';
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const trafficLayerRef = useRef(null);
  const routePolylinesRef = useRef([]);
  const routeLabelsRef = useRef([]);
  const infoWindowRef = useRef(null);
  const [routePayload, setRoutePayload] = useState({ live: false, routes: [], note: 'Ruta nije učitana.' });
  const [routeInspectorOpen, setRouteInspectorOpen] = useState(true);
  // Secondary route metrics live behind a "Detalji" toggle so the info box stays small and the
  // primary answer (wait + direction + source + freshness) never competes with the map (T3).
  const [routeDetailsOpen, setRouteDetailsOpen] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState(null);
  // Initialise from the cached loader state: if the script was already warmed (app-startup preload or
  // a previous visit), the init effect runs synchronously on the FIRST mount — same fast path as the
  // working second visit — instead of waiting a tick for setMapsReady and painting a blank map.
  const [mapsReady, setMapsReady] = useState(() => mapsConstructorsReady());
  const [mapError, setMapError] = useState('');

  // ── "Moja lokacija" + A→B measurement. The session/watch/ping live in an APP-LEVEL hook (passed in)
  //    so a measurement keeps running across tab switches; the map only paints the user's own blue dot
  //    and drives the button. No other users are ever shown; no raw location trail is stored. ──
  const [locInfoOpen, setLocInfoOpen] = useState(false);
  const userMarkerRef = useRef(null);
  const didCenterUserRef = useRef(false);
  const { userPos = null, statusText: locStatus = '', liveStatus: locLiveStatus = 'idle', on: locationOn = false } = measurement || {};
  const toggleLocation = () => { if (measurement) measurement.toggle({ crossingId: selectedCrossing.id, direction: 'auto' }); };

  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    let pollTimer = null;
    setMapError('');
    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled) return;
        // The Maps constructors can attach a tick AFTER the loader promise resolves. Poll briefly
        // instead of giving up immediately — otherwise the map stays blank on the FIRST visit and only
        // appears after you leave the tab and come back (the script is cached by then). ~3s budget.
        let tries = 0;
        const check = () => {
          if (cancelled) return;
          if (mapsConstructorsReady()) { setMapsReady(true); return; }
          tries += 1;
          if (tries >= 20) { setMapError('Karta se nije uspjela učitati (Google Maps nije potpuno spreman).'); return; }
          pollTimer = window.setTimeout(check, 150);
        };
        check();
      })
      .catch(() => {
        if (!cancelled) setMapError('Karta se nije uspjela učitati.');
      });
    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [apiKey]);

  useEffect(() => {
    // Hard guard: never touch google.maps constructors unless they are ALL really attached.
    if (!apiKey || !mapsReady || !mapEl.current || !mapsConstructorsReady()) return;

    const google = window.google;
    const mapCrossings = visibleCrossings.length ? visibleCrossings : [selectedCrossing];
    const bounds = new google.maps.LatLngBounds();
    mapCrossings.forEach((crossing) => bounds.extend({ lat: crossing.lat, lng: crossing.lng }));

    const mapOptions = {
      center: { lat: selectedCrossing.lat, lng: selectedCrossing.lng },
      zoom: 7,
      clickableIcons: true,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: true,
    };
    if (mapId) mapOptions.mapId = mapId;

    const map = new google.maps.Map(mapEl.current, mapOptions);

    mapRef.current = map;
    infoWindowRef.current = new google.maps.InfoWindow({
      pixelOffset: new google.maps.Size(0, -8),
    });

    if (mapCrossings.length === 1) {
      map.setCenter({ lat: mapCrossings[0].lat, lng: mapCrossings[0].lng });
      map.setZoom(11);
    } else {
      map.fitBounds(bounds, 84);
    }

    let isMounted = true;
    async function addMarkers() {
      let AdvancedMarkerElement;
      try {
        const markerLib = await google.maps.importLibrary('marker');
        AdvancedMarkerElement = markerLib.AdvancedMarkerElement;
      } catch {
        AdvancedMarkerElement = null;
      }

      if (!isMounted) return;
      markersRef.current.forEach((item) => {
        if (item.marker?.map !== undefined) item.marker.map = null;
        if (item.marker?.setMap) item.marker.setMap(null);
      });
      markersRef.current = [];

      mapCrossings.forEach((crossing) => {
        const markerContent = makeMarkerElement(crossing, crossing.id === selectedCrossing.id, selectedDirection, overrides);
        const position = { lat: crossing.lat, lng: crossing.lng };

        let marker;
        if (AdvancedMarkerElement) {
          marker = new AdvancedMarkerElement({ map, position, title: crossing.name, content: markerContent });
        } else {
          marker = new google.maps.Marker({ map, position, title: crossing.name });
        }

        const openMarkerTooltip = () => {
          const direction = getDirection(crossing, selectedDirection);
          infoWindowRef.current?.setContent(`
            <div class="gm-info-card gm-tooltip-card">
              <strong>${crossing.shortName}</strong>
              <p>${direction.label} · ${formatWaitDisplay(getDisplayedWait(crossing, selectedDirection, overrides), getWaitSourceMeta(crossing, selectedDirection, overrides))}</p>
              <small>Klik za detalje</small>
            </div>
          `);
          infoWindowRef.current?.open({ map, anchor: marker });
        };

        marker.addListener?.('click', () => {
          setSelectedCrossing(crossing);
          map.panTo(position);
          map.setZoom(Math.max(map.getZoom() || 7, 10));
          infoWindowRef.current?.setContent(makeInfoContent(crossing, selectedDirection, overrides));
          infoWindowRef.current?.open({ map, anchor: marker });
        });

        markerContent.addEventListener('mouseenter', openMarkerTooltip);
        markerContent.addEventListener('focus', openMarkerTooltip);
        markerContent.addEventListener('mouseleave', () => infoWindowRef.current?.close());

        markersRef.current.push({ crossingId: crossing.id, marker, markerContent, position });
      });
    }

    addMarkers();

    // The map is created the instant the tab mounts; if the container is still 0-sized (tab switch /
    // layout not settled) Google paints GREY tiles and only fixes itself on a later resize. Force a
    // resize + recenter shortly after mount AND whenever the container actually changes size, so the
    // map renders on the FIRST visit instead of only after leaving + returning to the tab.
    const recenter = () => {
      if (mapCrossings.length === 1) { map.setCenter({ lat: mapCrossings[0].lat, lng: mapCrossings[0].lng }); map.setZoom(11); }
      else if (!bounds.isEmpty()) map.fitBounds(bounds, 84);
    };
    // A plain resize nudge fixes grey/unpainted tiles WITHOUT touching the viewport (it preserves the
    // user's center/zoom). recenter() (setZoom/fitBounds) must run ONLY ONCE for the initial framing —
    // calling it on the 120/600 ms timers was snapping the viewport back the instant the user started
    // zooming ("zoom pa odmah odzoom"). After the first framing we never override the user again.
    const nudgeResize = () => {
      if (!isMounted || !mapEl.current) return;
      window.google.maps.event.trigger(map, 'resize');
    };
    let framed = false;
    const frameOnce = () => { nudgeResize(); if (!framed) { framed = true; recenter(); } };
    // The reliable first nudge is the map's OWN `idle` event (fires once Google attempts the first tile
    // render against the laid-out container) — there we resize AND do the one-time initial framing.
    const idleListener = window.google.maps.event.addListenerOnce(map, 'idle', frameOnce);
    let raf1 = 0; let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => { raf2 = window.requestAnimationFrame(nudgeResize); });
    const tA = window.setTimeout(nudgeResize, 120);
    const tB = window.setTimeout(nudgeResize, 600);
    let resizeObs = null;
    if (typeof ResizeObserver !== 'undefined' && mapEl.current) {
      resizeObs = new ResizeObserver(() => nudgeResize());
      resizeObs.observe(mapEl.current);
    }

    return () => {
      isMounted = false;
      window.clearTimeout(tA);
      window.clearTimeout(tB);
      if (raf1) window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      if (idleListener && window.google?.maps?.event) window.google.maps.event.removeListener(idleListener);
      if (resizeObs) resizeObs.disconnect();
      markersRef.current.forEach((item) => {
        if (item.marker?.map !== undefined) item.marker.map = null;
        if (item.marker?.setMap) item.marker.setMap(null);
      });
      markersRef.current = [];
    };
  }, [apiKey, mapsReady, mapId, selectedDirection, setSelectedCrossing, visibleCrossings]);

  useEffect(() => {
    markersRef.current.forEach((item) => {
      const crossing = CROSSINGS.find((entry) => entry.id === item.crossingId);
      if (!crossing || !item.markerContent) return;
      const refreshed = makeMarkerElement(crossing, crossing.id === selectedCrossing.id, selectedDirection, overrides);
      item.markerContent.className = refreshed.className;
      item.markerContent.innerHTML = refreshed.innerHTML;
    });
  }, [stateVersion, overrides, selectedDirection, selectedCrossing.id]);

  useEffect(() => {
    if (!mapRef.current || !mapsConstructorsReady()) return;
    const google = window.google;

    if (trafficLayerRef.current) {
      trafficLayerRef.current.setMap(null);
      trafficLayerRef.current = null;
    }

    if (showTraffic) {
      trafficLayerRef.current = new google.maps.TrafficLayer();
      trafficLayerRef.current.setMap(mapRef.current);
    }

    return () => {
      if (trafficLayerRef.current) {
        trafficLayerRef.current.setMap(null);
        trafficLayerRef.current = null;
      }
    };
  }, [showTraffic, mapsReady]);

  useEffect(() => {
    let cancelled = false;
    async function loadCrossingRoutes() {
      if (!focusTraffic) {
        updateRouteSanityWait(selectedCrossing, selectedDirection, null, overrides);
        setRoutePayload({ live: false, routes: [], note: 'Ruta je isključena.' });
        setSelectedRoute(null);
        setRouteInspectorOpen(false);
        return;
      }
      try {
        const payload = await fetchJson(`/api/routes/${selectedCrossing.id}?direction=${selectedDirection}`);
        if (!cancelled) {
          const primary = payload?.routes?.find((route) => route.primary) || payload?.routes?.[0] || null;
          updateRouteSanityWait(selectedCrossing, selectedDirection, primary, overrides);
          setRoutePayload(payload);
          setSelectedRoute(null);
          setRouteInspectorOpen(Boolean(payload?.routes?.length));
          // The route fetch just persisted a fresh Google snapshot server-side — push a sync
          // public-state reload so the marker/headline reflect it now, not at the next poll.
          if (payload?.live) dispatchLiveSignal();
        }
      } catch {
        if (!cancelled) {
          updateRouteSanityWait(selectedCrossing, selectedDirection, null, overrides);
          setRoutePayload({ live: false, routes: [], note: 'Ruta trenutno nije dostupna.' });
          setRouteInspectorOpen(false);
        }
      }
    }

    loadCrossingRoutes();
    // Refresh the map route + traffic more often (60s) so the zone tracks live congestion.
    const timer = window.setInterval(loadCrossingRoutes, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [focusTraffic, selectedDirection, selectedCrossing.id, overrides]);

  useEffect(() => {
    // Route polylines use google.maps.Polyline/LatLngBounds — guard on the full constructor set.
    if (!mapRef.current || !mapsConstructorsReady()) return;
    const google = window.google;
    const map = mapRef.current;

    routePolylinesRef.current.forEach((polyline) => polyline.setMap(null));
    routePolylinesRef.current = [];
    routeLabelsRef.current.forEach((item) => {
      if (item?.map !== undefined) item.map = null;
      if (item?.setMap) item.setMap(null);
    });
    routeLabelsRef.current = [];

    if (!focusTraffic || !Array.isArray(routePayload.routes) || !routePayload.routes.length) return;

    let cancelled = false;
    async function drawRoutes() {
      const bounds = new google.maps.LatLngBounds();
      let AdvancedMarkerElement = null;
      try {
        const markerLib = await google.maps.importLibrary('marker');
        AdvancedMarkerElement = markerLib.AdvancedMarkerElement;
      } catch {
        AdvancedMarkerElement = null;
      }
      if (cancelled) return;

      routePayload.routes.forEach((route, index) => {
        // Prefer the tidy simplified corridor (server display geometry) over the raw Google path so
        // the line does not wiggle / look like it leaves the road. Falls back to the raw path.
        const zone = route.displayZone || null;
        const cleanCorridor = zone && Array.isArray(zone.displayCorridorPolyline) && zone.displayCorridorPolyline.length >= 2
          ? zone.displayCorridorPolyline
          : null;
        const path = cleanCorridor || route.path || [];
        if (!path.length) return;
        path.forEach((point) => bounds.extend(point));

        // Soft "Provjerena zona" ribbon for the primary route — ONLY when the geometry is genuinely
        // road-shaped. A straight-line fallback must not be painted as a validated zone.
        if (route.primary && routeGeometryValidated(path) && google.maps.Polygon && zone && Array.isArray(zone.measurementZonePolygon) && zone.measurementZonePolygon.length >= 4) {
          const zonePolygon = new google.maps.Polygon({
            paths: zone.measurementZonePolygon,
            map,
            strokeColor: getRouteToneColor(route.level, true),
            strokeOpacity: 0.35,
            strokeWeight: 1,
            fillColor: getRouteToneColor(route.level, true),
            fillOpacity: 0.12,
            clickable: false,
            zIndex: 6,
          });
          zonePolygon.getPaths?.().forEach?.((ring) => ring.forEach?.((pt) => bounds.extend(pt)));
          routePolylinesRef.current.push(zonePolygon);
        }

        // Don't draw a straight-line fallback as a route line — if the geometry isn't a genuine
        // road shape, drawing it would imply a confirmed route we don't have (the box already says
        // "Rutu trenutno ne možemo potvrditi"). The crossing marker still shows; the line does not.
        if (!routeGeometryValidated(path)) return;

        const basePolyline = new google.maps.Polyline({
          path,
          map,
          strokeColor: getRouteToneColor(route.level, route.primary),
          strokeOpacity: route.primary ? 0.92 : 0.54,
          strokeWeight: route.primary ? 7 : 5,
          zIndex: route.primary ? 38 : 28 - index,
        });

        const hitboxPolyline = new google.maps.Polyline({
          path,
          map,
          strokeColor: '#000000',
          strokeOpacity: 0,
          strokeWeight: 22,
          zIndex: route.primary ? 58 : 48 - index,
        });

        const openRouteTooltip = (position) => {
          infoWindowRef.current?.setContent(`
            <div class="gm-info-card gm-tooltip-card">
              <strong>${route.label}</strong>
              <p>${formatMinutes(route.durationMinutes)} · ${formatDistanceKm(route.distanceKm)}</p>
              <small>Zastoj ${formatMinutes(route.delayMinutes || 0)} · klik za detalje</small>
            </div>
          `);
          infoWindowRef.current?.setPosition(position || path[Math.floor(path.length / 2)] || path[0]);
          infoWindowRef.current?.open({ map });
        };

        hitboxPolyline.addListener('mouseover', (event) => {
          basePolyline.setOptions({ strokeWeight: route.primary ? 10 : 8, strokeOpacity: 1 });
          openRouteTooltip(event.latLng);
        });
        hitboxPolyline.addListener('mouseout', () => {
          basePolyline.setOptions({ strokeWeight: route.primary ? 7 : 5, strokeOpacity: route.primary ? 0.92 : 0.54 });
          infoWindowRef.current?.close();
        });
        hitboxPolyline.addListener('click', () => { setSelectedRoute(route); setRouteInspectorOpen(true); });

        routePolylinesRef.current.push(basePolyline, hitboxPolyline);

        const trafficSegments = route.trafficSegments || [];
        trafficSegments.forEach((segment) => {
          const segmentPath = segment.path || [];
          if (segmentPath.length < 2) return;
          const trafficPolyline = new google.maps.Polyline({
            path: segmentPath,
            map,
            strokeColor: getTrafficSegmentColor(segment.speed || segment.level),
            strokeOpacity: 0.98,
            strokeWeight: route.primary ? 5 : 3,
            zIndex: route.primary ? 44 : 34 - index,
          });
          trafficPolyline.addListener('click', () => { setSelectedRoute(route); setRouteInspectorOpen(true); });
          routePolylinesRef.current.push(trafficPolyline);
        });

        const mid = route.labelPosition || route.borderPoint || path[Math.floor(path.length / 2)] || path[0];
        if (mid) {
          const labelEl = makeRouteLabelElement(route);
          labelEl.addEventListener('click', () => { setSelectedRoute(route); setRouteInspectorOpen(true); });
          let routeLabel;
          if (AdvancedMarkerElement) {
            routeLabel = new AdvancedMarkerElement({ map, position: mid, content: labelEl, title: route.label });
          } else {
            routeLabel = new google.maps.Marker({ map, position: mid, label: String(index + 1), title: route.label });
          }
          routeLabelsRef.current.push(routeLabel);
        }
      });

      if (!bounds.isEmpty()) map.fitBounds(bounds, 70);
    }

    drawRoutes();

    return () => {
      cancelled = true;
      routePolylinesRef.current.forEach((polyline) => polyline.setMap(null));
      routePolylinesRef.current = [];
      routeLabelsRef.current.forEach((item) => {
        if (item?.map !== undefined) item.map = null;
        if (item?.setMap) item.setMap(null);
      });
      routeLabelsRef.current = [];
    };
  }, [focusTraffic, mapsReady, routePayload]);

  useEffect(() => {
    if (!mapRef.current || !window.google?.maps) return;
    const map = mapRef.current;
    const position = { lat: selectedCrossing.lat, lng: selectedCrossing.lng };

    if (!focusTraffic || visibleCrossings.length === 1) {
      map.panTo(position);
      if (visibleCrossings.length === 1) map.setZoom(Math.max(map.getZoom() || 7, 11));
    }

    markersRef.current.forEach((item) => {
      const isActive = item.crossingId === selectedCrossing.id;
      item.markerContent.classList.toggle('active', isActive);
    });
  }, [selectedCrossing, selectedDirection, focusTraffic, visibleCrossings]);

  // Render ONLY the current user's own blue-dot location (never other users). First fix centres; later
  // fixes just move the dot, so we don't fight the user panning the map.
  useEffect(() => {
    if (!mapRef.current || !window.google?.maps) return;
    const google = window.google;
    const map = mapRef.current;
    if (!userPos) {
      if (userMarkerRef.current) { if (userMarkerRef.current.map !== undefined) userMarkerRef.current.map = null; if (userMarkerRef.current.setMap) userMarkerRef.current.setMap(null); userMarkerRef.current = null; }
      didCenterUserRef.current = false;
      return;
    }
    const pos = { lat: userPos.lat, lng: userPos.lng };
    if (!userMarkerRef.current) {
      const dot = document.createElement('div');
      dot.className = 'user-location-dot';
      dot.title = 'Moja lokacija';
      if (google.maps.marker?.AdvancedMarkerElement) {
        userMarkerRef.current = new google.maps.marker.AdvancedMarkerElement({ map, position: pos, content: dot, title: 'Moja lokacija', zIndex: 80 });
      } else {
        userMarkerRef.current = new google.maps.Marker({ map, position: pos, title: 'Moja lokacija', zIndex: 80, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 } });
      }
    } else if (userMarkerRef.current.position !== undefined) {
      userMarkerRef.current.position = pos;
    } else if (userMarkerRef.current.setPosition) {
      userMarkerRef.current.setPosition(pos);
    }
    if (!didCenterUserRef.current) { didCenterUserRef.current = true; map.panTo(pos); }
  }, [userPos]);

  if (!apiKey) return <StaticMapPlaceholder selectedDirection={selectedDirection} selectedCrossing={selectedCrossing} setSelectedCrossing={setSelectedCrossing} visibleCrossings={visibleCrossings} overrides={overrides} />;

  const routes = routePayload.routes || [];
  const primaryRoute = routes.find((route) => route.primary) || routes[0];
  const activeRoute = selectedRoute || primaryRoute;
  const isControlZoneDisplay = routePayload.displayMode === 'control_zone' || activeRoute?.displayMode === 'control_zone' || primaryRoute?.displayMode === 'control_zone';
  const zone = routePayload.zone || getZone(selectedCrossing, selectedDirection);
  const routeMeta = routeAvailabilityMeta(routePayload);
  // Is the primary route's geometry a genuine road shape (not a straight-line fallback)? Gates the
  // "provjerena zona" wording + the secondary zone/traffic metrics (Item 1/3: show only when validated).
  const primaryDisplayPath = (Array.isArray(primaryRoute?.displayZone?.displayCorridorPolyline) && primaryRoute.displayZone.displayCorridorPolyline.length >= 2)
    ? primaryRoute.displayZone.displayCorridorPolyline
    : (primaryRoute?.path || []);
  const routeValidated = routeGeometryValidated(primaryDisplayPath);
  const showZoneMetrics = primaryRoute && (!isControlZoneDisplay || routeValidated);
  const borderWait = getDisplayedWait(selectedCrossing, selectedDirection, overrides);
  const borderSourceMeta = getWaitSourceMeta(selectedCrossing, selectedDirection, overrides);
  const borderRange = hasKnownWait(borderSourceMeta.rangeMin) && hasKnownWait(borderSourceMeta.rangeMax)
    ? `${formatMinutes(borderSourceMeta.rangeMin)}–${formatMinutes(borderSourceMeta.rangeMax)}`
    : '';
  const suggestedCrossing = routePayload.suggestedCrossing ? CROSSINGS.find((item) => item.id === routePayload.suggestedCrossing.crossingId) : null;

  return (
    <div className="google-map-wrap">
      <div ref={mapEl} className="google-map" />
      {!mapsReady && !mapError && <div className="map-loading">Učitavam kartu…</div>}
      {mapError && <div className="map-error">{mapError}</div>}

      {/* Google-Maps-style "Moja lokacija" control. Small, unobtrusive; lives near the map controls. */}
      {mapsReady && (
        <div className="map-location-control">
          <button
            type="button"
            className={`map-location-button${locationOn ? ' active' : ''}`}
            onClick={toggleLocation}
            title="Moja lokacija"
            aria-label="Moja lokacija"
            aria-pressed={locationOn}
          >
            <Crosshair size={18} aria-hidden="true" />
          </button>
          <button type="button" className="map-location-info" onClick={() => setLocInfoOpen((v) => !v)} aria-label="Info o lokaciji" title="Info">i</button>
          {locInfoOpen && (
            <div className="map-location-popover" role="dialog">
              <p>Lokacija prikazuje tvoju poziciju na mapi. Ako prolaziš kroz zonu prijelaza, anonimni signal prolaska može pomoći da live procjene budu točnije. Ne spremamo tvoju rutu i ne prikazujemo tvoju lokaciju drugim korisnicima.</p>
              <button type="button" onClick={() => setLocInfoOpen(false)}>U redu</button>
            </div>
          )}
        </div>
      )}
      {locStatus && (
        <div className={`map-location-toast${locLiveStatus === 'active' ? ' live' : ''}`} role="status">
          {locStatus}
          {locLiveStatus === 'active' && <span className="loc-live-dot" aria-hidden="true" />}
        </div>
      )}
      {routes.some((route) => (route.trafficSegments || []).length > 0) && (
        <div className="map-traffic-legend" aria-label="Legenda prometa">
          <span><i className="legend-dot normal" /> protočno</span>
          <span><i className="legend-dot slow" /> usporeno</span>
          <span><i className="legend-dot jam" /> gužva</span>
        </div>
      )}
      {focusTraffic && (
        <div className={`traffic-focus-card route-focus-card production-route-card route-status-${routeMeta.className}`}>
          <div className="traffic-focus-head">
            <strong>{selectedCrossing.shortName} {isControlZoneDisplay ? 'prometna zona' : 'ruta'}</strong>
            <span className={`route-state-badge ${routeMeta.className}`}>{routeMeta.label}</span>
          </div>
          {routePayload.closed ? (
            <div className="route-closed-panel">
              <strong>Ruta trenutno nije prohodna</strong>
              <p>{routePayload.note || 'Most ili granična ruta trenutno izgledaju zatvoreno/preusmjereno.'}</p>
              {routePayload.reopenPolicy && <small>{routePayload.reopenPolicy}</small>}
              {suggestedCrossing && (
                <button
                  type="button"
                  className="route-alternative-button"
                  onClick={() => setSelectedCrossing(suggestedCrossing)}
                >
                  {routePayload.suggestedCrossing?.label || `Prikaži ${suggestedCrossing.shortName}`}
                </button>
              )}
            </div>
          ) : (
            <>
              {/* PRIMARY summary: the answer a driver needs — wait, direction, source, freshness.
                  Always shown, even when the route geometry is unavailable (the wait is a separate,
                  still-valid signal). Everything route-specific lives behind "Detalji". */}
              <div className="route-summary compact-route-summary">
                <div className="route-summary-primary">
                  <span>Čekanje na granici · {getDirection(selectedCrossing, selectedDirection).label}</span>
                  <b>{formatWaitDisplay(borderWait, borderSourceMeta)}</b>
                  {borderSourceMeta.hasSoftUpperBoundPublic && <small className="wait-qualifier">procjena</small>}
                </div>
                <div className="route-summary-meta">
                  <span className={`source-badge mini ${borderSourceMeta.className || 'pending'}`}>{borderSourceMeta.label}</span>
                  <span className={`freshness-pill ${getFreshnessMeta(borderSourceMeta, selectedCrossing).className}`}>{getFreshnessMeta(borderSourceMeta, selectedCrossing).label}</span>
                  <span className={`confidence-pill tone-${confidenceMetaLabel(borderSourceMeta).tone}`}>{confidenceMetaLabel(borderSourceMeta).label}</span>
                </div>
              </div>
              {((isControlZoneDisplay && !routeValidated) || routePayload.routeUnavailable || (!primaryRoute && !routePayload.live)) && (
                <div className="route-unconfirmed-panel">
                  <strong>⚠ Rutu trenutno ne možemo potvrditi</strong>
                  <p>Nemamo pouzdanu geometriju ceste preko ovog prijelaza. Prikazujemo samo čekanje na granici — provjeri stanje prije polaska.</p>
                  {suggestedCrossing && (
                    <button type="button" className="route-alternative-button" onClick={() => setSelectedCrossing(suggestedCrossing)}>
                      {routePayload.suggestedCrossing?.label || `Prikaži ${suggestedCrossing.shortName}`}
                    </button>
                  )}
                </div>
              )}
              <div className="route-signal-badges">
                {borderSourceMeta.hasGoogleSignal && !borderSourceMeta.hasStrongCameraQueue && routeLooksClear(primaryRoute) && (
                  <span className="signal-badge signal-google-clear">Prometnica prohodna</span>
                )}
                {borderSourceMeta.hasSoftUpperBoundPublic && !borderSourceMeta.hasStrongCameraQueue && (
                  <span className="signal-badge signal-soft-bound">Okvirna procjena</span>
                )}
                {borderSourceMeta.hasCameraSignal && !borderSourceMeta.hasStrongCameraQueue && (
                  <span className="signal-badge signal-camera-ok">Kamera: bez kolone</span>
                )}
                {borderSourceMeta.hasStrongCameraQueue && (
                  <span className="signal-badge signal-camera-queue">Kamera: kolona vidljiva</span>
                )}
                {routePayload.live && routePayload.trafficAvailable === false && (
                  <span className="signal-badge signal-soft-bound" title="Google nije vratio podatke o gustoći prometa za ovu dionicu — linija je plava jer nema žive procjene, ne zato što je dokazano prohodno.">Promet: podaci nedostupni</span>
                )}
              </div>
              {/* Route metrics ("Vožnja kroz zonu", "Dionica zone", "Cestovni zastoj") show ONLY for a
                  validated road geometry, and only inside the collapsed Detalji section (T3). */}
              {showZoneMetrics && (
                <button type="button" className="route-details-toggle" onClick={() => setRouteDetailsOpen((value) => !value)}>
                  {routeDetailsOpen ? 'Sakrij detalje rute' : 'Detalji rute'}
                </button>
              )}
              {showZoneMetrics && routeDetailsOpen && (
                <>
                  <div className="route-summary route-details-grid">
                    <div><span>{isControlZoneDisplay ? 'Vožnja kroz zonu' : 'Trajanje rute'}</span><b>{formatMinutes(primaryRoute.durationMinutes)}</b></div>
                    <div><span>{isControlZoneDisplay ? 'Dionica zone' : 'Udaljenost'}</span><b>{formatDistanceKm(primaryRoute.distanceKm)}</b></div>
                    {routePayload.trafficAvailable !== false && <div><span>Cestovni zastoj</span><b>{formatMinutes(primaryRoute.delayMinutes || 0)}</b></div>}
                  </div>
                  {!!routes.length && !(isControlZoneDisplay && !routeValidated) && (
                    <div className="traffic-segments">
                      {routes.map((route) => (
                        <button type="button" className={selectedRoute?.id === route.id ? 'traffic-segment-row active' : 'traffic-segment-row'} key={route.id} onClick={() => { setSelectedRoute(route); setRouteInspectorOpen(true); }}>
                          <i style={{ background: getRouteToneColor(route.level, route.primary) }} />
                          <span>{route.label}</span>
                          <b>{formatMinutes(route.durationMinutes)} · {formatDistanceKm(route.distanceKm)}</b>
                        </button>
                      ))}
                    </div>
                  )}
                  {borderSourceMeta.note && <p className="route-note">{borderSourceMeta.note}</p>}
                  {(routePayload.note || primaryRoute?.displayNote) && <p className="route-note">{routePayload.note || primaryRoute?.displayNote}</p>}
                </>
              )}
              {!showZoneMetrics && routePayload.note && !routePayload.routeUnavailable && !(isControlZoneDisplay && !routeValidated) && (
                <p className="route-note">{routePayload.note}</p>
              )}
            </>
          )}
        </div>
      )}
      {focusTraffic && routeInspectorOpen && activeRoute && !(isControlZoneDisplay && !routeValidated) && (
        <div className="route-inspector-card">
          <button type="button" className="mini-close" onClick={() => setRouteInspectorOpen(false)}>×</button>
          <span>{activeRoute.label}</span>
          <strong>{formatMinutes(activeRoute.durationMinutes)}</strong>
          <p>{isControlZoneDisplay ? `${zone.border || selectedCrossing.shortName} · provjerena dionica` : `${zone.from} → ${zone.to}`}</p>
          <div>
            <b>{formatDistanceKm(activeRoute.distanceKm)}</b>
            <b>Zastoj {formatMinutes(activeRoute.delayMinutes || 0)}</b>
          </div>
        </div>
      )}
    </div>
  );
}

function MapView({ selectedDirection, setSelectedDirection, selectedCrossing, setSelectedCrossing, requestedMode = 'map', overrides = {}, stateVersion = 0, measurement }) {
  const [mode, setMode] = useState(requestedMode || 'map');
  const [showTraffic, setShowTraffic] = useState(true);
  const [focusTraffic, setFocusTraffic] = useState(true);
  const [mapSearch, setMapSearch] = useState('');
  const [focusedOnly, setFocusedOnly] = useState(false);
  const direction = getDirection(selectedCrossing, selectedDirection);

  useEffect(() => {
    if (requestedMode) setMode(requestedMode);
  }, [requestedMode]);

  const filteredCrossings = useMemo(() => {
    const needle = normalizeSearchText(mapSearch);
    if (!needle) return CROSSINGS;
    return CROSSINGS.filter((crossing) => [crossing.name, crossing.shortName, crossing.route, crossing.area]
      .map(normalizeSearchText)
      .some((value) => value.includes(needle)));
  }, [mapSearch]);

  const visibleCrossings = useMemo(() => focusedOnly ? [selectedCrossing] : filteredCrossings, [focusedOnly, selectedCrossing, filteredCrossings]);

  function focusCrossing(crossing) {
    setSelectedCrossing(crossing);
    setFocusedOnly(true);
    setFocusTraffic(true);
  }

  function showAllCrossings() {
    setFocusedOnly(false);
    setMapSearch('');
  }

  return (
    <section className="screen">
      <div className="screen-head">
        <div><span className="kicker">Mapa</span><h2>Lokacije, promet i kamere</h2></div>
        <div className="mode-toggle">
          <button className={mode === 'map' ? 'active' : ''} onClick={() => setMode('map')}>Mapa</button>
          <button className={mode === 'camera' ? 'active' : ''} onClick={() => setMode('camera')}><Camera size={15} /> Kamere</button>
        </div>
      </div>

      {typeof setSelectedDirection === 'function' && (
        <DirectionToggle value={selectedDirection} onChange={setSelectedDirection} compact neighbor={selectedCrossing?.neighbor} />
      )}

      {mode === 'map' && (
        <div className="map-tool-panel clean-map-tools">
          <div>
            <strong>Rute i promet</strong>
            <span>Marker prikazuje čekanje za odabrani smjer čim stigne svježi javni izvor, kamera, izmjereni prelazak ili potvrda tima.</span>
          </div>
          <div className="map-layer-controls">
            <button type="button" className={showTraffic ? 'active' : ''} onClick={() => setShowTraffic((value) => !value)}>Promet</button>
            <button type="button" className={focusTraffic ? 'active' : ''} onClick={() => setFocusTraffic((value) => !value)}>{selectedCrossing.shortName} ruta</button>
            <button type="button" className={focusedOnly ? 'active' : ''} onClick={() => setFocusedOnly((value) => !value)}>{focusedOnly ? 'Fokus granica' : 'Sve granice'}</button>
          </div>
        </div>
      )}

      <div className="map-layout">
        <div>{mode === 'map'
          ? <GoogleMapView selectedDirection={selectedDirection} selectedCrossing={selectedCrossing} setSelectedCrossing={setSelectedCrossing} showTraffic={showTraffic} focusTraffic={focusTraffic} visibleCrossings={visibleCrossings} overrides={overrides} stateVersion={stateVersion} measurement={measurement} />
          : <CameraPanel crossing={selectedCrossing} selectedDirection={selectedDirection} onLiveSignalUpdated={dispatchLiveSignal} />}</div>
        <aside className="map-side">
          {mode === 'map' && (
            <div className="map-filter-card">
              <div className="map-filter-head">
                <div>
                  <span>Granice na mapi</span>
                  <strong>{focusedOnly ? selectedCrossing.shortName : `${filteredCrossings.length}/${CROSSINGS.length}`}</strong>
                </div>
                <button type="button" onClick={showAllCrossings}>Sve</button>
              </div>
              <label className="map-filter-search">
                <Search size={15} />
                <input value={mapSearch} onChange={(event) => { setMapSearch(event.target.value); setFocusedOnly(false); }} placeholder="Traži prijelaz..." />
              </label>
              <div className="map-filter-switches" aria-label="Filter prikaza mape">
                <button type="button" className={!focusedOnly ? 'active' : ''} onClick={() => setFocusedOnly(false)}>Prikaži sve</button>
                <button type="button" className={focusedOnly ? 'active' : ''} onClick={() => setFocusedOnly(true)}>Samo odabrana</button>
              </div>
              <div className="map-crossing-filter-list">
                {filteredCrossings.length ? filteredCrossings.map((crossing) => {
                  const wait = getDisplayedWait(crossing, selectedDirection, overrides);
                  const sourceMeta = getWaitSourceMeta(crossing, selectedDirection, overrides);
                  const status = statusFromWait(wait);
                  return (
                    <button
                      key={crossing.id}
                      type="button"
                      className={`map-crossing-filter-row ${selectedCrossing.id === crossing.id ? 'active' : ''} ${status}`}
                      onClick={() => focusCrossing(crossing)}
                    >
                      <span>
                        <b>{crossing.shortName}</b>
                        <small>{crossing.route}</small>
                      </span>
                      <strong>{hasKnownWait(wait) ? formatWaitDisplay(wait, sourceMeta) : '—'}</strong>
                      <em>Live</em>
                      <i className={`source-badge mini ${sourceMeta.className}`}>{sourceMeta.label}</i>
                    </button>
                  );
                }) : <p className="map-filter-empty">Nema prijelaza za ovaj filter.</p>}
              </div>
            </div>
          )}
          <RoadSign crossing={selectedCrossing} direction={direction} wait={getDisplayedWait(selectedCrossing, selectedDirection, overrides)} sourceMeta={getWaitSourceMeta(selectedCrossing, selectedDirection, overrides)} />
          <div className="map-info">
            <FieldBadge crossing={selectedCrossing} />
            <h3>{selectedCrossing.name}</h3>
            <p>{selectedCrossing.cause}</p>
            <p>{direction.bottleneckText}</p>
          </div>
          <PredictionBreakdown sourceMeta={getWaitSourceMeta(selectedCrossing, selectedDirection, overrides)} />
          <div className="zone-card">
            <span>Zona mjerenja</span>
            <strong>{getZone(selectedCrossing, selectedDirection).from}</strong>
            <i>{getZone(selectedCrossing, selectedDirection).via}</i>
            <strong>{getZone(selectedCrossing, selectedDirection).to}</strong>
          </div>
        </aside>
      </div>
    </section>
  );
}

// Traffic + Vision v2 source breakdown — shows WHY we are better than a plain HAK/BIHAMK reprint:
// our own estimate computed from the AI camera (YOLO queue) + Google border traffic + ground truth.
function PredictionBreakdown({ sourceMeta = {} }) {
  const p = sourceMeta.predictionV2;
  if (!p || p.error || !p.sourceBreakdown) return null;
  const b = p.sourceBreakdown || {};
  const rows = [];
  const cam = b.yoloCamera || null;
  const camQueue = cam ? (cam.estimatedQueueVehicles ?? cam.vehiclesInQueueRoi) : null;
  if (cam && camQueue !== null && camQueue !== undefined) {
    // ROI-calibrated → "u stvarnoj koloni" (we counted only the queue lane); else orientational.
    const roiPart = cam.roiCalibrated ? ' u stvarnoj koloni' : ' u koloni (orijentacijski, niža pouzdanost)';
    // Multi-frame stopped-vs-moving (only when the tracker actually ran across frames).
    let movePart = '';
    if (cam.multiFrameUsed) {
      if (cam.queueMovingSlowly || Number(cam.stoppedVehicleRatio || 0) >= 0.6) movePart = ' — većina stoji';
      else if (Number(cam.movingVehicleRatio || 0) >= 0.6) movePart = ' — kolona se pomiče';
    }
    rows.push({ icon: '📷', text: `Kamera: ${camQueue} vozila${roiPart}${movePart}` });
  }
  if (b.googleTraffic && b.googleTraffic.delayMin !== null && b.googleTraffic.delayMin !== undefined) {
    rows.push({ icon: '🚗', text: `Google promet: ${b.googleTraffic.delayMin > 0 ? `+${b.googleTraffic.delayMin} min usporenja` : 'bez zastoja'} na prilazu` });
  }
  // Verified live-location signal (anonymous A→B passes). Subtle copy — never "tracking"/"GPS".
  const vl = b.verifiedLocation || null;
  if (vl && vl.available && (vl.freshSampleCount > 0 || vl.sampleCount > 0)) {
    const ageMin = Number.isFinite(Number(vl.latestAgeSeconds)) ? Math.max(1, Math.round(vl.latestAgeSeconds / 60)) : null;
    if ((vl.freshSampleCount || 0) >= 2) {
      rows.push({ icon: '📍', text: `Potvrđeno live signalima — ${vl.freshSampleCount} anonimna prolaska${ageMin ? ` u zadnjih ${ageMin} min` : ''}` });
    } else {
      rows.push({ icon: '📍', text: 'Jedan svježi live signal potvrđuje procjenu' });
    }
  } else if (vl && vl.waitMin !== null && vl.waitMin !== undefined) {
    rows.push({ icon: '📍', text: 'Potvrđeno live signalom prolaska' });
  }
  if (b.publicSource && b.publicSource.waitMin !== null && b.publicSource.waitMin !== undefined) {
    rows.push({ icon: '🏛️', text: `Javni izvor: ${formatMinutes(b.publicSource.waitMin)}` });
  }
  if (!rows.length) return null;
  const confLabel = p.confidenceLabel === 'high' ? 'visoka' : p.confidenceLabel === 'medium' ? 'srednja' : 'niska';
  const shaped = shapeWaitDisplay(p.expectedWaitMin, {
    confidenceLabel: p.confidenceLabel,
    rangeMin: p.rangeMin,
    rangeMax: p.rangeMax,
    precision: p.rangeMin !== undefined && p.rangeMax !== undefined ? 'range' : undefined,
  });
  return (
    <div className={`prediction-breakdown conf-${p.confidenceLabel || 'low'}`}>
      <div className="prediction-breakdown-head">
        <span>Procjena: {shaped.primaryLabel}</span>
        <span className="prediction-conf">Pouzdanost: {confLabel}</span>
      </div>
      {shaped.displayRangeLabel && <p className="prediction-display-note">Sirovi raspon je sažet za korisnički prikaz: {shaped.displayRangeLabel}</p>}
      <ul className="prediction-breakdown-list">
        {rows.map((r, i) => <li key={i}><span aria-hidden="true">{r.icon}</span> {r.text}</li>)}
      </ul>
      {p.explanation ? <p className="prediction-breakdown-why">{p.explanation}</p> : null}
    </div>
  );
}

function VehicleVisionOverlay() {
  // Staging: ne prikazujemo AI/detection demo overlaye, bounding boxove,
  // confidence postotke ni linije preko javnih snapshotova dok stvarni CV nije uključen.
  return null;
}

function CameraFeed({ cam, refreshKey, signal, crossingId }) {
  // Ne pokušavamo iframeati HAK/BIHAMK stranice jer one često šalju
  // X-Frame-Options/CSP i browser ih blokira. Umjesto toga svaku poznatu
  // kameru učitavamo kroz backend proxy; backend zna izvući direktni JPG
  // čak i kad je u konfiguraciji upisan samo HAK `kamera.asp` page URL.
  // External live-VIDEO cameras (e.g. the Montenegro MUP HLS streams at Hum/Deleuša) can't be served as
  // a still image through the proxy/snapshot pipeline, so skip the image entirely and show a clear
  // "open live video" link instead of a misleading "image temporarily unavailable" notice.
  if (cam?.external) return <ExternalCameraNotice cam={cam} live />;
  const proxiedImageUrl = crossingId && cam?.id
    ? `/api/camera-image/${encodeURIComponent(crossingId)}/${encodeURIComponent(cam.id)}?t=${refreshKey}`
    : '';
  const previewImage = cam.previewImage || '';
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);

  // Reset the failure state whenever the camera, crossing or refresh cycle changes, so a
  // transient proxy hiccup never permanently pins the UI to the fallback/preview image.
  useEffect(() => {
    setPrimaryFailed(false);
    setFallbackFailed(false);
  }, [cam?.id, crossingId, refreshKey]);

  // 1) Always prefer the LIVE proxy image (real HAK/BIHAMK/AMS frame). The local preview is
  //    only a placeholder and must never win over a working live source.
  if (proxiedImageUrl && !primaryFailed) {
    return (
      <div className="camera-live-frame vision-frame">
        <img src={proxiedImageUrl} alt={`${cam.label} kamera`} loading="lazy" onError={() => setPrimaryFailed(true)} />
        <VehicleVisionOverlay signal={signal} />
      </div>
    );
  }

  // 2) Proxy unavailable → fall back to the bundled preview image if one exists.
  if (previewImage && !fallbackFailed) {
    return (
      <div className="camera-live-frame vision-frame">
        <img src={previewImage} alt={`${cam.label} kamera`} loading="lazy" onError={() => setFallbackFailed(true)} />
        <VehicleVisionOverlay signal={signal} />
      </div>
    );
  }

  // 3) Neither live proxy nor preview worked → external source notice.
  return <ExternalCameraNotice cam={cam} />;
}

function ExternalCameraNotice({ cam, compact = false, live = false }) {
  return (
    <div className={compact ? 'external-camera-note compact' : 'camera-live-frame external-camera-note'}>
      <div className="external-camera-icon"><AlertTriangle size={18} /></div>
      <div>
        <strong>{live ? 'Live video kamera (vanjski izvor)' : 'Slika trenutno nije dostupna iz izvora'}</strong>
        <p>{live
          ? 'Ovaj prijelaz ima živu video kameru koju ne prikazujemo unutar aplikacije (video stream, ne slika). Otvori je uživo na izvoru.'
          : 'Aplikacija dohvaća sliku kroz proxy iz HAK/BIHAMK/AMS izvora. Ako izvor ne odgovara, pokušaj ponovno za nekoliko minuta ili otvori izvor izravno.'}</p>
        {!compact && <a href={cam.externalUrl || cam.url} target="_blank" rel="noreferrer">{live ? 'Otvori uživo' : 'Otvori izvor'}</a>}
      </div>
    </div>
  );
}


function LaneSplitCard({ profile }) {
  const lanes = [profile.eu, profile.nonEu].filter(Boolean);
  const maxPassed = Math.max(...lanes.map((lane) => lane.passed15 || 0), 1);
  const diff = laneDifferenceMinutes(profile);
  const nonEuSlower = Number(profile.nonEu?.wait || 0) > Number(profile.eu?.wait || 0);

  return (
    <article className="lane-profile-card">
      <div className="lane-profile-head">
        <div>
          <span>EU / Non‑EU kolone · procijenjeno</span>
          <strong>EU / Non‑EU</strong>
        </div>
        <b className={diff >= 25 ? 'alert' : ''}>{diff ? `Δ ${formatMinutes(diff)}` : 'spremno'}</b>
      </div>
      <p>{laneSignalText(profile)}</p>
      <div className="lane-profile-list">
        {lanes.map((lane) => (
          <div className={`lane-profile-row ${lane.key}`} key={lane.key}>
            <div>
              <span>{lane.short}</span>
              <strong>{formatMinutes(lane.wait)}</strong>
              <small>{lane.helper}</small>
            </div>
            <div className="lane-profile-meter">
              <i style={{ width: `${Math.max(8, ((lane.passed15 || 0) / maxPassed) * 100)}%` }} />
            </div>
            <em>{lane.passed15 || 0} / 15 min</em>
          </div>
        ))}
      </div>
      <small className="lane-profile-note">Procijenjena podjela po koloni — izračun na temelju ukupnog čekanja, nije mjereno zasebno po traci. {nonEuSlower ? 'Non‑EU kolona trenutno traži više pažnje i može promijeniti preporuku rute.' : 'EU kolona trenutno traži dodatnu potvrdu kroz iduće očitanje.'}</small>
    </article>
  );
}

function CameraPanel({ crossing, selectedDirection, onLiveSignalUpdated }) {
  const [refreshKey, setRefreshKey] = useState(Date.now());
  // Manual "Osvježi prikaz" forces a fresh camera frame on the backend (force=true); the 45 s
  // auto-poll does not (it may use the short server-side cache to stay polite to the camera hosts).
  const forceNextFetchRef = useRef(false);
  const [selectedSignal, setSelectedSignal] = useState(() => getDefaultCameraId(crossing));
  const baselineAnalytics = useMemo(() => getCameraAnalytics(crossing, selectedDirection), [crossing, selectedDirection, refreshKey]);
  const [apiAnalytics, setApiAnalytics] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const analytics = apiAnalytics || baselineAnalytics;
  const historySeries = analytics.history?.length ? analytics.history : buildCameraHistorySeries(crossing);
  const maxPassed = Math.max(...historySeries.map((item) => item.passed), 1);
  const state = statusMeta[analytics.state] || statusMeta.normal;
  // Camera-card honesty (spec — no false "procjena iz kamere"): the camera only shows a
  // minute estimate when a real, fresh, direction-verified camera actually drove it. When the
  // camera contradicts the official/fused headline by a lot, we defer to the headline and do
  // NOT present the camera number as the truth.
  const cameraHeadlineWait = getDisplayedWait(crossing, selectedDirection, {});
  const cameraDecision = cameraEstimateDecision(analytics, cameraHeadlineWait);
  const cameraContradictsOfficial = cameraDecision.contradictsOfficial;
  const cameraEstimateUsable = cameraDecision.usable;
  // Live conflict banner (immediate, from the live camera band vs the displayed headline) — robust
  // even if the backend's stored visual signal hasn't refreshed yet. Two directions:
  //  • camera shows a big queue but the headline wait is low  → likely under-estimate, verify.
  //  • camera shows little/no queue but the headline wait is very high → suspect high number, verify.
  const liveBand = analytics.queueBand;
  const liveCongestionConflict = (liveBand === 'velika' || liveBand === 'ekstremna') && hasKnownWait(cameraHeadlineWait) && Number(cameraHeadlineWait) < 30;
  const liveClearConflict = (liveBand === 'nema' || liveBand === 'mala') && hasKnownWait(cameraHeadlineWait) && Number(cameraHeadlineWait) >= 90;
  const laneProfile = analytics.laneProfile || aggregateLaneProfile(analytics.laneSignals || []);
  const showLanes = crossingHasLaneCalibration(crossing);
  const selectedSignalData = analytics.laneSignals.find((signal) => signal.id === selectedSignal) || analytics.laneSignals[0];

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshKey(Date.now()), 45000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const force = forceNextFetchRef.current;
    forceNextFetchRef.current = false;
    fetchJson(`/api/camera-analytics/${crossing.id}?direction=${selectedDirection}&t=${refreshKey}${force ? '&force=true' : ''}`)
      .then((payload) => {
        if (!cancelled && payload?.ok && payload.analytics) {
          setApiAnalytics(payload.analytics);
          // Fresh live camera band → tell the app to reload the headline/marker now.
          onLiveSignalUpdated?.();
        }
      })
      .catch(() => {
        if (!cancelled) setApiAnalytics(null);
      });
    return () => { cancelled = true; };
  }, [crossing.id, selectedDirection, refreshKey, onLiveSignalUpdated]);

  useEffect(() => {
    setSelectedSignal(getDefaultCameraId(crossing));
  }, [crossing.id]);

  async function runCameraScan() {
    setIsScanning(true);
    try {
      const payload = await fetchJson(`/api/camera-scan/${crossing.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: selectedDirection }),
      });
      if (payload?.ok && payload.analytics) {
        setApiAnalytics(payload.analytics);
        setRefreshKey(Date.now());
        onLiveSignalUpdated?.();
      }
    } catch (error) {
      setApiAnalytics(null);
    } finally {
      setIsScanning(false);
    }
  }

  const noCameras = !Array.isArray(crossing.cameras) || crossing.cameras.length === 0;

  if (noCameras) {
    return (
      <div className="active-camera-section">
        <div className="camera-toolbar">
          <div>
            <span className="kicker">Kamere</span>
            <h3>{crossing.name}</h3>
            <p className="camera-direction-note">Za ovaj prijelaz trenutno nemamo dostupne javne kamere.</p>
          </div>
        </div>
        <article className="empty-state-card">
          <strong>Nema dostupnih kamera</strong>
          <span>Prati čekanje i Google promet u Pregledu; čim se otvori javni izvor kamere, prikazat će se i ovdje.</span>
        </article>
      </div>
    );
  }

  const displayCameraQueueLabel = buildCameraQueueLabel(analytics, { estimateUsable: cameraEstimateUsable });
  const cameraTrustText = buildCameraTrustText(analytics, { estimateUsable: cameraEstimateUsable, contradictsOfficial: cameraContradictsOfficial });

  return (
    <div className="active-camera-section">
      <div className="camera-toolbar">
        <div>
          <span className="kicker">Kamere</span>
          <h3>{crossing.name}</h3>
          <p className="camera-direction-note">Smjer: {dirPairLabel(crossing, selectedDirection)} · prikaz kamera pomaže brzoj provjeri kolone i protoka po odabranom smjeru.</p>
        </div>
        <div className="camera-toolbar-actions">
          <button type="button" className="ghost-button active" onClick={() => { forceNextFetchRef.current = true; setRefreshKey(Date.now()); }}>Osvježi prikaz</button>
        </div>
      </div>

      {(liveCongestionConflict || liveClearConflict) && (
        <div className="camera-conflict-banner">
          ⚠️ {liveCongestionConflict
            ? `Kamera pokazuje ${displayCameraQueueLabel || 'vidljivu kolonu'} — procjenu čekanja podigli smo prema slici uživo, ali uz kontrolu pouzdanosti.`
            : `Kamera trenutno ne pokazuje veću kolonu, pa je procjena niža nego što bi sugerirao stariji službeni podatak — prikazujemo ono što kamera vidi uživo.`}
        </div>
      )}

      <div className="camera-analytics-grid">
        <article className={`camera-intelligence-card ${cameraEstimateUsable ? trafficClassFromWait(analytics.wait) : 'pending'}`}>
          <div className="camera-intelligence-head">
            <div>
              <span>{cameraEstimateUsable ? 'Procjena iz kamera' : 'Kamera — vizualna provjera'}</span>
              <strong>{cameraEstimateUsable ? formatMinutes(analytics.wait) : displayCameraQueueLabel}</strong>
            </div>
            <b className={`status ${state.className}`}>{state.label}</b>
          </div>
          <p>{cameraEstimateUsable ? (analytics.message || cameraTrustText) : cameraTrustText}</p>
          {cameraEstimateUsable ? (
            <div className="camera-stat-grid">
              <div><span>Zadnjih 15 min</span><strong>{analytics.passed15}</strong><small>vozila</small></div>
              <div><span>Protok</span><strong>{analytics.throughputPerHour}</strong><small>vozila/h</small></div>
              <div><span>Ritam</span><strong>{formatRhythm(analytics.rhythmSeconds)}</strong><small>prosjek</small></div>
              <div><span>U koloni</span><strong>{analytics.queueVehicles}</strong><small>vozila</small></div>
            </div>
          ) : (
            // Visual-only / not-camera-driven: never present pseudo-precise counts as fact.
            <div className="camera-visual-summary">
              <strong>{displayCameraQueueLabel}</strong>
              <span>{cameraTrustText} Broj vozila i protok nisu prikazani kao točan broj dok signal nije dovoljno kalibriran.</span>
            </div>
          )}
          {cameraEstimateUsable && (
            <div className="vehicle-mix-row">
              <span style={{ width: `${Math.max(8, (analytics.vehicleMix15.cars / Math.max(analytics.passed15, 1)) * 100)}%` }} className="cars" />
              <span style={{ width: `${Math.max(7, ((analytics.vehicleMix15.vans || 0) / Math.max(analytics.passed15, 1)) * 100)}%` }} className="vans" />
              <span style={{ width: `${Math.max(8, (analytics.vehicleMix15.trucks / Math.max(analytics.passed15, 1)) * 100)}%` }} className="trucks" />
              <span style={{ width: `${Math.max(6, (analytics.vehicleMix15.buses / Math.max(analytics.passed15, 1)) * 100)}%` }} className="buses" />
            </div>
          )}
          <div className="vehicle-pill-row">
            {cameraEstimateUsable && <>
              <span>🚗 {analytics.vehicleMix15.cars}</span>
              <span>🚐 {analytics.vehicleMix15.vans || 0}</span>
              <span>🚛 {analytics.vehicleMix15.trucks}</span>
              <span>🚌 {analytics.vehicleMix15.buses}</span>
            </>}
            <span>{cameraEstimateUsable ? confidenceLabel(analytics.confidence) : 'Vizualna provjera'}</span>
            <span>{cameraEstimateUsable ? 'Prema kameri' : 'Procjena nije iz kamere'}</span>
          </div>
          {cameraEstimateUsable && analytics.cameraSnapshots?.length ? <p className="camera-source-note">Procjena iz kamera pomaže orijentaciji, ali službene obavijesti i dalje imaju prednost.</p> : null}
          {analytics.cvEnabled ? (
            <p className="camera-source-note">
              {analytics.cvUsed
                ? 'Kamera broji vozila u koloni kad je zona za brojanje postavljena.'
                : cameraStatusCopy(analytics.cvFallbackReason)}
            </p>
          ) : null}
        </article>

        <article className="camera-flow-card">
          <div className="camera-flow-head">
            <div><span>Protok 07–19h</span><strong>{analytics.trendLabel}</strong></div>
            <small>Ažurirano {analytics.updatedAt}</small>
          </div>
          <div className="camera-mini-chart">
            {historySeries.map((item) => (
              <div key={item.hour} className="camera-mini-column">
                <span style={{ height: `${Math.max(16, (item.passed / maxPassed) * 96)}px` }} />
                <small>{item.hour}</small>
              </div>
            ))}
          </div>
          <div className="camera-day-total">
            <span>Danas 07–19 · procjena</span>
            <strong>~{historySeries.reduce((sum, item) => sum + item.passed, 0)} vozila</strong>
          </div>
        </article>

        {showLanes && <LaneSplitCard profile={laneProfile} />}
      </div>

      {showLanes && (
        <div className="lane-signal-grid">
          {analytics.laneSignals.map((signal) => (
            <button
              key={signal.id}
              type="button"
              className={selectedSignal === signal.id ? 'lane-signal-card active' : 'lane-signal-card'}
              onClick={() => setSelectedSignal(signal.id)}
            >
              <span>{signal.label}</span>
              <strong>{signal.passed15} vozila / 15 min</strong>
              <small>u kadru: {signal.frame.cars} auta · {signal.frame.vans || 0} kombija · {signal.frame.trucks} kamiona · {signal.frame.buses} bus</small>
              {signal.laneGroups && <small className="lane-card-split">EU {formatMinutes(signal.laneGroups.eu?.wait)} · Non‑EU {formatMinutes(signal.laneGroups.nonEu?.wait)}</small>}
              <i>{confidenceLabel(signal.confidence)}</i>
            </button>
          ))}
        </div>
      )}

      {showLanes && selectedSignalData && (
        <div className="selected-signal-strip">
          <div>
            <span>Aktivna kamera</span>
            <strong>{selectedSignalData.label}</strong>
          </div>
          <div>
            <span>U kadru</span>
            <strong>{selectedSignalData.visibleTotal || 0} vozila</strong>
          </div>
          <div>
            <span>Zadnjih 15 min</span>
            <strong>{selectedSignalData.passed15} prošlo</strong>
          </div>
          <div>
            <span>EU / Non‑EU</span>
            <strong>{formatMinutes(selectedSignalData.laneGroups?.eu?.wait)} / {formatMinutes(selectedSignalData.laneGroups?.nonEu?.wait)}</strong>
          </div>
          <div>
            <span>Pouzdanost</span>
            <strong>{confidenceLabel(selectedSignalData.confidence)}</strong>
          </div>
        </div>
      )}

      <div className="camera-grid">
        {crossing.cameras.map((cam) => (
          <article className={selectedSignal === cam.id ? 'camera-card camera-card-live selected' : 'camera-card camera-card-live'} key={cam.id}>
            <CameraFeed cam={cam} refreshKey={refreshKey} signal={analytics.laneSignals.find((signal) => signal.id === cam.id)} crossingId={crossing.id} />
            <div className="camera-copy">
              <div className="camera-copy-top">
                <h3>{cam.label}</h3>
                <span>{cam.source}</span>
              </div>
              <p>{cam.status}</p>
              {cam.note && <small>{cam.note}</small>}
              <a href={cam.externalUrl || cam.url} target="_blank" rel="noreferrer">Otvori izvor</a>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function summarizeHistoryPeriod(label, rangeLabel, startHour, endHour, series) {
  const slots = series.filter((item) => Number(item.hour) >= startHour && Number(item.hour) <= endHour);
  const safeSlots = slots.length ? slots : (series.length ? series.slice(0, 1) : [{ hour: '--', passed: 0, totalDemand: 0, cars: 0, vans: 0, trucks: 0, buses: 0, wait: 0, rhythmSeconds: 0 }]);
  const passed = safeSlots.reduce((sum, item) => sum + item.passed, 0);
  const demand = safeSlots.reduce((sum, item) => sum + (item.totalDemand || 0), 0);
  const counts = safeSlots.reduce((sum, item) => ({
    cars: sum.cars + (item.cars || 0),
    vans: sum.vans + (item.vans || 0),
    trucks: sum.trucks + (item.trucks || 0),
    buses: sum.buses + (item.buses || 0),
  }), { cars: 0, vans: 0, trucks: 0, buses: 0 });
  const avgWait = Math.round(safeSlots.reduce((sum, item) => sum + item.wait, 0) / safeSlots.length);
  const avgThroughput = Math.round(passed / safeSlots.length);
  const peak = safeSlots.reduce((max, item) => item.wait > max.wait ? item : max, safeSlots[0]);
  const flowPeak = safeSlots.reduce((max, item) => item.passed > max.passed ? item : max, safeSlots[0]);
  const rhythmSeconds = Math.round(safeSlots.reduce((sum, item) => sum + item.rhythmSeconds, 0) / safeSlots.length);
  return { label, rangeLabel, startHour, endHour, slots: safeSlots, passed, demand, counts, avgWait, avgThroughput, peak, flowPeak, rhythmSeconds };
}

function buildHistoryPeriods(series) {
  return [
    summarizeHistoryPeriod('Jutro', '07–10h', 7, 10, series),
    summarizeHistoryPeriod('Sredina dana', '11–14h', 11, 14, series),
    summarizeHistoryPeriod('Popodne', '15–19h', 15, 19, series),
  ];
}

function historyPeriodTone(period) {
  if (period.avgWait >= 60) return 'critical';
  if (period.avgWait >= 30) return 'busy';
  return 'normal';
}

function HistoryView({ selectedCrossing, setSelectedCrossing, selectedDirection, setSelectedDirection, overrides = {} }) {
  const selected = selectedCrossing || CROSSINGS[0];
  const [apiHistory, setApiHistory] = useState(null);
  const [historyCalendar, setHistoryCalendar] = useState([]);
  const [historyDays, setHistoryDays] = useState(7);
  const [selectedDate, setSelectedDate] = useState('');
  const [historySource, setHistorySource] = useState('');
  const [historyUpdatedAt, setHistoryUpdatedAt] = useState('');
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  // Honesty contract (V5 §7 H / §8): never present fabricated vehicle counts as fact.
  // vehicleCountsAreReal = a CV camera really classified cars/trucks; vehicleTotalsAreReal = a
  // camera really counted TOTAL vehicles (split may still be unknown).
  const [vehicleCountsAreReal, setVehicleCountsAreReal] = useState(false);
  const [vehicleTotalsAreReal, setVehicleTotalsAreReal] = useState(false);
  const [historyCoverage, setHistoryCoverage] = useState(null);
  const [historyNote, setHistoryNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      setIsHistoryLoading(true);
      try {
        const params = new URLSearchParams({ direction: selectedDirection, days: String(historyDays) });
        if (selectedDate) params.set('date', selectedDate);
        const payload = await fetchJson(`/api/history/${selected.id}?${params.toString()}`);
        if (!cancelled && payload?.ok) {
          setApiHistory(Array.isArray(payload.history) ? payload.history : []);
          setHistoryCalendar(payload.calendar || []);
          setHistorySource(payload.source || 'api');
          setHistoryUpdatedAt(payload.updatedAt || '');
          setVehicleCountsAreReal(payload.vehicleCountsAreReal === true);
          setVehicleTotalsAreReal(payload.vehicleTotalsAreReal === true || payload.vehicleCountsAreReal === true);
          setHistoryCoverage(payload.coverage || null);
          setHistoryNote(payload.note || '');
          if (!selectedDate || !payload.calendar?.some((item) => item.date === selectedDate)) setSelectedDate(payload.selectedDate || payload.calendar?.at(-1)?.date || '');
        }
      } catch {
        if (!cancelled) {
          setApiHistory(null);
          setHistoryCalendar([]);
          setHistorySource('nedostupno');
        }
      } finally {
        if (!cancelled) setIsHistoryLoading(false);
      }
    }
    loadHistory();
    return () => { cancelled = true; };
  }, [selected.id, selectedDirection, historyDays, selectedDate]);

  const focusSeries = Array.isArray(apiHistory) ? apiHistory : [];
  // Driver-facing insights from REAL persisted slots (pure + unit-tested): peak/min/typical/best window.
  const insights = computeHistoryInsights(focusSeries);
  const currentWait = getDisplayedWait(selected, selectedDirection, overrides);
  const currentMeta = getWaitSourceMeta(selected, selectedDirection, overrides);
  const nowVsTypical = compareNowToTypical(hasKnownWait(currentWait) ? Number(currentWait) : null, insights.typicalRange);
  const periods = buildHistoryPeriods(focusSeries);
  const emptySlot = { hour: '--', wait: 0, passed: 0, cars: 0, vans: 0, trucks: 0, buses: 0 };
  const emptyPeriod = { label: 'Čeka podatke', rangeLabel: '-', passed: 0, avgWait: 0, avgThroughput: 0, peak: emptySlot };
  const slowestPeriod = periods.length ? periods.reduce((max, period) => period.avgWait > max.avgWait ? period : max, periods[0]) : emptyPeriod;
  const bestPeriod = periods.length ? periods.reduce((min, period) => period.avgWait < min.avgWait ? period : min, periods[0]) : emptyPeriod;
  const peakSlot = focusSeries.length ? focusSeries.reduce((max, item) => item.wait > max.wait ? item : max, focusSeries[0]) : emptySlot;
  const quietSlot = focusSeries.length ? focusSeries.reduce((min, item) => item.wait < min.wait ? item : min, focusSeries[0]) : emptySlot;
  const throughputPeak = focusSeries.length ? focusSeries.reduce((max, item) => item.passed > max.passed ? item : max, focusSeries[0]) : emptySlot;
  const focusTotal = focusSeries.reduce((sum, item) => sum + item.passed, 0);
  const averageWait = Math.round(focusSeries.reduce((sum, item) => sum + item.wait, 0) / Math.max(focusSeries.length, 1));
  const maxPassed = Math.max(...focusSeries.map((item) => item.passed), 1);
  const maxWait = Math.max(...focusSeries.map((item) => item.wait), 1);
  const totals = focusSeries.reduce((sum, item) => ({
    cars: sum.cars + (item.cars || 0),
    vans: sum.vans + (item.vans || 0),
    trucks: sum.trucks + (item.trucks || 0),
    buses: sum.buses + (item.buses || 0),
  }), { cars: 0, vans: 0, trucks: 0, buses: 0 });
  const vehicleTotal = Math.max(1, totals.cars + totals.vans + totals.trucks + totals.buses);
  const selectedDay = historyCalendar.find((item) => item.date === selectedDate) || historyCalendar.at(-1);
  const minDate = historyCalendar[0]?.date || '';
  const maxDate = historyCalendar.at(-1)?.date || '';
  const selectedDateLabel = selectedDate
    ? new Date(`${selectedDate}T12:00:00.000Z`).toLocaleDateString('hr-HR', { weekday: 'long', day: '2-digit', month: '2-digit' })
    : 'odabrani dan';
  const rangeAverageWait = Math.round(historyCalendar.reduce((sum, day) => sum + Number(day.averageWait || 0), 0) / Math.max(historyCalendar.length, 1));
  const rangeSlowestDay = historyCalendar.reduce((max, day) => Number(day.averageWait || 0) > Number(max.averageWait || 0) ? day : max, historyCalendar[0] || { label: '-', averageWait: 0 });
  const rangeBestDay = historyCalendar.reduce((min, day) => Number(day.averageWait || 0) < Number(min.averageWait || 999) ? day : min, historyCalendar[0] || { label: '-', averageWait: 0 });
  const hasHistoryData = focusSeries.length > 0 || historyCalendar.length > 0;
  const dataStatus = isHistoryLoading ? 'Učitavam…' : historySource === 'nedostupno' ? 'Povijest trenutno nije dostupna' : historyCalendar.length ? `${historyCalendar.length} dana povijesti` : 'Čeka se prvo očitanje';
  const bestTimeText = periods.length ? `${bestPeriod.label} (${bestPeriod.rangeLabel})` : 'Čeka podatke';
  const avoidTimeText = periods.length ? `${slowestPeriod.label} (${slowestPeriod.rangeLabel})` : 'Čeka podatke';
  const vehicleMixText = vehicleTotal > 1
    ? `🚗 ${Math.round((totals.cars / vehicleTotal) * 100)}% · 🚐 ${Math.round((totals.vans / vehicleTotal) * 100)}% · 🚛 ${Math.round((totals.trucks / vehicleTotal) * 100)}% · 🚌 ${Math.round((totals.buses / vehicleTotal) * 100)}%`
    : 'Čeka podatke';

  return (
    <section className="screen history-screen history-simple-screen">
      <div className="screen-head history-simple-head">
        <div>
          <span className="kicker">Prošlost</span>
          <h2>Kada je najbolje krenuti?</h2>
          <p className="screen-subtitle">Jednostavan pregled prošlih čekanja za odabrani prijelaz. Detalji po satu su skriveni dok ih korisnik ne zatraži.</p>
        </div>
        <div className="history-actions history-simple-actions">
          {typeof setSelectedDirection === 'function' && (
            <DirectionToggle value={selectedDirection} onChange={setSelectedDirection} compact neighbor={selectedCrossing?.neighbor} />
          )}
          <select className="small-select" value={selected.id} onChange={(event) => setSelectedCrossing(CROSSINGS.find((crossing) => crossing.id === event.target.value))}>
            {CROSSINGS.map((crossing) => <option key={crossing.id} value={crossing.id}>{crossing.name}</option>)}
          </select>
          <div className="history-range-toggle" aria-label="Raspon povijesti">
            <button type="button" className={historyDays === 7 ? 'active' : ''} onClick={() => { setHistoryDays(7); setSelectedDate(''); }}>7 dana</button>
            <button type="button" className={historyDays === 30 ? 'active' : ''} onClick={() => { setHistoryDays(30); setSelectedDate(''); }}>30 dana</button>
          </div>
          <label className="history-date-picker compact">
            <span>Datum</span>
            <input type="date" value={selectedDate} min={minDate} max={maxDate} onChange={(event) => setSelectedDate(event.target.value)} />
          </label>
        </div>
      </div>

      <article className={`history-insight-card ${statusFromWait(rangeAverageWait)}`}>
        <div>
          <span>{selected.shortName} · {getDirection(selected, selectedDirection).label}</span>
          <h3>{hasHistoryData
            ? (insights.bestWindow && !insights.lowData ? `Najbolje vrijeme za polazak: ${formatHourWindow(insights.bestWindow.startHour, insights.bestWindow.endHour)}` : `Najbolje krenuti: ${bestTimeText}`)
            : 'Još nemamo dovoljno podataka za povijest ovog prijelaza.'}</h3>
          <p>{hasHistoryData
            ? `Najviše čekanja se obično pojavljuje u periodu ${avoidTimeText}. Najsporiji dan u rasponu je ${rangeSlowestDay.label || '-'} (${formatMinutes(rangeSlowestDay.averageWait || 0)} prosjek).`
            : 'Čim se prikupe prva očitanja, ovdje će se prikazati preporuka za najbolje vrijeme polaska.'}</p>
          <div className="history-source-chips" aria-label="Izvori povijesti">
            {historyCoverage?.cameraSlots > 0 && <span>kamera · {historyCoverage.cameraSlots}h</span>}
            {historyCoverage?.publicSlots > 0 && <span>javni izvor · {historyCoverage.publicSlots}h</span>}
            {historyUpdatedAt && <span>{formatLastUpdated(historyUpdatedAt)}</span>}
            {insights.lowData && hasHistoryData && <span className="history-low-data-badge">Podaci su rijetki — okvirna procjena</span>}
          </div>
        </div>
        <strong>{dataStatus}</strong>
      </article>

      {isHistoryLoading && !focusSeries.length && (
        <div className="history-skeleton" aria-hidden="true"><i /><i /><i /></div>
      )}

      {/* "Kada mi se najviše isplati ići?" — answer cards from real persisted slots (T5). */}
      {focusSeries.length > 0 && (
        <div className="history-summary-grid">
          <article className="tone-bad">
            <span>Najveća gužva</span>
            <strong>{insights.peak ? formatMinutes(insights.peak.wait) : '—'}</strong>
            <small>{insights.peak ? `najviše se čekalo u ${insights.peak.hour}:00` : 'nema podataka'}</small>
          </article>
          <article className="tone-good">
            <span>Najmanje čekanje</span>
            <strong>{insights.calm ? formatMinutes(insights.calm.wait) : '—'}</strong>
            <small>{insights.calm ? `najmirnije u ${insights.calm.hour}:00` : 'nema podataka'}</small>
          </article>
          <article>
            <span>Tipično čekanje</span>
            <strong>{insights.typicalRange ? `${Math.round(insights.typicalRange.min)}–${Math.round(insights.typicalRange.max)} min` : '—'}</strong>
            <small>{insights.lowData ? 'okvirna procjena' : 'uobičajen raspon kroz dan'}</small>
          </article>
          <article className={insights.bestWindow ? 'tone-good' : ''}>
            <span>Najmirniji period</span>
            <strong>{insights.bestWindow ? formatHourWindow(insights.bestWindow.startHour, insights.bestWindow.endHour) : '—'}</strong>
            <small>{insights.bestWindow ? `prosječno ${formatMinutes(insights.bestWindow.avgWait)}` : 'nema dovoljno podataka'}</small>
          </article>
          {insights.worstWindow && selectedDate === historyCalendar.at(-1)?.date && (
            <article className="tone-bad">
              <span>Najgore vrijeme danas</span>
              <strong>{formatHourWindow(insights.worstWindow.startHour, insights.worstWindow.endHour)}</strong>
              <small>prosječno {formatMinutes(insights.worstWindow.avgWait)}</small>
            </article>
          )}
          {nowVsTypical && hasKnownWait(currentWait) && (
            <article className={nowVsTypical === 'better' ? 'tone-good' : nowVsTypical === 'worse' ? 'tone-bad' : ''}>
              <span>Trenutno vs uobičajeno</span>
              <strong>{formatWaitDisplay(currentWait, currentMeta)}</strong>
              <small>{nowVsTypical === 'better' ? 'trenutno bolje od uobičajenog' : nowVsTypical === 'worse' ? 'trenutno gore od uobičajenog' : 'u razini uobičajenog'}</small>
            </article>
          )}
        </div>
      )}

      <div className="history-simple-kpis">
        <article><span>Prosjek raspona</span><strong>{formatMinutes(rangeAverageWait)}</strong><small>{historyDays} dana</small></article>
        <article><span>Najmirniji dan</span><strong>{rangeBestDay.label || '-'}</strong><small>{formatMinutes(rangeBestDay.averageWait || 0)}</small></article>
        <article><span>Najveća gužva</span><strong>{avoidTimeText}</strong><small>{formatMinutes(slowestPeriod.avgWait)}</small></article>
      </div>

      <article className="history-day-panel-simple">
        <div className="history-panel-head">
          <div>
            <span className="kicker">Dani u rasponu</span>
            <h3>Odaberi dan za kratak sažetak</h3>
          </div>
          <b>{selectedDateLabel}</b>
        </div>
        {historyCalendar.length ? (
          <div className="history-day-strip simple-day-strip">
            {historyCalendar.map((day) => {
              const tone = statusFromWait(day.averageWait);
              return (
                <button key={day.date} type="button" className={day.date === selectedDate ? `history-day-card simple active ${tone}` : `history-day-card simple ${tone}`} onClick={() => setSelectedDate(day.date)}>
                  <span>{day.label}</span>
                  <strong>{formatMinutes(day.averageWait)}</strong>
                  <small>peak {day.peakHour}:00</small>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="empty-state-card compact-empty">
            <strong>Nema spremljene povijesti za ovaj raspon.</strong>
            <span>Povijest će se prikazati nakon što aplikacija prikupi prva live očitanja.</span>
          </div>
        )}
      </article>

      <div className="history-selected-day-grid">
        <article className="history-selected-day-card">
          <span>Odabrani dan</span>
          <h3>{selectedDateLabel}</h3>
          <div className="selected-day-summary">
            <div><small>Najmirnije</small><strong>{quietSlot.hour}:00</strong><em>{formatMinutes(quietSlot.wait)}</em></div>
            <div><small>Najsporije</small><strong>{peakSlot.hour}:00</strong><em>{formatMinutes(peakSlot.wait)}</em></div>
            <div><small>Protok</small><strong>{vehicleTotalsAreReal && focusTotal > 0 ? focusTotal : '—'}</strong><em>{vehicleTotalsAreReal && focusTotal > 0 ? 'vozila (kamera)' : 'nije brojano'}</em></div>
          </div>
        </article>
        <article className="history-selected-day-card subdued">
          <span>Struktura prometa</span>
          <h3>{vehicleCountsAreReal ? vehicleMixText : 'Nije dostupno'}</h3>
          <p>{vehicleCountsAreReal
            ? 'Ovaj omjer pomaže razumjeti zašto se čekanje mijenja kroz dan, ali nije potreban za osnovnu odluku o polasku.'
            : 'Broj vozila nije stvarno brojan za ovaj prijelaz (povijest je iz javnih izvora čekanja), pa ne prikazujemo izmišljene brojke.'}</p>
        </article>
      </div>

      {historyNote && <p className="history-honesty-note">{historyNote}</p>}

      <article className="history-details-toggle-card">
        <div>
          <span className="kicker">Detaljna analiza</span>
          <h3>Satni prikaz za {selectedDateLabel}</h3>
          <p>Sažetak iznad je dovoljan za brzu odluku. Detalje otvori kad želiš vidjeti kako se čekanje mijenjalo kroz dan.</p>
        </div>
        <button type="button" className="ghost-button" onClick={() => setShowDetails((value) => !value)}>{showDetails ? 'Sakrij detalje' : 'Prikaži detalje'}</button>
      </article>

      {showDetails && (
        <article className="history-main-panel history-daily-detail-panel simplified-detail-panel">
          <div className="history-panel-head">
            <div>
              <span className="kicker">Satni pregled</span>
              <h3>{selected.shortName} · {selectedDateLabel}</h3>
            </div>
            <div className="history-panel-badges">
              <span>Najveći protok {throughputPeak.hour}:00 · {throughputPeak.passed} voz/h</span>
              <b>{slowestPeriod.label} najsporije</b>
            </div>
          </div>

          {!focusSeries.length && (
            <div className="empty-state-card">
              <strong>Nema podataka za odabrani dan.</strong>
              <span>Odaberi drugi datum ili pričekaj nova live očitanja.</span>
            </div>
          )}

          <div className="history-hour-list daily-hour-list">
            {focusSeries.map((item) => {
              const flowWidth = Math.max(8, Math.round((item.passed / maxPassed) * 100));
              const waitWidth = Math.max(8, Math.round((item.wait / maxWait) * 100));
              const tone = statusFromWait(item.wait);
              return (
                <div className="history-hour-item daily-hour-item" key={`${item.date || selectedDate}-${item.hour}`}>
                  <div className="history-hour-time">
                    <strong>{item.hour}:00</strong>
                    <span>{formatMinutes(item.wait)}</span>
                  </div>
                  <div className="history-hour-bars">
                    <div className="history-flow-track"><i className={tone} style={{ width: `${flowWidth}%` }} /></div>
                    <div className="history-wait-track"><i className={tone} style={{ width: `${waitWidth}%` }} /></div>
                  </div>
                  {/* Per-class icons ONLY when a CV camera really classified vehicles; a real total
                      shows as a single count; otherwise nothing — no invented 🚗/🚛 splits (T6). */}
                  {vehicleCountsAreReal ? (
                    <div className="history-hour-vehicles" aria-label="Vozila po tipu">
                      <span>🚗 {item.cars || 0}</span>
                      <span>🚐 {item.vans || 0}</span>
                      <span>🚛 {item.trucks || 0}</span>
                      <span>🚌 {item.buses || 0}</span>
                    </div>
                  ) : vehicleTotalsAreReal && String(item.source || '').includes('camera') ? (
                    <div className="history-hour-vehicles" aria-label="Vozila na kameri">
                      <span>🚘 {item.queueVehicles || 0} vozila na kameri</span>
                    </div>
                  ) : (
                    <div className="history-hour-vehicles muted" aria-label="Vozila nisu brojana">
                      <span>vozila nisu brojana</span>
                    </div>
                  )}
                  {vehicleTotalsAreReal && Number(item.passed) > 0 ? (
                    <div className="history-hour-count">
                      <strong>{item.passed}</strong>
                      <span>voz/h</span>
                    </div>
                  ) : (
                    <div className="history-hour-count muted">
                      <strong>—</strong>
                      <span>voz/h</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </article>
      )}
    </section>
  );
}

function AdminView({ selectedCrossing, setSelectedCrossing, selectedDirection, setSelectedDirection, overrides, setOverrides, currentUser }) {
  const [sourceRefreshState, setSourceRefreshState] = useState('idle'); // idle | loading | success | error
  const direction = getDirection(selectedCrossing, selectedDirection);
  const key = `${selectedCrossing.id}:${selectedDirection}`;
  const hasManualOverride = Object.prototype.hasOwnProperty.call(overrides, key);
  const manualWait = hasManualOverride ? overrides[key] : '';
  const liveWait = getDisplayedWait(selectedCrossing, selectedDirection, overrides);
  const baseWait = hasKnownWait(liveWait) ? Number(liveWait) : null;
  const finalWait = hasManualOverride ? Number(manualWait) : baseWait;
  const confidence = getAdminConfidence({ crossing: selectedCrossing, hasManualOverride });
  const decision = getAdminDecision({ wait: finalWait, direction, hasManualOverride });
  const sourceMeta = getWaitSourceMeta(selectedCrossing, selectedDirection, overrides);
  const sourceRows = getAdminSourceRows({ crossing: selectedCrossing, direction, baseWait, finalWait, hasManualOverride });
  const post = buildAdminPost({ selectedCrossing, direction, wait: finalWait, confidence, decision, sourceLabel: sourceMeta.label });
  const shortPost = `${selectedCrossing.shortName}: ${formatMinutes(finalWait)} · ${direction.label} · ${(statusMeta[statusFromWait(finalWait)] || statusMeta.unknown).label}`;
  const laneAwareCameras = selectedCrossing.cameras?.filter((cam) => cam.laneCalibration?.zones?.length) || [];
  const [copyStatus, setCopyStatus] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const activeStatusOverride = getStatusOverride(selectedCrossing.id, selectedDirection);
  const [manualStatus, setManualStatus] = useState(activeStatusOverride?.status || 'open');
  const [statusNote, setStatusNote] = useState(activeStatusOverride?.note || '');
  const [replacementCrossingId, setReplacementCrossingId] = useState(activeStatusOverride?.replacementCrossingId || selectedCrossing.routeStatusHint?.replacementCrossingId || '');

  useEffect(() => {
    const nextOverride = getStatusOverride(selectedCrossing.id, selectedDirection);
    setManualStatus(nextOverride?.status || 'open');
    setStatusNote(nextOverride?.note || '');
    setReplacementCrossingId(nextOverride?.replacementCrossingId || selectedCrossing.routeStatusHint?.replacementCrossingId || '');
  }, [selectedCrossing.id, selectedDirection]);

  async function saveStatusOverride(nextStatus = manualStatus) {
    if (!currentUser?.token) {
      setExportStatus('Za promjenu statusa potrebna je prijava člana tima.');
      return;
    }
    try {
      const payload = await fetchJson('/api/admin/status-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentUser.token}` },
        body: JSON.stringify({ crossingId: selectedCrossing.id, direction: selectedDirection, status: nextStatus, note: statusNote, replacementCrossingId }),
      });
      if (payload?.statusOverrides) globalThis.__BF_STATUS_OVERRIDES = payload.statusOverrides;
      setExportStatus(nextStatus === 'open' ? 'Status je vraćen na automatsku provjeru ruta.' : 'Status prijelaza je spremljen.');
    } catch {
      setExportStatus('Status trenutno nije spremljen. Provjeri backend ili prijavu.');
    }
    window.setTimeout(() => setExportStatus(''), 2600);
  }

  function persistOverride(nextOverrides, value) {
    setOverrides(nextOverrides);
    if (currentUser?.token) {
      fetchJson('/api/admin/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentUser.token}` },
        body: JSON.stringify({ key, value }),
      }).catch(() => {});
    }
  }

  function updateManual(value) {
    const cleanValue = value === '' ? '' : Math.max(0, Number(value));
    const nextOverrides = { ...overrides };
    if (cleanValue === '' || Number.isNaN(cleanValue)) delete nextOverrides[key];
    else nextOverrides[key] = cleanValue;
    persistOverride(nextOverrides, cleanValue);
  }

  function nudgeManual(delta) {
    const current = hasManualOverride ? Number(manualWait) : (hasKnownWait(baseWait) ? Number(baseWait) : 20);
    updateManual(String(Math.max(0, current + delta)));
  }

  async function copyPost(text) {
    try {
      await navigator.clipboard?.writeText(text);
      setCopyStatus('Tekst je kopiran.');
    } catch {
      setCopyStatus('Kopiranje nije uspjelo automatski — označi tekst ručno.');
    }
    window.setTimeout(() => setCopyStatus(''), 2200);
  }

  async function refreshLiveSources() {
    if (!currentUser?.token) {
      setExportStatus('Za osvježavanje izvora potrebna je prijava člana tima.');
      window.setTimeout(() => setExportStatus(''), 2600);
      return;
    }
    setSourceRefreshState('loading');
    try {
      await fetchJson('/api/admin/sources/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentUser.token}` },
        body: JSON.stringify({ force: true }),
        timeoutMs: 25000,
      });
      // Pull the freshly-refreshed estimate immediately (sync) — no browser reload needed.
      window.dispatchEvent(new Event(LIVE_SIGNAL_EVENT));
      setSourceRefreshState('success');
      window.setTimeout(() => setSourceRefreshState('idle'), 3000);
    } catch {
      setSourceRefreshState('error');
      window.setTimeout(() => setSourceRefreshState('idle'), 3500);
    }
  }

  async function downloadDailyReport() {
    if (!currentUser?.token) {
      setExportStatus('Za izvoz je potrebna prijava člana tima.');
      return;
    }
    setExportStatus('Pripremam dnevni izvještaj…');
    const date = new Date().toISOString().slice(0, 10);
    try {
      const response = await fetch(apiUrl(`/api/admin/daily-report?date=${date}&format=csv`), {
        headers: { Authorization: `Bearer ${currentUser.token}` },
      });
      if (!response.ok) throw new Error('Izvoz nije uspio.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `borderflow-daily-${date}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportStatus('Dnevni izvještaj je preuzet.');
    } catch {
      setExportStatus('Izvoz trenutno nije uspio. Pokušaj ponovno kasnije.');
    }
    window.setTimeout(() => setExportStatus(''), 3000);
  }

  return (
    <section className="screen admin-screen admin-console-screen">
      <div className="screen-head admin-console-head">
        <div>
          <span className="kicker">Tim</span>
          <h2>Uredi stanje za vozače</h2>
          <p className="screen-subtitle">Ovdje tim može potvrditi čekanje, označiti zatvoren prijelaz ili dodati kratku poruku koja pomaže vozačima prije polaska.</p>
        </div>
        <div className="admin-head-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={refreshLiveSources}
            disabled={sourceRefreshState === 'loading'}
          >
            <RefreshCw size={16} />
            {sourceRefreshState === 'loading' ? ' Osvježavam…'
              : sourceRefreshState === 'success' ? ' Osvježeno ✓'
              : sourceRefreshState === 'error' ? ' Greška — pokušaj opet'
              : ' Osvježi live izvore'}
          </button>
          <button type="button" className="ghost-button" onClick={downloadDailyReport}><Download size={16}/> Izvoz CSV</button>
          <DirectionToggle value={selectedDirection} onChange={setSelectedDirection} neighbor={selectedCrossing?.neighbor} />
        </div>
      </div>
      {exportStatus && <div className="admin-inline-status">{exportStatus}</div>}

      <div className="admin-console-grid">
        <article className="operator-card admin-control-panel">
          <span className="operator-label">Prijelaz</span>
          <label>
            <span>Odaberi granični prijelaz</span>
            <select value={selectedCrossing.id} onChange={(e) => setSelectedCrossing(CROSSINGS.find((c) => c.id === e.target.value))}>
              {CROSSINGS.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.route}</option>)}
            </select>
          </label>
          <div className="admin-route-note">
            <MapPin size={16} />
            <span>{direction.label}</span>
            <p>{selectedCrossing.fieldNote}</p>
          </div>
        </article>

        <article className={`operator-card admin-status-panel ${decision.tone}`}>
          <span className="operator-label">Operativni status</span>
          <h3>{decision.title}</h3>
          <p>{decision.reason}</p>
          <strong>{decision.label}</strong>
        </article>

        <article className="operator-card admin-final-panel">
          <span className="operator-label">Trenutno za prikaz</span>
          <div className="operator-big-wait">
            <strong>{formatMinutes(finalWait)}</strong>
            <span className={`status ${(statusMeta[statusFromWait(finalWait)] || statusMeta.unknown).className}`}>{(statusMeta[statusFromWait(finalWait)] || statusMeta.unknown).label}</span>
          </div>
          <span className={`source-badge ${sourceMeta.className}`}>{sourceMeta.label}</span>
          <div className="operator-confidence">
            <span>Pouzdanost</span>
            <b>{confidence}%</b>
            <i style={{ width: `${confidence}%` }} />
          </div>
        </article>
      </div>

      <div className="admin-work-grid">
        <article className="operator-card admin-override-panel">
          <div className="operator-card-head">
            <div>
              <span className="operator-label">Korekcija čekanja</span>
              <h3>{hasManualOverride ? 'Ručna vrijednost je aktivna' : 'Koristi se live vrijednost'}</h3>
            </div>
            {hasManualOverride ? <span className="override-chip active">Aktivno</span> : <span className="override-chip">Nema korekcije</span>}
          </div>

          <div className="correction-grid admin-correction-grid">
            <div>
              <span>Live vrijednost</span>
              <strong>{formatMinutes(baseWait)}</strong>
            </div>
            <label>
              <span>Ručna vrijednost</span>
              <input type="number" min="0" value={manualWait} onChange={(e) => updateManual(e.target.value)} placeholder="npr. 45" />
            </label>
          </div>

          <div className="quick-adjustments admin-quick-values">
            <button type="button" onClick={() => updateManual('')}>Vrati live</button>
            <button type="button" onClick={() => nudgeManual(-15)}>-15 min</button>
            <button type="button" onClick={() => nudgeManual(15)}>+15 min</button>
            <button type="button" onClick={() => updateManual('30')}>30 min</button>
            <button type="button" onClick={() => updateManual('60')}>60 min</button>
            <button type="button" onClick={() => updateManual('90')}>90 min</button>
          </div>

          <div className="admin-status-override-box">
            <div>
              <span className="operator-label">Status rute</span>
              <strong>{(OPERATIONAL_STATUS_META[manualStatus] || OPERATIONAL_STATUS_META.unknown).label}</strong>
            </div>
            <label>
              <span>Ručno stanje</span>
              <select value={manualStatus} onChange={(event) => setManualStatus(event.target.value)}>
                <option value="open">Otvoreno / auto provjera</option>
                <option value="busy">Pojačano</option>
                <option value="closed">Zatvoreno</option>
                <option value="redirected">Preusmjereno</option>
                <option value="unknown">Nepoznato</option>
              </select>
            </label>
            <label>
              <span>Alternativa</span>
              <select value={replacementCrossingId} onChange={(event) => setReplacementCrossingId(event.target.value)}>
                <option value="">Bez alternative</option>
                {CROSSINGS.filter((item) => item.id !== selectedCrossing.id).map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
              </select>
            </label>
            <label className="status-note-label">
              <span>Poruka korisniku</span>
              <input value={statusNote} onChange={(event) => setStatusNote(event.target.value)} placeholder="npr. Stari most zatvoren, koristiti Gornji Varoš" />
            </label>
            <button type="button" className="primary-button" onClick={() => saveStatusOverride(manualStatus)}>Spremi status</button>
          </div>
          <p className="operator-help">Ručna vrijednost ima prednost u javnom prikazu dok je ne vratiš na live stanje. Status “Otvoreno” briše ručni status i opet pušta automatsku provjeru rute.</p>
        </article>

        <article className="operator-card admin-post-panel">
          <div className="operator-card-head">
            <div>
              <span className="operator-label">Javna objava</span>
              <h3>Tekst spreman za kopiranje</h3>
            </div>
            <button type="button" className="primary-button" onClick={() => copyPost(post)}><Copy size={16}/> Kopiraj</button>
          </div>
          <pre>{post}</pre>
          <button type="button" className="ghost-button" onClick={() => copyPost(shortPost)}>Kopiraj kratku verziju</button>
          {copyStatus && <div className="copy-status">{copyStatus}</div>}
        </article>
      </div>

      <div className="admin-signal-grid">
        <article className="operator-card admin-signals-panel">
          <span className="operator-label">Signali</span>
          <h3>Što utječe na prikazano čekanje</h3>
          <div className="source-list compact-source-list">
            {sourceRows.map((row) => (
              <div className={`source-row ${row.tone}`} key={row.label}>
                <div>
                  <span>{row.label}</span>
                  <p>{row.note}</p>
                </div>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="operator-card admin-context-panel">
          <span className="operator-label">Kontekst</span>
          <h3>Gdje nastaje zadržavanje?</h3>
          <SegmentBar segments={direction.segments} />
          <p className="operator-help">Koristi se za objašnjenje korisniku zašto se preporučuje čekanje ili alternativa.</p>
        </article>

        <article className="operator-card admin-camera-panel">
          <span className="operator-label">Kamere</span>
          <h3>{laneAwareCameras.length ? 'Trake su označene' : 'Provjera kamera'}</h3>
          {laneAwareCameras.length ? (
            <div className="lane-admin-list">
              {laneAwareCameras.map((cam) => (
                <div key={cam.id}>
                  <strong>{cam.label}</strong>
                  <span>{cam.laneCalibration.zones.map((zone) => `${zone.label}: ${zone.kind}`).join(' · ')}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="operator-help">Za ovaj prijelaz koristi se opća provjera kamera i javnih izvora.</p>
          )}
          <p>{selectedDirection === 'toHr' ? 'Posebno pratiti ulaz u EU i moguće odvojene kolone.' : 'Posebno pratiti prilaz i kontrolnu zonu prije prijelaza.'}</p>
        </article>
      </div>
    </section>
  );
}


function buildFavoriteAlerts(trackedIds = [], selectedDirection = 'toBih', overrides = {}) {
  return trackedIds
    .map((id) => CROSSINGS.find((crossing) => crossing.id === id))
    .filter(Boolean)
    .map((crossing) => {
      const direction = getDirection(crossing, selectedDirection);
      const wait = getDisplayedWait(crossing, selectedDirection, overrides);
      if (!hasKnownWait(wait)) return null;
      const waitLabel = formatWaitDisplay(wait, getWaitSourceMeta(crossing, selectedDirection, overrides));
      const status = statusFromWait(wait);
      if (status === 'normal' && direction.trend !== 'rising') return null;
      const tone = status === 'critical' ? 'critical' : direction.trend === 'rising' ? 'busy' : status;
      const title = status === 'critical' ? `${crossing.shortName}: veliko čekanje` : `${crossing.shortName}: stanje se mijenja`;
      const message = status === 'critical'
        ? `${direction.label} je na ${waitLabel}. Provjeri kameru ili kartu prije polaska.`
        : `${direction.label} ima trend rasta. Trenutna procjena je ${waitLabel}.`;
      return { id: `${crossing.id}:${selectedDirection}:${tone}:${Math.round(wait)}`, crossingId: crossing.id, title, message, tone, wait };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function AlertTray({ alerts, onDismiss, onOpen }) {
  if (!alerts.length) return null;
  return (
    <aside className="alert-tray" aria-live="polite">
      <div className="alert-tray-head">
        <span><Bell size={14} /> Alerti favorita</span>
        <b>{alerts.length}</b>
      </div>
      {alerts.map((alert) => (
        <article key={alert.id} className={`alert-toast ${alert.tone}`}>
          <div>
            <strong>{alert.title}</strong>
            <p>{alert.message}</p>
          </div>
          <div className="alert-toast-actions">
            <button type="button" onClick={() => onOpen(alert.crossingId)}>Prikaži</button>
            <button type="button" aria-label="Zatvori alert" onClick={() => onDismiss(alert.id)}>×</button>
          </div>
        </article>
      ))}
    </aside>
  );
}

const NEAR_BORDER_KM = 6;
// App-level near-border prompt: when the user is within a few km of a crossing AND has already
// granted location, offer one tap to measure their A→B crossing. No continuous tracking, no
// permission popup on load (we only auto-check when permission is already 'granted'). While a
// measurement runs it becomes a discreet progress chip.
function NearBorderMeasurePrompt({ measurement, selectCrossing, setActiveTab }) {
  const [near, setNear] = useState(null);          // { id, name } when within NEAR_BORDER_KM
  const [dismissed, setDismissed] = useState({});   // crossingId -> true (this session only)
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current || !('geolocation' in navigator)) return;
    const runCheck = () => {
      if (checkedRef.current) return;
      checkedRef.current = true;
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
          let best = null;
          for (const c of CROSSINGS) {
            const km = haversineKm(pos, { lat: c.lat, lng: c.lng });
            if (Number.isFinite(km) && (!best || km < best.km)) best = { id: c.id, name: c.shortName || c.name, km };
          }
          if (best && best.km <= NEAR_BORDER_KM) setNear({ id: best.id, name: best.name });
        },
        () => {},
        { enableHighAccuracy: false, maximumAge: 120000, timeout: 15000 }
      );
    };
    // Only auto-check when permission is ALREADY granted — never surprise the user with a popup.
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'geolocation' }).then((s) => { if (s.state === 'granted') runCheck(); }).catch(() => {});
    }
  }, []);

  if (measurement.isMeasuring) {
    const label = measurement.paused ? 'Pauzirano dok je ekran ugašen — uključi ekran'
      : measurement.liveStatus === 'completed' ? 'Hvala — procjena je ažurirana'
      : measurement.liveStatus === 'active' ? 'Mjerim prelazak…'
      : 'Lokacija uključena — mjerim čim uđeš u kolonu';
    return (
      <div className={measurement.paused ? 'measure-chip measure-chip-paused' : 'measure-chip'} role="status">
        <Crosshair size={14} aria-hidden="true" />
        <span>{label}</span>
        <button type="button" onClick={() => measurement.stop()} aria-label="Zaustavi mjerenje">×</button>
      </div>
    );
  }
  if (!near || dismissed[near.id]) return null;
  return (
    <div className="measure-prompt" role="dialog" aria-label="Mjerenje prelaska">
      <div className="measure-prompt-body">
        <Crosshair size={18} aria-hidden="true" />
        <div>
          <strong>Blizu si prijelaza {near.name}</strong>
          <span>Uključi mjerenje prelaska — anonimno pomažeš ostalima da vide stvarno čekanje. Ne spremamo tvoju rutu.</span>
        </div>
      </div>
      <div className="measure-prompt-actions">
        <button type="button" className="measure-prompt-primary" onClick={() => { selectCrossing(near.id); setActiveTab('Mapa'); measurement.start({ crossingId: near.id, direction: 'auto' }); }}>Uključi mjerenje</button>
        <button type="button" onClick={() => setDismissed((d) => ({ ...d, [near.id]: true }))}>Ne sada</button>
      </div>
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useLocalStorage('bf_current_user_v2', null);
  const [activeTab, setActiveTab] = useState('Pregled');
  const measurement = useCrossingMeasurement(); // app-level A→B measurement (survives tab switches)
  const [selectedDirection, setSelectedDirection] = useState('toBih');
  const [selectedCrossing, setSelectedCrossing] = useState(CROSSINGS[0]);
  const [tripCrossing, setTripCrossing] = useState('maljevac');
  const [trackedIds, setTrackedIds] = useLocalStorage('bf_tracked_v1', ['maljevac']);
  const [overrides, setOverrides] = useLocalStorage('bf_overrides_v1', {});
  const [detailCrossing, setDetailCrossing] = useState(null);
  const [showTerms, setShowTerms] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showTripPass, setShowTripPass] = useState(false);
  const [billingNotice, setBillingNotice] = useState('');
  const [mapModeRequest, setMapModeRequest] = useState('map');
  const [dismissedAlerts, setDismissedAlerts] = useState({});
  const [notificationRules, setNotificationRules] = useLocalStorage('bf_notification_rules_v1', []);
  const [notificationEvents, setNotificationEvents] = useState([]);
  const [uiLanguage, setUiLanguage] = useLocalStorage('bf_ui_language_v1', 'hr');
  const [serverStateVersion, setServerStateVersion] = useState(0);

  useUiLanguage(uiLanguage);

  // Warm the Google Maps script at app startup. The map only renders once the script + libraries are
  // attached; loading it lazily on the FIRST "Mapa" visit is why the map showed blank until you went
  // to "Kamere" and back (by then the script was cached). Preloading makes the first visit behave like
  // the cached second visit. Safe no-op if the key is absent or it's already loaded.
  useEffect(() => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (key) loadGoogleMaps(key).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function validateSession() {
      if (!currentUser?.token) return;

      try {
        const payload = await fetchJson('/api/auth/me', {
          headers: { Authorization: `Bearer ${currentUser.token}` },
          timeoutMs: 6000,
        });

        if (!cancelled && payload?.user) {
          setCurrentUser((prev) => prev ? { ...payload.user, token: prev.token } : prev);
        }
      } catch {
        if (!cancelled) setCurrentUser(null);
      }
    }

    validateSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleRouteSanityUpdated() {
      setServerStateVersion((value) => value + 1);
    }
    window.addEventListener('bf-route-sanity-updated', handleRouteSanityUpdated);
    return () => window.removeEventListener('bf-route-sanity-updated', handleRouteSanityUpdated);
  }, []);

  // loadServerState is a useCallback so live signals (route fetch, camera rescan, admin refresh)
  // can push an immediate reload. `sync:true` asks the backend to AWAIT a due refresh and adds a
  // cache-busting query, so the response carries the NEW estimate, never a stale one.
  const loadServerState = useCallback(async ({ sync = false } = {}) => {
    try {
      // Public state endpoint is intentionally guest-readable so the app works before any login.
      // When a token is present we still send it so admin overrides can be reconciled.
      const headers = currentUser?.token ? { Authorization: `Bearer ${currentUser.token}` } : undefined;
      const query = `?${sync ? 'refresh=sync&' : ''}t=${Date.now()}`;
      const payload = await fetchJson(`/api/public/state${query}`, { timeoutMs: sync ? 20000 : 9000, headers });
      if (payload?.ok) {
        globalThis.__BF_EFFECTIVE_WAITS = payload.effectiveWaits || {};
        globalThis.__BF_WAIT_SOURCES = payload.waitSources || {};
        globalThis.__BF_STATUS_OVERRIDES = payload.statusOverrides || {};
        globalThis.__BF_SOURCE_REFRESH = payload.sourceRefresh || {};
        globalThis.__BF_STATE_READY = true;
        // Only replace overrides when the CONTENT changed — otherwise a new object identity every
        // poll re-triggers the route-fetch effect (which dep on overrides), which dispatches a live
        // signal, which reloads state… an "every second" feedback loop that also kept re-fitting
        // the map. Returning the previous reference when equal keeps effects quiet.
        if (payload.overrides) {
          setOverrides((prev) => {
            try { return JSON.stringify(prev) === JSON.stringify(payload.overrides) ? prev : payload.overrides; }
            catch { return payload.overrides; }
          });
        }
        setServerStateVersion((value) => value + 1);
      }
      return payload;
    } catch {
      // App stays usable with local fallback state when backend is unavailable.
      return null;
    }
  }, [setOverrides, currentUser?.token]);

  useEffect(() => {
    loadServerState();
    const timer = window.setInterval(loadServerState, PUBLIC_STATE_POLL_MS);
    // A fresh live signal (route/camera/admin) pushes an immediate sync reload so the marker and
    // headline update within seconds instead of waiting for the next poll.
    const onLiveSignal = () => loadServerState({ sync: true });
    window.addEventListener(LIVE_SIGNAL_EVENT, onLiveSignal);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(LIVE_SIGNAL_EVENT, onLiveSignal);
    };
  }, [loadServerState]);

  const viewer = currentUser || { name: 'Gost', role: 'user' };
  const tabs = viewer.role === 'admin' ? TABS_ADMIN : TABS_USER;

  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab('Pregled');
  }, [activeTab, tabs]);

  const direction = getDirection(selectedCrossing, selectedDirection);
  const selectedWait = getDisplayedWait(selectedCrossing, selectedDirection, overrides);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const crossingId = params.get('crossing');
    const directionParam = params.get('direction');
    const tabParam = params.get('tab');
    if (directionParam === 'toHr' || directionParam === 'toBih') setSelectedDirection(directionParam);
    if (crossingId && CROSSINGS.some((item) => item.id === crossingId)) selectCrossing(crossingId);
    if (tabParam && [...TABS_USER, ...TABS_ADMIN].includes(tabParam)) setActiveTab(tabParam);
    // Stripe Checkout redirect: ?billing=success → thank the user (entitlements refresh via /api/auth/me
    // on mount) and ?billing=cancel → silently clean up. Strip the param either way.
    const billing = params.get('billing');
    if (billing === 'success') setBillingNotice('Hvala! Trip Pass je aktiviran.');
    if (billing) {
      params.delete('billing');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable identity: this is passed to GoogleMapView as setSelectedCrossing, which is a dependency
  // of the (expensive) map-create + fitBounds effect. A fresh function every render would recreate
  // the map and reset the zoom on every state refresh — keep it memoised.
  const selectCrossing = useCallback((idOrCrossing) => {
    const crossing = typeof idOrCrossing === 'string'
      ? CROSSINGS.find((item) => item.id === idOrCrossing)
      : idOrCrossing;
    if (!crossing) return;
    setSelectedCrossing(crossing);
    setTripCrossing(crossing.id);
  }, [setSelectedCrossing, setTripCrossing]);

  function toggleTracked(id) {
    setTrackedIds(trackedIds.includes(id) ? trackedIds.filter((item) => item !== id) : [...trackedIds, id]);
  }

  async function addNotificationRule({ crossingId, direction = selectedDirection, type = 'below_wait', threshold = 15 }) {
    const crossing = CROSSINGS.find((item) => item.id === crossingId);
    if (!crossing) return;
    const id = `${crossingId}:${direction}:${type}:${threshold}`;
    setNotificationRules((current) => {
      const without = (current || []).filter((rule) => rule.id !== id);
      return [{ id, crossingId, direction, type, threshold, enabled: true, createdAt: new Date().toISOString() }, ...without].slice(0, 20);
    });
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
    setNotificationEvents((current) => [{ id: `${id}:saved:${Date.now()}`, crossingId, tone: 'normal', title: 'Obavijest spremljena', message: `${crossing.shortName}: javit ćemo dok je app otvoren kad se uvjet ispuni.` }, ...current].slice(0, 4));
  }

  useEffect(() => {
    if (!notificationRules?.length) return;
    const triggered = [];
    const nextRules = notificationRules.map((rule) => {
      if (!rule.enabled) return rule;
      const crossing = CROSSINGS.find((item) => item.id === rule.crossingId);
      if (!crossing) return rule;
      const sourceMeta = getWaitSourceMeta(crossing, rule.direction, overrides);
      const wait = getDisplayedWait(crossing, rule.direction, overrides);
      const op = getOperationalStatus(crossing, rule.direction, wait, sourceMeta);
      const triggerKey = rule.type === 'route_open'
        ? `${op.status}:${sourceMeta.updatedAt || ''}`
        : `${Math.floor(Number(wait || 0) / 5)}:${sourceMeta.updatedAt || ''}`;
      const shouldTrigger = rule.type === 'route_open'
        ? op.status === 'open'
        : hasKnownWait(wait) && Number(wait) <= Number(rule.threshold || 15);
      if (!shouldTrigger || rule.lastTriggeredKey === triggerKey) return rule;
      const title = rule.type === 'route_open' ? `${crossing.shortName}: ruta je otvorena` : `${crossing.shortName}: čekanje je palo`;
      const message = rule.type === 'route_open'
        ? `${dirPairLabel(crossing, rule.direction)} ponovno izgleda prohodno.`
        : `${dirPairLabel(crossing, rule.direction)} je sada ${formatWaitDisplay(wait, sourceMeta)}.`;
      triggered.push({ id: `${rule.id}:${triggerKey}`, crossingId: crossing.id, tone: 'normal', title, message });
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(title, { body: message }); } catch {}
      }
      return { ...rule, lastTriggeredKey: triggerKey, lastTriggeredAt: new Date().toISOString() };
    });
    if (triggered.length) {
      setNotificationEvents((current) => [...triggered, ...current].slice(0, 6));
      setNotificationRules(nextRules);
    }
  }, [notificationRules, overrides, selectedDirection, serverStateVersion, setNotificationRules]);

  const favoriteAlerts = useMemo(() => buildFavoriteAlerts(trackedIds, selectedDirection, overrides), [trackedIds, selectedDirection, overrides]);
  const visibleAlerts = [...notificationEvents, ...favoriteAlerts].filter((alert) => !dismissedAlerts[alert.id]).slice(0, 5);

  function openAlertReport(crossingId) {
    selectCrossing(crossingId);
    setActiveTab('Pregled');
  }

  return (
    <main className="app">
      <header className="top-shell premium-shell">
        <div className="brand-row premium-brand-row">
          <div className="brand premium-brand">
            <div className="brand-mark premium-brand-mark">PR</div>
            <div className="brand-copy">
              <strong>PrijelazRadar</strong>
              <span>Stanje na granici uživo</span>
            </div>
          </div>
          <div className="top-actions premium-top-actions clean-top-actions">
            <LanguageToggle value={uiLanguage} onChange={setUiLanguage} />
            <button type="button" className="icon-help-button" onClick={() => setShowTerms(true)} aria-label="Kako računamo stanje" title="Kako računamo stanje">?</button>
            {currentUser && (
              <button type="button" className={`trippass-button${currentUser.entitlements?.hasActivePass ? ' is-active' : ''}`} onClick={() => setShowTripPass(true)} title="Trip Pass">
                {currentUser.entitlements?.hasActivePass ? '★ Pass' : 'Trip Pass'}
              </button>
            )}
            {currentUser
              ? <button type="button" className="logout-button" onClick={() => setCurrentUser(null)}><LogOut size={15}/> Odjava</button>
              : <button type="button" className="logout-button" onClick={() => setShowAuth(true)}>Prijava</button>
            }
          </div>
        </div>
        <nav className="tabs production-tabs premium-tabs" aria-label="Glavna navigacija">{tabs.map((tab) => {
          const meta = NAV_META[tab] || { label: tab, hint: '' };
          const Icon = NAV_ICONS[tab] || Navigation;
          return (
            <button key={tab} type="button" className={activeTab === tab ? 'active' : ''} aria-current={activeTab === tab ? 'page' : undefined} onClick={() => { if (tab === 'Mapa') setMapModeRequest('map'); setActiveTab(tab); }}>
              <Icon size={18} />
              <span className="nav-copy"><strong>{meta.label}</strong><span>{meta.hint}</span></span>
            </button>
          );
        })}</nav>
        <section className="hero premium-hero">
          <div className="hero-copy">
            <div className="hero-eyebrow-row">
              <span className="kicker">Granični promet uživo</span>
              <span className="hero-live-chip"><i /> Oba smjera aktivna</span>
            </div>
            <h1>Znaj kada krenuti i koji prijelaz odabrati.</h1>
            <p>PrijelazRadar ti na jednom mjestu pokazuje čekanja, rute i kamere za HR → BiH i BiH → HR.</p>
            <div className="hero-proof-row">
              <div>
                <span>Odabrani prijelaz</span>
                <strong>{selectedCrossing.shortName}</strong>
              </div>
              <div>
                <span>Trenutno čekanje</span>
                <strong>{formatWaitDisplay(selectedWait, getWaitSourceMeta(selectedCrossing, selectedDirection, overrides))}</strong>
              </div>
              <div>
                <span>Smjer prikaza</span>
                <strong>{direction.label}</strong>
              </div>
            </div>
          </div>
          <aside className="hero-command-card" aria-label="Sažetak odabranog prijelaza">
            <RoadSign crossing={selectedCrossing} direction={direction} wait={selectedWait} sourceMeta={getWaitSourceMeta(selectedCrossing, selectedDirection, overrides)} />
            <label className="hero-crossing-select"><span>Prijelaz</span><select value={selectedCrossing.id} onChange={(event) => selectCrossing(event.target.value)}>{CROSSINGS.map((crossing) => <option key={crossing.id} value={crossing.id}>{crossing.name}</option>)}</select></label>
            <div className="hero-route-cities">
              <span>HR</span>
              <i />
              <span>BiH</span>
            </div>
            <div className="hero-command-footer">
              <button type="button" onClick={() => { setMapModeRequest('camera'); setActiveTab('Mapa'); }}><Camera size={14} /> Kamere</button>
            </div>
            <div className="hero-system-row">
              <SystemStatus compact />
              <span>Podaci se osvježavaju automatski. Najnovije stanje vidiš u karticama prijelaza.</span>
            </div>
          </aside>
        </section>
      </header>

      {activeTab === 'Pregled' && <PublicView selectedDirection={selectedDirection} setSelectedDirection={setSelectedDirection} selectedCrossing={selectedCrossing} setSelectedCrossing={selectCrossing} trackedIds={trackedIds} toggleTracked={toggleTracked} openDetail={setDetailCrossing} overrides={overrides} addNotificationRule={addNotificationRule} />}
      {activeTab === 'Moj put' && <TripPlanner selectedDirection={selectedDirection} setSelectedDirection={setSelectedDirection} tripCrossing={tripCrossing} setTripCrossing={setTripCrossing} selectedCrossing={selectedCrossing} setSelectedCrossing={selectCrossing} setActiveTab={setActiveTab} overrides={overrides} currentUser={currentUser} />}
      {activeTab === 'Mapa' && <MapView selectedDirection={selectedDirection} setSelectedDirection={setSelectedDirection} selectedCrossing={selectedCrossing} setSelectedCrossing={selectCrossing} requestedMode={mapModeRequest} overrides={overrides} stateVersion={serverStateVersion} measurement={measurement} />}
      {activeTab === 'Povijest' && <HistoryView selectedCrossing={selectedCrossing} setSelectedCrossing={selectCrossing} selectedDirection={selectedDirection} setSelectedDirection={setSelectedDirection} overrides={overrides} />}
      {activeTab === 'Admin' && viewer.role === 'admin' && currentUser && <AdminView selectedCrossing={selectedCrossing} setSelectedCrossing={selectCrossing} selectedDirection={selectedDirection} setSelectedDirection={setSelectedDirection} overrides={overrides} setOverrides={setOverrides} currentUser={currentUser} />}

      <DetailModal crossing={detailCrossing} selectedDirection={selectedDirection} overrides={overrides} onClose={() => setDetailCrossing(null)} onTrack={toggleTracked} tracked={detailCrossing ? trackedIds.includes(detailCrossing.id) : false} setTripCrossing={setTripCrossing} setSelectedCrossing={selectCrossing} setActiveTab={setActiveTab} addNotificationRule={addNotificationRule} />
      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
      <AlertTray alerts={visibleAlerts} onOpen={openAlertReport} onDismiss={(id) => setDismissedAlerts((current) => ({ ...current, [id]: true }))} />
      <NearBorderMeasurePrompt measurement={measurement} selectCrossing={selectCrossing} setActiveTab={setActiveTab} />

      {showAuth && (
        <div className="auth-modal-backdrop" onClick={() => setShowAuth(false)}>
          <div className="auth-modal-card" onClick={(event) => event.stopPropagation()}>
            <AuthScreen compact onCancel={() => setShowAuth(false)} setCurrentUser={(user) => { setCurrentUser(user); setShowAuth(false); }} />
          </div>
        </div>
      )}

      {showTripPass && <TripPassModal currentUser={currentUser} onClose={() => setShowTripPass(false)} />}

      {billingNotice && (
        <div className="billing-toast" role="status" onClick={() => setBillingNotice('')}>
          {billingNotice}<span className="billing-toast-close">×</span>
        </div>
      )}
    </main>
  );
}
