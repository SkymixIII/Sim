// Circuits intégrés analogiques : comparateur TLV3201 et amplificateur opérationnel TLV9061.
// Macro-modèles comportementaux calés sur les fiches TI (mêmes hypothèses que
// projets/timecode-ltc/sim/models/composants.lib, validés contre ngspice dans
// tests/transient.test.mjs).
import { fmt } from "../engine/units.js";
import { stampJunction, junctionIG } from "../engine/devices.js";

// Diodes ESD internes des entrées vers les rails. HYPOTHÈSE : TI ne publie pas
// leurs paramètres ; on reprend ceux des diodes de protection de l'ESP32.
const ESD = { Is: 1e-14, n: 1 };

const tri = (labels) => `<polygon points="10,-40 10,40 90,0" style="fill:var(--chip, none)"/>`
  + `<line x1="0" y1="-20" x2="10" y2="-20"/><line x1="0" y1="20" x2="10" y2="20"/><line x1="90" y1="0" x2="100" y2="0"/>`
  + `<line x1="40" y1="-40" x2="40" y2="-25"/><line x1="40" y1="40" x2="40" y2="25"/>`
  + `<text class="pm" x="15" y="-15">${labels[0]}</text><text class="pm" x="15" y="25">${labels[1]}</text>`;

const ANALOG_PINS = (sup) => [
  { id: "INN", label: "IN− (entrée inverseuse)", x: 0, y: -1 },
  { id: "INP", label: "IN+ (entrée non inverseuse)", x: 0, y: 1 },
  { id: "OUT", label: "Sortie", x: 5, y: 0 },
  { id: sup[0], label: sup[0] === "VCC" ? "VCC (alimentation +)" : "V+ (alimentation +)", x: 2, y: -2 },
  { id: sup[1], label: sup[1] === "GND" ? "GND (masse)" : "V− (alimentation −)", x: 2, y: 2 },
];

// Diodes ESD de IN vers le rail haut et du rail bas vers IN.
function stampEsd(ctx, state, inn, inp, hi, lo) {
  stampJunction(ctx, state, "esd_nh", inn, hi, ESD);
  stampJunction(ctx, state, "esd_nl", lo, inn, ESD);
  stampJunction(ctx, state, "esd_ph", inp, hi, ESD);
  stampJunction(ctx, state, "esd_pl", lo, inp, ESD);
}
function esdCurrent(ctx, inn, inp, hi, lo) {
  const d = (a, k) => junctionIG(ctx.v(a) - ctx.v(k), ESD, ctx.tempC).I;
  return Math.max(d(inn, hi), d(lo, inn), d(inp, hi), d(lo, inp));
}
const ESD_LIMIT = 10e-3;

/**
 * Limitation du pas de Newton sur un étage tanh (l'équivalent de pnjlim pour
 * une jonction) : l'argument ne bouge que de 2 par itération tant qu'on est dans
 * la zone de basculement ou qu'on traverse vers la saturation opposée.
 */
export function tanhLimit(ctx, state, key, x) {
  const old = state[key] ?? 0;
  const SAT = 10;
  if (Math.abs(old) >= SAT && Math.abs(x) >= SAT && Math.sign(old) === Math.sign(x)) { state[key] = x; return x; }
  const o = Math.max(-SAT, Math.min(SAT, old));
  const xl = Math.max(o - 2, Math.min(o + 2, x));
  if (xl !== x) ctx.markLimited();
  state[key] = xl;
  return xl;
} // courant d'entrée max absolu (TLV3201 et TLV9061 : ±10 mA)

function inputWarnings(peak, avg, warnings) {
  if (peak.Iesd > 1e-3) warnings.push({ level: peak.Iesd > ESD_LIMIT ? "danger" : "warn", text: `Une entrée dépasse les rails : ${fmt(peak.Iesd, "A")} dans les diodes de protection internes (max absolu 10 mA).` });
  if ((peak.VinOver ?? 0) > 0.5) warnings.push({ level: "danger", text: `Entrée à ${fmt(peak.VinOver, "V")} au-delà d'un rail (max absolu 0,5 V).` });
}

