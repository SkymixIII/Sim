// Diodes et LED : modèle de Shockley avec résistance série et claquage inverse.
import { fmt } from "../engine/units.js";
import { stampJunction, junctionIG, fitIsFromVf } from "../engine/devices.js";

// Paramètres SPICE publiés par les fabricants (ou ajustés sur leur fiche technique).
export const DIODE_MODELS = {
  "1N4148": {
    label: "1N4148 (signal)", Is: 2.52e-9, n: 1.752, Rs: 0.568, BV: 100, Ibv: 100e-6,
    IFmax: 0.3, Pmax: 0.5, VRmax: 75,
    ref: "Vishay 1N4148 : VF ≤ 1 V à 10 mA, IF max 300 mA, VR 75 V, Ptot 500 mW. Modèle SPICE IS=2.52n N=1.752 RS=0.568.",
  },
  "1N4007": {
    label: "1N4007 (redressement)", Is: 7.02767e-9, n: 1.80803, Rs: 0.0341512, BV: 1000, Ibv: 5e-6,
    IFmax: 1, Pmax: 3, VRmax: 1000,
    ref: "Diodes Inc. 1N4007 : VF ≤ 1,1 V à 1 A, IF(AV) 1 A, VRRM 1000 V. Modèle SPICE IS=7.03n N=1.808 RS=34m.",
  },
  "1N5819": {
    label: "1N5819 (Schottky)", Is: 31.7e-6, n: 1.373, Rs: 0.051, BV: 40, Ibv: 1e-3,
    IFmax: 1, Pmax: 1.25, VRmax: 40,
    ref: "ON Semi 1N5819 : VF max 0,34 V à 0,1 A et 0,6 V à 1 A, IF(AV) 1 A, VRRM 40 V. Modèle SPICE usuel IS=31.7u N=1.373 RS=51m.",
  },
  "1N4733A": {
    label: "1N4733A (Zener 5,1 V)", Is: 1e-12, n: 1.4, Rs: 7, BV: 4.757, Ibv: 0.049, nbv: 1.5,
    IFmax: 0.2, Pmax: 1, VRmax: Infinity, zener: true,
    ref: "Vishay 1N4733A : VZ = 5,1 V à IZT = 49 mA, ZZT ≤ 7 Ω, Ptot 1 W, IZM 178 mA.",
  },
};

const diodeBody = (zener) => `<line x1="0" y1="0" x2="30" y2="0"/><polygon class="fill" points="30,-10 30,10 48,0"/>${zener ? `<polyline points="44,14 48,10 48,-10 52,-14"/>` : `<line x1="48" y1="-10" x2="48" y2="10"/>`}<line x1="48" y1="0" x2="80" y2="0"/>`;

function junctionResult(ctx, nodes, p) {
  const [a, k, ai] = nodes;
  const vj = ctx.v(ai) - ctx.v(k);
  const I = junctionIG(vj, p, ctx.tempC).I;
  const V = ctx.v(a) - ctx.v(k);
  return { V, I, P: V * I, Vmin: V };
}

