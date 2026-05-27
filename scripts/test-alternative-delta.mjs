/**
 * Tests for alternative delta logic and minute display guards.
 * Run with: node scripts/test-alternative-delta.mjs
 */

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

// ─── Replicate the helpers from App.jsx ───────────────────────────────────────

function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '—';
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '—';
  if (n < 0) return `-${formatMinutes(Math.abs(n))}`;
  if (n < 60) return `${Math.round(n)} min`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function hasKnownWait(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function isUsableMinuteValue(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function normalizeMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
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
      label: 'Alternativa se isplati',
      className: 'better',
      note: `Može biti oko ${formatMinutes(value)} brža od planiranog prijelaza.`,
    };
  }
  if (value > 0) {
    return {
      label: 'Alternativa može biti brža',
      className: 'better',
      note: `Mala prednost — razlika je oko ${formatMinutes(value)}.`,
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

// Simulate alternativesFor logic for a single case
function computeAltCard(selectedWait, altWait, extraDrive) {
  const borderSaving = hasKnownWait(selectedWait) && hasKnownWait(altWait)
    ? Number(selectedWait) - Number(altWait)
    : null;
  const netBenefit = hasKnownWait(borderSaving) ? Number(borderSaving) - extraDrive : -999;
  const deltaMeta = getAlternativeDeltaMeta(netBenefit);
  const displayWait = isUsableMinuteValue(altWait) ? formatMinutes(altWait) : '—';
  return { borderSaving, netBenefit, deltaMeta, displayWait };
}

// ─── Test: isUsableMinuteValue ────────────────────────────────────────────────
console.log('\n[isUsableMinuteValue]');
assert(isUsableMinuteValue(0) === true, '0 is usable (confirmed no wait)');
assert(isUsableMinuteValue(5) === true, '5 is usable');
assert(isUsableMinuteValue(-1) === false, '-1 is NOT usable');
assert(isUsableMinuteValue(null) === false, 'null is NOT usable');
assert(isUsableMinuteValue(undefined) === false, 'undefined is NOT usable');
assert(isUsableMinuteValue(NaN) === false, 'NaN is NOT usable');
assert(isUsableMinuteValue('') === false, 'empty string is NOT usable');

// ─── Test: normalizeMinutes ───────────────────────────────────────────────────
console.log('\n[normalizeMinutes]');
assert(normalizeMinutes(5) === 5, '5 → 5');
assert(normalizeMinutes(-1) === null, '-1 → null');
assert(normalizeMinutes(null) === null, 'null → null');
assert(normalizeMinutes(NaN) === null, 'NaN → null');
assert(normalizeMinutes(5.7) === 6, '5.7 rounds to 6');
assert(normalizeMinutes(0) === 0, '0 → 0');

// ─── Test: formatMinutes — no negative display ────────────────────────────────
console.log('\n[formatMinutes negative guard]');
// formatMinutes(-1) technically returns "-1 min" — this is intentional for math display
// but we prevent it from reaching the UI via isUsableMinuteValue
const negDisplay = formatMinutes(-1);
assert(negDisplay === '-1 min', 'formatMinutes(-1) returns -1 min (internal)');
// The fix is that we use isUsableMinuteValue BEFORE calling formatMinutes for waits
assert(isUsableMinuteValue(-1) === false, 'isUsableMinuteValue(-1) prevents -1 from showing');

// ─── Test: screenshot bug case A: "-1 min - 28 min = 29 min" ─────────────────
console.log('\n[Bug A: planned=-1, alternative=28]');
// Simulates: selectedWait=5, altWait=6 → borderSaving=-1, extraDrive=28 → netBenefit=-29
const caseA = computeAltCard(5, 6, 28);
assert(caseA.displayWait === '6 min', 'Alt wait display is "6 min" (positive, fine)');
assert(!caseA.deltaMeta.label.includes('-'), 'Delta label has no negative sign');
assert(!caseA.deltaMeta.note.includes('-1'), 'Note does not contain "-1"');
assert(caseA.deltaMeta.className === 'warning', 'netBenefit=-29 → warning (just above critical threshold of -30)');
assert(caseA.deltaMeta.label === 'Planirani prijelaz je bolji izbor', 'Correct label for -29');
console.log(`  [details] borderSaving=${caseA.borderSaving}, netBenefit=${caseA.netBenefit}, label="${caseA.deltaMeta.label}"`);

// ─── Test: screenshot bug case B: "13 min - 0 min = 13 min brže" ─────────────
console.log('\n[Bug B: planned=13, alternative=0 (unconfirmed)]');
// altWait=0 with extraDrive=0 → borderSaving=13, netBenefit=13
const caseB = computeAltCard(13, 0, 0);
// "0 min" wait: isUsableMinuteValue(0) = true, so it IS displayed. But 0 min only
// makes sense if confirmed by a real source. In current logic we cannot distinguish
// "confirmed 0" from "unconfirmed 0" at display level, but we can show "—" if
// the value comes as null from getDisplayedWait (the real guard is upstream).
// Here we test that the DELTA calculation is correct and the label is sensible.
assert(!caseB.deltaMeta.label.includes('brže'), 'Label does not contain raw "brže" suffix with number');
assert(caseB.deltaMeta.className === 'better', 'netBenefit=13 → better (small)');
assert(caseB.deltaMeta.label === 'Alternativa može biti brža', 'netBenefit=13 → small benefit label');
console.log(`  [details] borderSaving=${caseB.borderSaving}, netBenefit=${caseB.netBenefit}, label="${caseB.deltaMeta.label}"`);

// ─── Test: planned=null, alternative=20 ──────────────────────────────────────
console.log('\n[null planned wait]');
const caseC = computeAltCard(null, 20, 15);
assert(caseC.netBenefit === -999, 'null selectedWait → netBenefit sentinel -999');
assert(caseC.deltaMeta.className === 'unknown', 'unknown class for no-data case');
assert(caseC.deltaMeta.label === 'Nema dovoljno podataka', 'Correct no-data label');

// ─── Test: netBenefit >= 15 (clear winner) ────────────────────────────────────
console.log('\n[Alternative clearly faster: netBenefit=20]');
const caseD = getAlternativeDeltaMeta(20);
assert(caseD.className === 'better', 'className=better');
assert(caseD.label === 'Alternativa se isplati', 'Correct "isplati" label');
assert(caseD.note.includes('20 min'), 'Note includes the saving amount');
assert(!caseD.label.includes('min'), 'Label itself has no raw minutes');

// ─── Test: alternative slightly faster (0 < netBenefit < 15) ─────────────────
console.log('\n[Alternative slightly faster: netBenefit=8]');
const caseE = getAlternativeDeltaMeta(8);
assert(caseE.className === 'better', 'className=better for small benefit');
assert(caseE.label === 'Alternativa može biti brža', 'Mala prednost label');

// ─── Test: small difference ───────────────────────────────────────────────────
console.log('\n[Small difference: netBenefit=-5]');
const caseF = getAlternativeDeltaMeta(-5);
assert(caseF.className === 'neutral', 'className=neutral for small penalty');
assert(caseF.label === 'Razlika je mala', 'Razlika je mala label');

// ─── Test: warning range ──────────────────────────────────────────────────────
console.log('\n[Planned better: netBenefit=-20]');
const caseG = getAlternativeDeltaMeta(-20);
assert(caseG.className === 'warning', 'className=warning');
assert(caseG.label === 'Planirani prijelaz je bolji izbor', 'Planirani bolji label');
assert(!caseG.label.includes('min'), 'No raw minutes in label');
assert(!caseG.label.includes('-'), 'No negative sign in label');

// ─── Test: critical range ─────────────────────────────────────────────────────
console.log('\n[Planned much better: netBenefit=-45]');
const caseH = getAlternativeDeltaMeta(-45);
assert(caseH.className === 'critical', 'className=critical');
assert(caseH.label === 'Planirani prijelaz je puno bolji', 'Puno bolji label');

// ─── Test: no technical jargon in any public label ────────────────────────────
console.log('\n[No technical jargon in labels/notes]');
const allMetas = [
  getAlternativeDeltaMeta(-999),
  getAlternativeDeltaMeta(-45),
  getAlternativeDeltaMeta(-20),
  getAlternativeDeltaMeta(-5),
  getAlternativeDeltaMeta(8),
  getAlternativeDeltaMeta(20),
];
const forbidden = ['fallback', 'snapshot', 'debug', 'calibrat', 'confidence model', 'raw', 'NaN', 'undefined', 'null'];
for (const meta of allMetas) {
  for (const term of forbidden) {
    assert(!meta.label.toLowerCase().includes(term), `Label does not contain "${term}": "${meta.label}"`);
    assert(!meta.note.toLowerCase().includes(term), `Note does not contain "${term}": "${meta.note}"`);
  }
}

// ─── Test: negative wait never reaches UI via isUsableMinuteValue ─────────────
console.log('\n[Negative wait display guard]');
const negativeWaits = [-1, -5, -0.5, -100];
for (const w of negativeWaits) {
  const card = computeAltCard(20, w, 5);
  assert(card.displayWait === '—', `Negative wait ${w} → displays as "—"`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ All ${passed} tests passed.`);
} else {
  console.log(`❌ ${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
}