export const tlv3201 = {
  type: "tlv3201",
  name: "Comparateur TLV3201",
  category: "Circuits intégrés",
  summary: "Comparateur rapide rail à rail, sortie push-pull (TI TLV3201, SOT-23-5).",
  pins: ANALOG_PINS(["VCC", "GND"]),
  bounds: { x: 0, y: -2, w: 5, h: 4 },
  rotatable: true,
  params: [{ key: "VOS", label: "Tension d'offset", kind: "number", unit: "V", default: 1e-3 }],
  datasheet: {
    source: "TI TLV3201 (SBOS561) : alimentation 2,7 à 5,5 V, mode commun de VEE − 0,2 V à VCC + 0,2 V, VOS 1 mV typ / 3 mV max, hystérésis interne 1,2 mV, tpd 47 ns, VOL 230 mV à 4 mA (2,7 V), 40 µA, entrées ±10 mA max. Brochage DBV : 1 OUT, 2 GND, 3 IN+, 4 IN−, 5 VCC.",
    notes: [
      "Modèle : étage d'entrée tanh très raide (gain ≈ 3300 au basculement), sortie de Thévenin vers les rails de 57 Ω (tirée de VOL = 230 mV à 4 mA).",
      "En transitoire, la sortie bascule un pas de calcul après l'entrée (1 µs par défaut, contre 47 ns de temps de propagation réel) : retard négligeable devant un demi-bit LTC (208 µs).",
      "Non modélisée : l'hystérésis interne de 1,2 mV (négligée, pessimiste). L'hystérésis se fait par résistances externes.",
      "Le courant de sortie revient par la broche GND ; la consommation propre (40 µA) est ramenée à une résistance entre VCC et GND.",
      "Diodes de protection des entrées vers les rails : paramètres supposés (non publiés).",
    ],
  },
  stamp(ctx, inst, [inn, inp, out, vcc, gnd], br, state) {
    const VS = 0.5e-3, RO = 57;
    const g = 1 / RO;
    ctx.conductance(vcc, gnd, 40e-6 / 3.3);
    stampEsd(ctx, state, inn, inp, vcc, gnd);
    ctx.conductance(out, gnd, g);
    if (ctx.mode === "tran") {
      // En transitoire, la décision est prise sur les entrées du pas précédent :
      // un retard d'un pas (1 µs typiquement, contre 47 ns pour le vrai composant)
      // qui rend le basculement sûr malgré la réaction positive de l'hystérésis.
      const u = (ctx.vPrev(inp) - ctx.vPrev(inn) - inst.params.VOS) / VS;
      ctx.transconductance(out, gnd, vcc, gnd, -g * 0.5 * (1 + Math.tanh(u)));
      return;
    }
    const d = ctx.v(inp) - ctx.v(inn);
    const u = tanhLimit(ctx, state, "u", (d - inst.params.VOS) / VS);
    const dl = u * VS + inst.params.VOS; // d au point de linéarisation
    const th = Math.tanh(u);
    const sig = 0.5 * (1 + th);
    const dsig = 0.5 * (1 - th * th) / VS;
    const W = ctx.v(vcc) - ctx.v(gnd);
    // courant sortant de OUT vers GND = g(Vout − Vg) − gσW − gWσ'(d − dl)
    ctx.transconductance(out, gnd, vcc, gnd, -g * sig);
    ctx.transconductance(out, gnd, inp, inn, -g * W * dsig);
    ctx.current(out, gnd, g * W * dsig * dl);
  },
  evaluate(ctx, inst, [inn, inp, out, vcc, gnd]) {
    const W = ctx.v(vcc) - ctx.v(gnd);
    const vi = ctx.mode === "tran" ? ctx.vPrev : ctx.v;
    const d = vi(inp) - vi(inn) - inst.params.VOS;
    const vint = ctx.v(gnd) + W * 0.5 * (1 + Math.tanh(d / 0.5e-3));
    const Iout = (vint - ctx.v(out)) / 57;
    const over = Math.max(ctx.v(inn) - ctx.v(vcc), ctx.v(gnd) - ctx.v(inn), ctx.v(inp) - ctx.v(vcc), ctx.v(gnd) - ctx.v(inp));
    return { Vout: ctx.v(out) - ctx.v(gnd), Iout, Vsup: W, Iesd: esdCurrent(ctx, inn, inp, vcc, gnd), VinOver: over, high: d > 0 ? 1 : 0 };
  },
  describe(inst, avg, peak) {
    const warnings = [];
    const vs = avg.Vsup ?? 0;
    if (vs < 2.7) warnings.push({ level: "warn", text: `Alimentation ${fmt(vs, "V")} : en dessous de 2,7 V, hors plage garantie.` });
    if (vs > 5.5) warnings.push({ level: "danger", text: `Alimentation ${fmt(vs, "V")} > 5,5 V.` });
    inputWarnings(peak, avg, warnings);
    return {
      readings: [["Sortie (moy.)", fmt(avg.Vout, "V")], ["Temps à l'état haut", `${Math.round(100 * (avg.high ?? 0))} %`], ["Courant de sortie crête", fmt(Math.abs(peak.Iout ?? 0), "A")], ["Alimentation", fmt(vs, "V")]],
      warnings,
      damage: (peak.Iesd ?? 0) > 5 * ESD_LIMIT ? `Entrée détruite : ${fmt(peak.Iesd, "A")} dans les diodes de protection.` : undefined,
    };
  },
  label: () => "TLV3201",
  symbol: () => tri(["−", "+"]) + `<polyline points="50,-6 56,-6 56,6 64,6" style="stroke-width:1.5"/>`,
};

