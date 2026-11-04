// Mesures automatiques d'oscilloscope sur une trace échantillonnée.
import { crossings, decodeEdges, guessRate, fmtTc, LTC_RATES } from "./ltc.js";

const percentile = (arr, q) => {
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

/** Temps de montée / descente 10-90 % moyens sur toutes les transitions complètes. */
export function edgeTimes(t, v, lo, hi) {
  const a = lo + 0.1 * (hi - lo), b = lo + 0.9 * (hi - lo);
  const rises = [], falls = [];
  let ta = null, tb = null, up = false, down = false;
  const cross = (i, thr) => t[i - 1] + (thr - v[i - 1]) / (v[i] - v[i - 1]) * (t[i] - t[i - 1]);
  for (let i = 1; i < v.length; i++) {
    if (v[i - 1] < a && v[i] >= a) { ta = cross(i, a); up = true; }
    if (up && v[i - 1] < b && v[i] >= b) { rises.push(cross(i, b) - ta); up = false; }
    if (v[i - 1] > b && v[i] <= b) { tb = cross(i, b); down = true; }
    if (down && v[i - 1] > a && v[i] <= a) { falls.push(cross(i, a) - tb); down = false; }
  }
  const mean = (x) => (x.length ? x.reduce((s, y) => s + y, 0) / x.length : NaN);
  return { rise: mean(rises), fall: mean(falls), n: rises.length + falls.length };
}

/**
 * Mesures d'une voie : min, max, crête à crête (0,5 à 99,5 %), moyenne,
 * fronts 10-90 %, et décodage LTC.
 * `from` : instant à partir duquel on mesure (laisser passer le régime initial).
 */
export function measureTrace(t, v, from = 0) {
  let i0 = 0;
  while (i0 < t.length && t[i0] < from) i0++;
  const tt = t.subarray(i0), vv = v.subarray(i0);
  if (vv.length < 4) return null;
  const lo = percentile(vv, 0.005), hi = percentile(vv, 0.995);
  let sum = 0;
  for (let i = 1; i < vv.length; i++) sum += 0.5 * (vv[i] + vv[i - 1]) * (tt[i] - tt[i - 1]);
  const mean = sum / (tt[tt.length - 1] - tt[0]);
  const vpp = hi - lo;
  let min = Infinity, max = -Infinity;
  for (const x of vv) { if (x < min) min = x; if (x > max) max = x; }
  const res = { min, max, lo, hi, vpp, mean };
  if (vpp > 1e-3) {
    Object.assign(res, edgeTimes(tt, vv, lo, hi));
    // Décodage LTC : seuil au milieu, hystérésis ±5 % de l'excursion.
    const mid = (lo + hi) / 2;
    const edges = crossings(t, v, mid + 0.05 * vpp, mid - 0.05 * vpp);
    const frames = decodeEdges(edges);
    if (frames.length) {
      const g = guessRate(frames[0].bitPeriod);
      const drop = !!frames[0].drop;
      // une image est valide si elle suit la précédente (même règle que les simulations ngspice)
      res.ltc = {
        frames: frames.map((f) => ({ tc: f.tc, text: fmtTc(f.tc, drop), t: f.tStart, evenZeros: f.evenZeros })),
        fps: g.fps, rate: g.rate, label: LTC_RATES[g.rate].label, drop,
      };
    }
  }
  return res;
}
