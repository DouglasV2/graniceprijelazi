// Pure helpers that turn persisted hourly history slots into driver-facing insights:
// "when is it actually worth crossing here?" — peak / calmest / typical wait and the best
// consecutive-hours window. Honest by design: with too few real samples the caller gets
// lowData=true and must show an "insufficient data" state instead of fabricated patterns.

function finiteWait(slot) {
  return slot && slot.hour !== undefined && slot.hour !== null && Number.isFinite(Number(slot.wait));
}

export function computeHistoryInsights(series = [], { minSamples = 6, windowSize = 3 } = {}) {
  const slots = (Array.isArray(series) ? series : []).filter(finiteWait);
  const sampleCount = slots.length;
  const empty = { sampleCount, lowData: true, peak: null, calm: null, typicalRange: null, bestWindow: null, worstWindow: null };
  if (!sampleCount) return empty;

  const sorted = [...slots].sort((a, b) => Number(a.wait) - Number(b.wait));
  const calmSlot = sorted[0];
  const peakSlot = sorted[sorted.length - 1];
  const quantile = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return Number(sorted[idx].wait);
  };
  const typicalRange = { min: quantile(0.25), max: quantile(0.75) };

  // Best/worst window: consecutive-hour stretch with the lowest/highest average wait.
  const byHour = [...slots].sort((a, b) => Number(a.hour) - Number(b.hour));
  const size = Math.max(1, Math.min(windowSize, byHour.length));
  let bestWindow = null;
  let worstWindow = null;
  for (let i = 0; i + size <= byHour.length; i += 1) {
    const win = byHour.slice(i, i + size);
    const consecutive = win.every((slot, j) => j === 0 || Number(slot.hour) - Number(win[j - 1].hour) <= 2);
    if (!consecutive) continue;
    const avg = win.reduce((sum, slot) => sum + Number(slot.wait), 0) / win.length;
    const item = { startHour: Number(win[0].hour), endHour: Number(win[win.length - 1].hour) + 1, avg, avgWait: Math.round(avg) };
    if (!bestWindow || avg < bestWindow.avg) bestWindow = item;
    if (!worstWindow || avg > worstWindow.avg) worstWindow = item;
  }

  return {
    sampleCount,
    lowData: sampleCount < minSamples,
    peak: { hour: String(peakSlot.hour), wait: Number(peakSlot.wait) },
    calm: { hour: String(calmSlot.hour), wait: Number(calmSlot.wait) },
    typicalRange,
    bestWindow,
    worstWindow,
  };
}

// 'better' | 'worse' | 'similar' | null — how the CURRENT live wait compares to the typical
// (p25–p75) historical band. Null when either side is unknown, so the UI says nothing.
export function compareNowToTypical(currentWait, typicalRange) {
  if (currentWait === null || currentWait === undefined || currentWait === '') return null;
  const now = Number(currentWait);
  if (!Number.isFinite(now) || !typicalRange || !Number.isFinite(Number(typicalRange.min)) || !Number.isFinite(Number(typicalRange.max))) return null;
  if (now < Number(typicalRange.min) - 2) return 'better';
  if (now > Number(typicalRange.max) + 2) return 'worse';
  return 'similar';
}

export function formatHourWindow(startHour, endHour) {
  const pad = (h) => `${String(Math.max(0, Math.min(24, Number(h) || 0))).padStart(2, '0')}:00`;
  return `${pad(startHour)}–${pad(endHour)}`;
}