export const diode = {
  type: "diode",
  name: "Diode",
  category: "Semi-conducteurs",
  summary: "Diode réelle : seuil, résistance série, fuite et claquage inverse.",
  pins: [{ id: "A", label: "Anode", x: 0, y: 0 }, { id: "K", label: "Cathode", x: 4, y: 0 }],
  bounds: { x: 0, y: -0.8, w: 4, h: 1.6 },
  rotatable: true,
  params: [{ key: "model", label: "Référence", kind: "select", default: "1N4148", options: Object.entries(DIODE_MODELS).map(([value, m]) => ({ value, label: m.label })) }],
  get datasheet() { return { source: "Modèle de Shockley I = Is·(e^(V/nVt) − 1) + résistance série + claquage inverse (modèle D de SPICE).", notes: Object.values(DIODE_MODELS).map((m) => m.ref) }; },
  internalNodes: () => 1,
  stamp(ctx, inst, [a, k, ai], br, state) {
    const m = DIODE_MODELS[inst.params.model];
    ctx.conductance(a, ai, 1 / m.Rs);
    stampJunction(ctx, state, "vd", ai, k, m);
  },
  evaluate(ctx, inst, nodes) { return junctionResult(ctx, nodes, DIODE_MODELS[inst.params.model]); },
  describe(inst, avg, peak) {
    const m = DIODE_MODELS[inst.params.model];
    const warnings = [];
    let damage;
    if (avg.P > 2 * m.Pmax) damage = `Détruite : ${fmt(avg.P, "W")} dissipés (max ${fmt(m.Pmax, "W")}).`;
    else if (avg.P > m.Pmax) warnings.push({ level: "danger", text: `Dissipe ${fmt(avg.P, "W")}, au-delà de Ptot = ${fmt(m.Pmax, "W")}.` });
    if (!m.zener && peak.I > m.IFmax) warnings.push({ level: "danger", text: `Courant direct ${fmt(peak.I, "A")} > IF max ${fmt(m.IFmax, "A")}.` });
    if (-peak.Vmin > m.VRmax) warnings.push({ level: "danger", text: `Tension inverse ${fmt(-peak.Vmin, "V")} > VR max ${fmt(m.VRmax, "V")}.` });
    const state = avg.V > 0.3 && avg.I > 1e-4 ? "passante" : m.zener && avg.V < -m.BV * 0.9 ? "en régime Zener" : "bloquée";
    return { readings: [["État", state], ["Tension A–K", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")], ["Puissance", fmt(avg.P, "W")]], warnings, damage };
  },
  label: (inst) => inst.params.model,
  symbol: (inst) => diodeBody(DIODE_MODELS[inst.params.model].zener),
};

// LED 5 mm traversantes : point (VF, IF) typique de fiche technique, idéalité n et résistance dynamique.
// Is est recalculé pour que la LED passe exactement par VF à IF.
export const LED_COLORS = {
  red: { label: "Rouge 625 nm", color: "#ff2a1a", vf: 2.0, n: 2.0, Rs: 8, Iv: 200, tech: "AlGaInP" },
  orange: { label: "Orange 605 nm", color: "#ff8a10", vf: 2.0, n: 2.0, Rs: 8, Iv: 250, tech: "AlGaInP" },
  yellow: { label: "Jaune 590 nm", color: "#ffd000", vf: 2.1, n: 2.0, Rs: 9, Iv: 200, tech: "AlGaInP" },
  green: { label: "Vert 525 nm", color: "#22e04a", vf: 3.1, n: 3.2, Rs: 12, Iv: 1500, tech: "InGaN" },
  blue: { label: "Bleu 470 nm", color: "#2f6bff", vf: 3.2, n: 3.2, Rs: 12, Iv: 600, tech: "InGaN" },
  white: { label: "Blanc froid", color: "#f4f7ff", vf: 3.2, n: 3.2, Rs: 12, Iv: 2000, tech: "InGaN + phosphore" },
};
const LED_IF = 0.02, LED_IFMAX = 0.03, LED_IFPEAK = 0.1, LED_VRMAX = 5;

export function ledParams(color) {
  const c = LED_COLORS[color];
  return { ...c, Is: fitIsFromVf(c.vf, LED_IF, c.n, c.Rs), BV: 25, Ibv: 1e-5, nbv: 2 };
}

export const led = {
  type: "led",
  name: "LED",
  category: "Optoélectronique",
  summary: "LED 5 mm : tension de seuil selon la couleur, luminosité proportionnelle au courant.",
  pins: [{ id: "A", label: "Anode (+, patte longue)", x: 0, y: 0 }, { id: "K", label: "Cathode (−, méplat)", x: 4, y: 0 }],
  bounds: { x: 0, y: -1.2, w: 4, h: 2 },
  rotatable: true,
  params: [{ key: "color", label: "Couleur", kind: "select", default: "red", options: Object.entries(LED_COLORS).map(([value, c]) => ({ value, label: c.label })) }],
  datasheet: {
    source: "LED 5 mm génériques (ex. Kingbright L-53 / L-7113) : IF nominal 20 mA, IF max 30 mA continu, 100 mA crête (1/10, 0,1 ms), VR max 5 V.",
    notes: [
      "VF typique à 20 mA : rouge/orange 2,0 V, jaune 2,1 V (AlGaInP) ; vert, bleu, blanc 3,1 à 3,2 V (InGaN).",
      "Intensité lumineuse supposée proportionnelle au courant (bonne approximation de 1 à 30 mA).",
      "Au-delà de 100 mA en continu la LED est considérée comme détruite (circuit ouvert).",
    ],
  },
  internalNodes: () => 1,
  stamp(ctx, inst, [a, k, ai], br, state) {
    const p = ledParams(inst.params.color);
    ctx.conductance(a, ai, 1 / p.Rs);
    stampJunction(ctx, state, "vd", ai, k, p);
  },
  evaluate(ctx, inst, nodes) {
    return junctionResult(ctx, nodes, ledParams(inst.params.color));
  },
  describe(inst, avg, peak) {
    const p = ledParams(inst.params.color);
    const warnings = [];
    let damage;
    if (avg.I > LED_IFPEAK) damage = `Grillée : ${fmt(avg.I, "A")} en continu (max ${fmt(LED_IFMAX, "A")} en continu, 100 mA en crête). Ajoutez une résistance en série.`;
    else if (peak.I > LED_IFPEAK) warnings.push({ level: "danger", text: `Courant crête ${fmt(peak.I, "A")} > 100 mA.` });
    else if (avg.I > LED_IFMAX) warnings.push({ level: "danger", text: `${fmt(avg.I, "A")} > 30 mA max continu : la LED va vieillir très vite.` });
    if (-peak.Vmin > LED_VRMAX) warnings.push({ level: "danger", text: `Tension inverse ${fmt(-peak.Vmin, "V")} > 5 V max.` });
    const mcd = Math.max(0, avg.I) / LED_IF * p.Iv;
    return {
      readings: [["Tension A–K", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")], ["Intensité lumineuse", mcd < 0.01 ? "éteinte" : `≈ ${mcd < 10 ? mcd.toFixed(1) : Math.round(mcd)} mcd`], ["Puissance", fmt(avg.P, "W")]],
      warnings, damage,
    };
  },
  label: (inst) => LED_COLORS[inst.params.color].label.split(" ")[0],
  symbol(inst, avg) {
    const c = LED_COLORS[inst.params.color];
    const I = Math.max(0, avg?.I ?? 0);
    const glow = inst.damaged ? 0 : Math.min(1, Math.sqrt(I / LED_IF));
    return `<circle cx="40" cy="0" r="${14 + 12 * glow}" style="fill:${c.color};opacity:${(0.55 * glow).toFixed(3)};stroke:none;filter:blur(${4 + 4 * glow}px)"/>`
      + `<circle cx="40" cy="0" r="15" style="fill:${c.color};fill-opacity:${(0.12 + 0.75 * glow).toFixed(3)};stroke-opacity:.5"/>`
      + diodeBody(false)
      + `<g class="arrows"><line x1="44" y1="-14" x2="54" y2="-24"/><polyline points="49,-24 54,-24 54,-19"/><line x1="52" y1="-10" x2="62" y2="-20"/><polyline points="57,-20 62,-20 62,-15"/></g>`;
  },
};
