// Capteurs analogiques : thermistance CTN, photorésistance, capteurs de température à sortie tension.
import { fmt } from "../engine/units.js";
import { lead } from "./shapes.js";

const degC = (v) => `${Math.round(v)} °C`;

export const ntc = {
  type: "ntc",
  name: "Thermistance CTN 10 kΩ",
  category: "Capteurs",
  summary: "Résistance qui diminue quand la température augmente (10 kΩ à 25 °C).",
  pins: [{ id: "1", x: 0, y: 0 }, { id: "2", x: 4, y: 0 }],
  bounds: { x: 0, y: -0.8, w: 4, h: 1.6 },
  rotatable: true,
  params: [{ key: "T", label: "Température", kind: "range", default: 25, min: -40, max: 125, step: 1, display: degC }],
  datasheet: {
    source: "Vishay NTCLE100E3103 : R25 = 10 kΩ, B25/85 = 3977 K, −40 à +125 °C. Loi R(T) = R25·exp(B·(1/T − 1/T25)).",
    notes: ["En pont diviseur avec une résistance fixe de 10 kΩ, la tension lue par un ADC donne la température.", "Non modélisé : auto-échauffement (≈ 1 °C par 7,5 mW dissipés), tolérance ±5 %."],
  },
  R: (inst) => 10e3 * Math.exp(3977 * (1 / (inst.params.T + 273.15) - 1 / 298.15)),
  stamp(ctx, inst, [a, b]) { ctx.conductance(a, b, 1 / this.R(inst)); },
  evaluate(ctx, inst, [a, b]) { const V = ctx.v(a) - ctx.v(b), I = V / this.R(inst); return { V, I, P: V * I }; },
  describe(inst, avg) {
    return {
      readings: [["Température", degC(inst.params.T)], ["Résistance", fmt(this.R(inst), "Ω")], ["Tension", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")]],
      warnings: avg.P > 0.0075 ? [{ level: "warn", text: `Dissipe ${fmt(avg.P, "W")} : l'auto-échauffement fausse la mesure de plus de 1 °C.` }] : [],
    };
  },
  reading(inst) { return fmt(this.R(inst), "Ω"); },
  label: (inst) => `CTN ${degC(inst.params.T)}`,
  symbol: () => `${lead(0, 22)}<rect x="22" y="-7" width="36" height="14" rx="1"/>${lead(58, 80)}<polyline points="24,14 32,14 52,-14"/><text class="pm" x="54" y="-10">−t°</text>`,
};

const LUX = [0.1, 1, 10, 50, 100, 300, 500, 1000, 5000, 10000, 50000];
export const ldr = {
  type: "ldr",
  name: "Photorésistance (LDR)",
  category: "Capteurs",
  summary: "Résistance qui diminue quand la lumière augmente.",
  pins: [{ id: "1", x: 0, y: 0 }, { id: "2", x: 4, y: 0 }],
  bounds: { x: 0, y: -1.2, w: 4, h: 2 },
  rotatable: true,
  params: [{ key: "lux", label: "Éclairement", kind: "select", default: 300, options: [
    { value: 0.1, label: "0,1 lux (nuit de pleine lune)" }, { value: 1, label: "1 lux (crépuscule)" }, { value: 10, label: "10 lux (bougie proche)" }, { value: 50, label: "50 lux (salon tamisé)" },
    { value: 100, label: "100 lux (couloir)" }, { value: 300, label: "300 lux (bureau)" }, { value: 500, label: "500 lux (atelier)" }, { value: 1000, label: "1 000 lux (ciel couvert)" },
    { value: 5000, label: "5 000 lux (ombre en plein jour)" }, { value: 10000, label: "10 000 lux (plein jour)" }, { value: 50000, label: "50 000 lux (soleil direct)" }] }],
  datasheet: {
    source: "GL5528 : 8 à 20 kΩ à 10 lux (12 kΩ retenus), γ = 0,7, 1 MΩ dans le noir, 100 mW max, 150 V max. Loi R = R10·(E/10)^−γ.",
    notes: ["Forte dispersion d'une pièce à l'autre (du simple au double). Non modélisé : temps de réponse (20 à 30 ms)."],
  },
  R: (inst) => Math.min(1e6, 12e3 * Math.pow(inst.params.lux / 10, -0.7)),
  stamp(ctx, inst, [a, b]) { ctx.conductance(a, b, 1 / this.R(inst)); },
  evaluate(ctx, inst, [a, b]) { const V = ctx.v(a) - ctx.v(b), I = V / this.R(inst); return { V, I, P: V * I }; },
  describe(inst, avg) {
    return {
      readings: [["Résistance", fmt(this.R(inst), "Ω")], ["Tension", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")]],
      warnings: avg.P > 0.1 ? [{ level: "danger", text: `Dissipe ${fmt(avg.P, "W")} : au-delà de 100 mW.` }] : [],
    };
  },
  reading(inst) { return fmt(this.R(inst), "Ω"); },
  label: (inst) => `LDR ${inst.params.lux} lx`,
  symbol: () => `${lead(0, 22)}<rect x="22" y="-7" width="36" height="14" rx="1"/>${lead(58, 80)}<g class="arrows"><line x1="26" y1="-24" x2="36" y2="-12"/><polyline points="31,-12 36,-12 36,-17"/><line x1="38" y1="-24" x2="48" y2="-12"/><polyline points="43,-12 48,-12 48,-17"/></g>`,
};

const TEMP_ICS = {
  LM35: { label: "LM35 (10 mV/°C, 0 V à 0 °C)", v0: 0, k: 0.01, Vmin: 4, Vmax: 30, absMax: 35, Iq: 60e-6, Tmin: 2, Tmax: 150,
    ref: "TI LM35DZ : 10 mV/°C, 0 V à 0 °C (montage de base : +2 à +150 °C), alimentation 4 à 30 V, 60 µA, précision ±0,5 °C à 25 °C, impédance de sortie 0,1 Ω." },
  TMP36: { label: "TMP36 (10 mV/°C, 750 mV à 25 °C)", v0: 0.5, k: 0.01, Vmin: 2.7, Vmax: 5.5, absMax: 7, Iq: 50e-6, Tmin: -40, Tmax: 125,
    ref: "Analog Devices TMP36 : 10 mV/°C, 750 mV à 25 °C (500 mV à 0 °C), −40 à +125 °C, alimentation 2,7 à 5,5 V, < 50 µA, précision ±1 °C à 25 °C." },
};

export const tempSensor = {
  type: "tempic",
  name: "Capteur de température",
  category: "Capteurs",
  summary: "Capteur intégré à sortie analogique : 10 mV par degré, à lire avec un ADC.",
  pins: [{ id: "VS", label: "+VS (alimentation)", x: 0, y: 0, name: "+Vs" }, { id: "OUT", label: "Sortie analogique", x: 6, y: 0, name: "OUT" }, { id: "GND", label: "Masse", x: 3, y: 2, name: "GND" }],
  bounds: { x: 1, y: -1, w: 4, h: 2 },
  rotatable: false,
  params: [
    { key: "model", label: "Référence", kind: "select", default: "TMP36", options: Object.entries(TEMP_ICS).map(([value, m]) => ({ value, label: m.label })) },
    { key: "T", label: "Température", kind: "range", default: 25, min: -40, max: 150, step: 1, display: degC },
  ],
  get datasheet() { return { source: "Capteurs de température à sortie tension linéaire.", notes: [...Object.values(TEMP_ICS).map((m) => m.ref), "Non modélisé : erreur de précision, auto-échauffement, sortie limitée à quelques mA."] }; },
  vout(inst) { const m = TEMP_ICS[inst.params.model]; return Math.max(0, m.v0 + m.k * Math.min(m.Tmax, Math.max(m.Tmin, inst.params.T))); },
  stamp(ctx, inst, [vs, out, gnd]) {
    const m = TEMP_ICS[inst.params.model];
    const v = ctx.v(vs) - ctx.v(gnd);
    ctx.conductance(vs, gnd, m.Iq / m.Vmin);
    const target = v >= m.Vmin ? Math.min(this.vout(inst), v - 1) : 0;
    ctx.conductance(out, gnd, 10);
    ctx.current(gnd, out, target * 10 * ctx.srcFactor);
  },
  evaluate(ctx, inst, [vs, out, gnd]) { return { Vs: ctx.v(vs) - ctx.v(gnd), Vout: ctx.v(out) - ctx.v(gnd) }; },
  describe(inst, avg) {
    const m = TEMP_ICS[inst.params.model];
    const warnings = [];
    let damage;
    if (avg.Vs > m.absMax) damage = `Détruit : ${fmt(avg.Vs, "V")} d'alimentation (max ${m.absMax} V).`;
    else if (avg.Vs < -0.3) damage = "Détruit : alimentation inversée.";
    else if (avg.Vs < m.Vmin) warnings.push({ level: "warn", text: `Alimentation ${fmt(avg.Vs, "V")} : il faut ${fmt(m.Vmin, "V")} à ${fmt(m.Vmax, "V")}.` });
    else if (avg.Vs > m.Vmax) warnings.push({ level: "danger", text: `Alimentation ${fmt(avg.Vs, "V")} > ${fmt(m.Vmax, "V")}.` });
    if (inst.params.T < m.Tmin || inst.params.T > m.Tmax) warnings.push({ level: "warn", text: `Hors de la plage de mesure (${m.Tmin} à ${m.Tmax} °C).` });
    return { readings: [["Température", degC(inst.params.T)], ["Sortie", fmt(avg.Vout, "V")], ["Alimentation", fmt(avg.Vs, "V")]], warnings, damage };
  },
  reading: (inst, avg) => fmt(avg.Vout, "V"),
  label: (inst) => `${inst.params.model} · ${degC(inst.params.T)}`,
  symbol() {
    return `<rect class="ic" x="20" y="-20" width="80" height="40" rx="4"/><text class="chip" x="60" y="5">T°</text>`
      + `<line x1="0" y1="0" x2="20" y2="0"/><text class="pinlabel" x="25" y="-9">+Vs</text><line x1="100" y1="0" x2="120" y2="0"/><text class="pinlabel" x="95" y="-9" text-anchor="end">OUT</text>`
      + `<line x1="60" y1="40" x2="60" y2="20"/><text class="pinlabel" x="60" y="16" text-anchor="middle">GND</text>`;
  },
};