export const tlv9061 = {
  type: "tlv9061",
  name: "Ampli op TLV9061",
  category: "Circuits intégrés",
  summary: "Amplificateur opérationnel rail à rail 10 MHz, sortie ±50 mA (TI TLV9061, SOT-23-5).",
  pins: ANALOG_PINS(["VP", "VN"]),
  bounds: { x: 0, y: -2, w: 5, h: 4 },
  rotatable: true,
  params: [{ key: "VOS", label: "Tension d'offset", kind: "number", unit: "V", default: 0.3e-3 }],
  datasheet: {
    source: "TI TLV9061 (SBOS839) : 1,8 à 5,5 V, GBW 10 MHz, slew rate 6,5 V/µs, AOL 104 dB, IQ 538 µA, courant de court-circuit ±50 mA, entrées et sortie rail à rail. Brochage DBV : 1 OUT, 2 V−, 3 IN+, 4 IN−, 5 V+.",
    notes: [
      "Modèle statique : gain AOL = 104 dB saturé en tanh entre les rails, sortie 25 Ω (HYPOTHÈSE) limitée à ±50 mA.",
      "Pas de pôle dominant : valable pour des signaux lents devant 10 MHz / gain (le LTC : 2,4 kHz). Le slew rate n'est pas limité, mais une alerte s'affiche s'il est dépassé en analyse transitoire.",
      "Le courant de sortie revient par V− ; la consommation propre (538 µA) est ramenée à une résistance entre V+ et V−.",
    ],
  },
  stamp(ctx, inst, [inn, inp, out, vp, vn], br, state) {
    const AOL = 1.585e5, RO = 25, ILIM = 0.05, MARGIN = 0.01;
    const g = 1 / RO;
    const VP = ctx.v(vp), VN = ctx.v(vn), Vo = ctx.v(out);
    const H = Math.max((VP - VN) / 2 - MARGIN, 1e-3);
    const s = tanhLimit(ctx, state, "s", AOL * (ctx.v(inp) - ctx.v(inn) - inst.params.VOS) / H);
    const dl = s * H / AOL;                 // tension différentielle (hors offset) au point de linéarisation
    const th = Math.tanh(s), sech2 = 1 - th * th;
    const vint = (VP + VN) / 2 + H * th;
    const kd = AOL * sech2;
    const kr = 0.5 * (th - s * sech2); // dérivée de H·tanh(AOL·d/H) par rapport à H, × 1/2
    const kp = 0.5 + kr, kn = 0.5 - kr;
    const z = g * (vint - Vo) / ILIM;
    const tz = Math.tanh(z);
    // Limitation de courant : tanh, plus une petite pente résiduelle (g/1000) qui
    // garde la matrice bien conditionnée quand la sortie est en butée.
    const I0 = ILIM * tz + 1e-3 * g * (vint - Vo); // courant fourni à OUT
    const gz = g * (1 - tz * tz) + 1e-3 * g;
    // courant sortant de OUT vers V− : −I ≈ −I0 − gz·(Vint − Vint0) + gz·(Vout − Vout0)
    ctx.transconductance(out, vn, out, 0, gz);
    ctx.transconductance(out, vn, inp, inn, -gz * kd);
    ctx.transconductance(out, vn, vp, 0, -gz * kp);
    ctx.transconductance(out, vn, vn, 0, -gz * kn);
    ctx.current(out, vn, -I0 + gz * (kd * (dl + inst.params.VOS) + kp * VP + kn * VN - Vo));
    ctx.conductance(vp, vn, 538e-6 / 3.3);
    stampEsd(ctx, state, inn, inp, vp, vn);
  },
  evaluate(ctx, inst, [inn, inp, out, vp, vn]) {
    const VP = ctx.v(vp), VN = ctx.v(vn);
    const d = ctx.v(inp) - ctx.v(inn) - inst.params.VOS;
    const H = Math.max((VP - VN) / 2 - 0.01, 1e-3);
    const vint = (VP + VN) / 2 + H * Math.tanh(1.585e5 * d / H);
    const Iout = 0.05 * Math.tanh((vint - ctx.v(out)) / 25 / 0.05) + 1e-3 * (vint - ctx.v(out)) / 25;
    const SR = ctx.mode === "tran" && ctx.dt > 0 ? Math.abs((ctx.v(out) - ctx.vPrev(out)) / ctx.dt) : 0;
    const over = Math.max(ctx.v(inn) - VP, VN - ctx.v(inn), ctx.v(inp) - VP, VN - ctx.v(inp));
    return { Vout: ctx.v(out), Iout, Vsup: VP - VN, SR, Iesd: esdCurrent(ctx, inn, inp, vp, vn), VinOver: over, Vmin_out: ctx.v(out) };
  },
  describe(inst, avg, peak) {
    const warnings = [];
    const vs = avg.Vsup ?? 0;
    if (vs < 1.8) warnings.push({ level: "warn", text: `Alimentation ${fmt(vs, "V")} : en dessous de 1,8 V, hors plage garantie.` });
    if (vs > 5.5) warnings.push({ level: "danger", text: `Alimentation ${fmt(vs, "V")} > 5,5 V.` });
    if (Math.abs(peak.Iout ?? 0) > 0.045) warnings.push({ level: "danger", text: `Sortie en limitation de courant (${fmt(Math.abs(peak.Iout), "A")}, max ±50 mA).` });
    if ((peak.SR ?? 0) > 6.5e6) warnings.push({ level: "warn", text: `Vitesse de variation demandée ${fmt(peak.SR / 1e6, "V")}/µs > 6,5 V/µs : le vrai composant serait limité (non modélisé).` });
    inputWarnings(peak, avg, warnings);
    return {
      readings: [["Sortie (moy.)", fmt(avg.Vout, "V")], ["Sortie min / max", `${fmt(peak.Vmin_out ?? avg.Vout, "V")} / ${fmt(peak.Vout ?? avg.Vout, "V")}`], ["Courant de sortie crête", fmt(Math.abs(peak.Iout ?? 0), "A")], ["Vitesse de sortie max", `${fmt((peak.SR ?? 0) / 1e6, "V")}/µs`], ["Alimentation", fmt(vs, "V")]],
      warnings,
      damage: (peak.Iesd ?? 0) > 5 * ESD_LIMIT ? `Entrée détruite : ${fmt(peak.Iesd, "A")} dans les diodes de protection.` : undefined,
    };
  },
  label: () => "TLV9061",
  symbol: () => tri(["−", "+"]),
};
