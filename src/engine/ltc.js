// Codeur / décodeur LTC (SMPTE 12M), portage de projets/timecode-ltc/sim/ltc/ltc.py.
// Sert au générateur de signaux (forme « LTC ») et au décodeur de l'oscilloscope.
//
// Structure de trame (SMPTE ST 12-1) : 80 bits, BCD, mot de synchro sur les bits
// 64 à 79, bit de correction de polarité (27, ou 59 à 25 i/s) pour un nombre pair
// de zéros. Modulation biphase-mark : une transition à chaque frontière de bit,
// plus une au milieu d'un bit à 1.

export const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

export const LTC_RATES = {
  "23.976": { label: "23,976 i/s", fps: 24000 / 1001, nominal: 24, drop: false },
  "24": { label: "24 i/s", fps: 24, nominal: 24, drop: false },
  "25": { label: "25 i/s", fps: 25, nominal: 25, drop: false },
  "29.97DF": { label: "29,97 i/s drop-frame", fps: 30000 / 1001, nominal: 30, drop: true },
  "29.97ND": { label: "29,97 i/s non drop", fps: 30000 / 1001, nominal: 30, drop: false },
  "30": { label: "30 i/s", fps: 30, nominal: 30, drop: false },
};

/** Ajoute n images au timecode [h, m, s, f], drop-frame compris. */
export function tcAdd(tc, n, nominal, drop) {
  let [h, m, s, f] = tc;
  for (let i = 0; i < n; i++) {
    f += 1;
    if (f >= nominal) {
      f = 0; s += 1;
      if (s >= 60) {
        s = 0; m += 1;
        if (m >= 60) { m = 0; h = (h + 1) % 24; }
      }
      if (drop && s === 0 && f === 0 && m % 10 !== 0) f = 2; // images 00 et 01 sautées
    }
  }
  return [h, m, s, f];
}

const bcd = (bits, start, value, width) => { for (let i = 0; i < width; i++) bits[start + i] = (value >> i) & 1; };

export function encodeFrame(tc, nominal = 25, drop = false, userBits = 0) {
  const [h, m, s, f] = tc;
  const b = new Array(80).fill(0);
  bcd(b, 0, f % 10, 4); bcd(b, 8, Math.floor(f / 10), 2);
  b[10] = drop ? 1 : 0;
  bcd(b, 16, s % 10, 4); bcd(b, 24, Math.floor(s / 10), 3);
  bcd(b, 32, m % 10, 4); bcd(b, 40, Math.floor(m / 10), 3);
  bcd(b, 48, h % 10, 4); bcd(b, 56, Math.floor(h / 10), 2);
  [4, 12, 20, 28, 36, 44, 52, 60].forEach((pos, k) => bcd(b, pos, (userBits >> (4 * k)) & 0xf, 4));
  for (let i = 0; i < 16; i++) b[64 + i] = SYNC[i];
  const pol = nominal === 25 ? 59 : 27;
  b[pol] = 0;
  if (b.filter((x) => x === 0).length % 2) b[pol] = 1;
  return b;
}

/**
 * Instants de transition d'un LTC de `nframes` images à partir de `tc0`, le
 * premier bit commençant à t0. Retourne { edges, tcs, bitPeriod }.
 */
export function ltcEdges(tc0, nframes, rate = "25", t0 = 0) {
  const { fps, nominal, drop } = LTC_RATES[rate];
  const bitPeriod = 1 / (fps * 80);
  const edges = [], tcs = [];
  let tc = tc0, t = t0;
  for (let n = 0; n < nframes; n++) {
    tcs.push(tc);
    for (const bit of encodeFrame(tc, nominal, drop)) {
      edges.push(t);
      if (bit) edges.push(t + bitPeriod / 2);
      t += bitPeriod;
    }
    tc = tcAdd(tc, 1, nominal, drop);
  }
  return { edges, tcs, bitPeriod };
}

/** Instants de franchissement d'un seuil, avec hystérésis (thrLo < thrHi), interpolés. */
export function crossings(t, v, thrHi, thrLo = thrHi) {
  let state = v[0] > thrHi;
  const out = [];
  for (let i = 1; i < v.length; i++) {
    if (!state && v[i] > thrHi) {
      const a = v[i] !== v[i - 1] ? (thrHi - v[i - 1]) / (v[i] - v[i - 1]) : 0;
      out.push(t[i - 1] + a * (t[i] - t[i - 1])); state = true;
    } else if (state && v[i] < thrLo) {
      const a = v[i] !== v[i - 1] ? (thrLo - v[i - 1]) / (v[i] - v[i - 1]) : 0;
      out.push(t[i - 1] + a * (t[i] - t[i - 1])); state = false;
    }
  }
  return out;
}

/**
 * Décodeur, comme le firmware : chaque intervalle entre transitions est classé
 * demi-bit ou bit avec un seuil adaptatif à 3/4 de la durée de bit estimée,
 * puis on cherche le mot de synchro et on lit les champs BCD.
 * Retourne [{ tc: [h, m, s, f], drop, tStart, evenZeros }].
 */
export function decodeEdges(edges) {
  if (edges.length < 40) return [];
  const iv = edges.slice(1).map((e, k) => e - edges[k]);
  const maxIv = iv.reduce((a, b) => Math.max(a, b), 0);
  const longs = iv.filter((x) => x > 0.75 * maxIv);
  let bitEst = longs.reduce((s, x) => s + x, 0) / longs.length;
  const bits = [], bitT = [];
  let half = null;
  iv.forEach((d, k) => {
    if (d > 0.75 * bitEst) {
      half = null;
      bits.push(0); bitT.push(edges[k]);
      bitEst = 0.9 * bitEst + 0.1 * d;
    } else if (half === null) {
      half = edges[k];
    } else {
      bits.push(1); bitT.push(half);
      bitEst = 0.9 * bitEst + 0.1 * (d + (edges[k] - half));
      half = null;
    }
  });
  const frames = [];
  for (let i = 64; i + 16 <= bits.length; i++) {
    let sync = true;
    for (let j = 0; j < 16 && sync; j++) sync = bits[i + j] === SYNC[j];
    if (!sync) continue;
    const fb = bits.slice(i - 64, i + 16);
    const val = (st, w) => { let x = 0; for (let j = 0; j < w; j++) x |= fb[st + j] << j; return x; };
    frames.push({
      tc: [val(56, 2) * 10 + val(48, 4), val(40, 3) * 10 + val(32, 4), val(24, 3) * 10 + val(16, 4), val(8, 2) * 10 + val(0, 4)],
      drop: fb[10],
      tStart: bitT[i - 64],
      evenZeros: fb.filter((x) => x === 0).length % 2 === 0,
      bitPeriod: bitEst,
    });
    i += 15;
  }
  return frames;
}

export const fmtTc = (tc, drop = false) => `${tc.slice(0, 3).map((x) => String(x).padStart(2, "0")).join(":")}${drop ? ";" : ":"}${String(tc[3]).padStart(2, "0")}`;

export function parseTc(s) {
  const m = String(s).trim().match(/^(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})$/);
  return m ? m.slice(1).map(Number) : null;
}

/** Cadence la plus proche d'une durée de bit mesurée. */
export function guessRate(bitPeriod) {
  const fps = 1 / (80 * bitPeriod);
  let best = null;
  for (const [k, r] of Object.entries(LTC_RATES)) if (!best || Math.abs(r.fps - fps) < Math.abs(LTC_RATES[best].fps - fps)) best = k;
  return { fps, rate: best };
}
