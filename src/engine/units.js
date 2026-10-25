const PREFIXES = [
  [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
];

const trimZeros = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

export function fmt(value, unit, digits = 3) {
  if (!Number.isFinite(value)) return "—";
  const a = Math.abs(value);
  if (a < 1e-13) return `0 ${unit}`;
  for (const [f, p] of PREFIXES) {
    if (a >= f * 0.9995) return `${trimZeros((value / f).toPrecision(digits))} ${p}${unit}`;
  }
  return `${value.toExponential(2)} ${unit}`;
}

// "4k7", "220", "1.5M", "10k" -> nombre
export function parseSI(text) {
  const s = String(text).trim().replace(",", ".").replace(/\s*(Ω|ohm|V|A|W)$/i, "");
  const m = s.match(/^(-?\d*\.?\d+)\s*([GMkKmuµnp]?)(\d*)$/);
  if (!m) return NaN;
  const mult = { G: 1e9, M: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, "µ": 1e-6, n: 1e-9, p: 1e-12, "": 1 }[m[2]];
  const base = m[3] ? parseFloat(`${m[1]}.${m[3]}`) : parseFloat(m[1]);
  return base * mult;
}
