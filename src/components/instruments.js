// Instruments de mesure et de test : voltmètre, ampèremètre, multimètre, sonde d'oscilloscope,
// générateur de fonctions. Ils ont l'impédance des vrais appareils : ils perturbent (un peu) le circuit.
import { fmt } from "../engine/units.js";
import { OPEN_G } from "../engine/devices.js";
import { lead } from "./shapes.js";

export const SCOPE_COLORS = ["#e6a700", "#1fa2ff", "#e0409a", "#2fbf71"];
const CH_OPTIONS = [{ value: 0, label: "Non affiché" }, ...[1, 2, 3, 4].map((n) => ({ value: n, label: `Voie ${n} (CH${n})` }))];
const chParam = (def = 0) => ({ key: "ch", label: "Oscilloscope", kind: "select", default: def, options: CH_OPTIONS });
const chTag = (inst, x, y) => (inst.params.ch ? `<text class="chtag" x="${x}" y="${y}" style="fill:${SCOPE_COLORS[inst.params.ch - 1]}">CH${inst.params.ch}</text>` : "");
const rms = (mean2) => Math.sqrt(Math.max(0, mean2));
const acRms = (mean, mean2) => Math.sqrt(Math.max(0, mean2 - mean * mean));

const R_VOLT = 10e6;   // impédance d'entrée d'un multimètre numérique en voltmètre
const R_SHUNT = 0.1;   // shunt + fusible du calibre ampèremètre
const I_FUSE = 10;     // fusible 10 A

const meterSymbol = (letter, inst) => `${lead(0, 24)}<circle class="meter" cx="40" cy="0" r="16"/><text class="meter-letter" x="40" y="5">${letter}</text>${lead(56, 80)}<text class="pm" x="6" y="-8">+</text>${chTag(inst, 40, 30)}`;

export const voltmeter = {
  type: "voltmeter",
  name: "Voltmètre",
  category: "Instruments",
  summary: "Mesure la tension entre ses deux bornes (se branche en parallèle). Impédance 10 MΩ.",
  instrument: "V",
  pins: [{ id: "V", label: "+ (rouge)", x: 0, y: 0 }, { id: "COM", label: "COM (noir)", x: 4, y: 0 }],
  bounds: { x: 0, y: -1, w: 4, h: 2 },
  rotatable: true,
  params: [
    { key: "mode", label: "Mesure", kind: "select", default: "dc", options: [{ value: "dc", label: "Continu (moyenne)" }, { value: "ac", label: "Alternatif (efficace, sans la composante continue)" }, { value: "rms", label: "Efficace vrai (AC + DC)" }] },
    chParam(),
  ],
  datasheet: { source: "Voltmètre numérique : résistance d'entrée 10 MΩ (valeur standard, ex. Fluke 117).", notes: ["Sur un point à haute impédance (pont de résistances de plusieurs MΩ), les 10 MΩ de l'appareil faussent la mesure, comme en vrai.", "Choisissez une voie pour tracer cette tension (différentielle) sur l'oscilloscope."] },
  stamp(ctx, inst, [a, b]) { ctx.conductance(a, b, 1 / R_VOLT); },
  evaluate(ctx, inst, [a, b]) { const V = ctx.v(a) - ctx.v(b); return { V, V2: V * V }; },
  value(inst, avg) { const m = inst.params.mode; return m === "ac" ? acRms(avg.V, avg.V2) : m === "rms" ? rms(avg.V2) : avg.V; },
  describe(inst, avg, peak) {
    return {
      readings: [["Affichage", `${fmt(this.value(inst, avg), "V")}${inst.params.mode === "dc" ? "" : " eff."}`], ["Moyenne", fmt(avg.V, "V")], ["Efficace vrai", fmt(rms(avg.V2), "V")], ["Crête récente", fmt(peak.V, "V")]],
      warnings: Math.abs(peak.V) > 1000 ? [{ level: "danger", text: "Plus de 1000 V : au-delà de la catégorie de l'appareil." }] : [],
    };
  },
  reading(inst, avg) { return `${fmt(this.value(inst, avg), "V")}${inst.params.mode === "dc" ? "" : " eff"}`; },
  label: () => "",
  symbol: (inst) => meterSymbol("V", inst),
};

export const ammeter = {
  type: "ammeter",
  name: "Ampèremètre",
  category: "Instruments",
  summary: "Mesure le courant qui le traverse (se branche en série). Shunt 0,1 Ω, fusible 10 A.",
  instrument: "I",
  pins: [{ id: "A", label: "+ (entrée du courant)", x: 0, y: 0 }, { id: "COM", label: "COM", x: 4, y: 0 }],
  bounds: { x: 0, y: -1, w: 4, h: 2 },
  rotatable: true,
  params: [
    { key: "mode", label: "Mesure", kind: "select", default: "dc", options: [{ value: "dc", label: "Continu (moyenne)" }, { value: "ac", label: "Alternatif (efficace, sans la composante continue)" }, { value: "rms", label: "Efficace vrai (AC + DC)" }] },
    chParam(),
  ],
  datasheet: { source: "Calibre ampèremètre d'un multimètre : chute d'environ 0,1 V par ampère (shunt + fusible), fusible 10 A.", notes: ["Branché en parallèle sur une source, il la court-circuite : le fusible saute, comme en vrai."] },
  stamp(ctx, inst, [a, b]) { ctx.conductance(a, b, 1 / R_SHUNT); },
  evaluate(ctx, inst, [a, b]) { const V = ctx.v(a) - ctx.v(b); const I = V / R_SHUNT; return { V, I, I2: I * I }; },
  value(inst, avg) { const m = inst.params.mode; return m === "ac" ? acRms(avg.I, avg.I2) : m === "rms" ? rms(avg.I2) : avg.I; },
  describe(inst, avg, peak) {
    const Irms = rms(avg.I2);
    return {
      readings: [["Affichage", `${fmt(this.value(inst, avg), "A")}${inst.params.mode === "dc" ? "" : " eff."}`], ["Moyenne", fmt(avg.I, "A")], ["Efficace vrai", fmt(Irms, "A")], ["Chute dans l'appareil", fmt(avg.V, "V")]],
      warnings: [],
      damage: Irms > I_FUSE ? `Fusible 10 A grillé (${fmt(Irms, "A")}). Un ampèremètre se branche en série, jamais aux bornes d'une source.` : undefined,
    };
  },
  reading(inst, avg) { return `${fmt(this.value(inst, avg), "A")}${inst.params.mode === "dc" ? "" : " eff"}`; },
  label: () => "",
  symbol: (inst) => meterSymbol("A", inst),
};

// Multimètre : un seul appareil, sélecteur de fonction.
const DMM_MODES = {
  vdc: { label: "V⎓  tension continue", unit: "V" },
  vac: { label: "V~  tension alternative (efficace)", unit: "V" },
  adc: { label: "A⎓  courant continu", unit: "A" },
  aac: { label: "A~  courant alternatif (efficace)", unit: "A" },
  ohm: { label: "Ω  résistance", unit: "Ω" },
  diode: { label: "Test de diode / continuité", unit: "V" },
};
const OHM = { V: 0.5, R: 1e3 };    // source de mesure en ohmmètre : 0,5 V à vide derrière 1 kΩ
const DIODE = { V: 3.0, R: 3e3 };  // test de diode : ~3 V à vide, ~1 mA

function dmmDisplay(inst, avg) {
  switch (inst.params.mode) {
    case "vdc": return fmt(avg.V, "V", 4);
    case "vac": return `${fmt(acRms(avg.V, avg.V2), "V", 4)} ~`;
    case "adc": return fmt(avg.I, "A", 4);
    case "aac": return `${fmt(acRms(avg.I, avg.I2), "A", 4)} ~`;
    case "ohm": {
      if (avg.V >= OHM.V * 0.99995 || avg.V < -1e-6) return "O.L";
      const R = Math.max(0, avg.V) * OHM.R / (OHM.V - avg.V);
      return R > 40e6 ? "O.L" : fmt(R, "Ω", 4);
    }
    default: return avg.V > DIODE.V * 0.95 ? "O.L" : avg.V < 0.05 ? `${fmt(avg.V, "V", 3)} bip` : fmt(avg.V, "V", 4);
  }
}

export const multimeter = {
  type: "multimeter",
  name: "Multimètre",
  category: "Instruments",
  summary: "Multimètre numérique : tension, courant, résistance, test de diode et de continuité.",
  instrument: "V",
  pins: [{ id: "V", label: "VΩmA (rouge)", x: 0, y: 0 }, { id: "COM", label: "COM (noir)", x: 0, y: 2 }],
  bounds: { x: 1, y: -1, w: 6, h: 4 },
  rotatable: false,
  params: [
    { key: "mode", label: "Fonction", kind: "select", default: "vdc", options: Object.entries(DMM_MODES).map(([value, m]) => ({ value, label: m.label })) },
    chParam(),
  ],
  datasheet: {
    source: "Multimètre numérique générique 6000 points (ordre de grandeur Fluke 117 / UNI-T UT61E).",
    notes: [
      "Voltmètre : 10 MΩ d'impédance d'entrée. Ampèremètre : shunt 0,1 Ω et fusible 10 A.",
      "Ohmmètre : l'appareil injecte un petit courant (0,5 V à vide derrière 1 kΩ) et mesure la tension. Sur un circuit sous tension, la lecture est fausse, comme en vrai.",
      "Test de diode : ~1 mA sous 3 V à vide, affiche la tension directe de la jonction. En dessous de 50 mV : continuité (bip).",
    ],
  },
  internalNodes: () => 0,
  stamp(ctx, inst, [a, b]) {
    const m = inst.params.mode;
    if (m === "adc" || m === "aac") ctx.conductance(a, b, 1 / R_SHUNT);
    else if (m === "ohm" || m === "diode") {
      const s = m === "ohm" ? OHM : DIODE;
      ctx.conductance(a, b, 1 / s.R);
      ctx.current(b, a, (s.V / s.R) * ctx.srcFactor);
    } else ctx.conductance(a, b, 1 / R_VOLT);
  },
  evaluate(ctx, inst, [a, b]) {
    const V = ctx.v(a) - ctx.v(b);
    const m = inst.params.mode;
    const I = m === "adc" || m === "aac" ? V / R_SHUNT : m === "ohm" ? (V - OHM.V) / OHM.R : m === "diode" ? (V - DIODE.V) / DIODE.R : V / R_VOLT;
    return { V, V2: V * V, I, I2: I * I };
  },
  scopeKey: (inst) => (inst.params.mode === "adc" || inst.params.mode === "aac" ? "I" : "V"),
  describe(inst, avg, peak) {
    const amp = inst.params.mode === "adc" || inst.params.mode === "aac";
    const Irms = rms(avg.I2);
    return {
      readings: [["Affichage", dmmDisplay(inst, avg)], ["Tension aux bornes", fmt(avg.V, "V")], ["Courant dans l'appareil", fmt(avg.I, "A")]],
      warnings: [],
      damage: amp && Irms > I_FUSE ? `Fusible 10 A grillé (${fmt(Irms, "A")}) : multimètre en position ampèremètre branché sur une source de tension.` : undefined,
    };
  },
  label: () => "",
  symbol(inst, avg) {
    const m = DMM_MODES[inst.params.mode];
    const txt = inst.damaged ? "FUSE" : avg ? dmmDisplay(inst, avg) : "0.000";
    return `<line x1="0" y1="0" x2="20" y2="0"/><line x1="0" y1="40" x2="20" y2="40"/>`
      + `<rect class="dmm" x="20" y="-20" width="120" height="80" rx="8"/>`
      + `<rect class="lcd" x="30" y="-12" width="100" height="34" rx="3"/><text class="lcd-text" x="124" y="12">${txt}</text>`
      + `<circle class="jack red" cx="28" cy="0" r="3"/><circle class="jack" cx="28" cy="40" r="3"/>`
      + `<text class="dmm-mode" x="80" y="42">${m.label.split("  ")[0]}</text><circle class="dial" cx="118" cy="40" r="11"/><line class="dial-mark" x1="118" y1="40" x2="${118 + 9 * Math.cos(Object.keys(DMM_MODES).indexOf(inst.params.mode) - 2.2)}" y2="${40 + 9 * Math.sin(Object.keys(DMM_MODES).indexOf(inst.params.mode) - 2.2)}"/>`
      + chTag(inst, 46, 52);
  },
};

export const probe = {
  type: "probe",
  name: "Sonde d'oscilloscope",
  category: "Instruments",
  summary: "Trace la tension de ce point (par rapport à la masse) sur une voie de l'oscilloscope.",
  instrument: "V",
  pins: [{ id: "P", label: "Pointe de sonde", x: 0, y: 0 }],
  bounds: { x: -0.4, y: -2.4, w: 2.6, h: 2.6 },
  rotatable: false,
  params: [chParam(1)],
  datasheet: { source: "Sonde passive ×10 : 10 MΩ en parallèle sur le point mesuré (ex. Tektronix TPP0100).", notes: ["La référence est la masse du circuit. Pour une tension entre deux points quelconques, utilisez un voltmètre et attribuez-lui une voie.", "Non modélisé : capacité de la sonde (~12 pF)."] },
  stamp(ctx, inst, [a]) { ctx.conductance(a, 0, 1 / R_VOLT); },
  evaluate(ctx, inst, [a]) { const V = ctx.v(a); return { V, V2: V * V }; },
  describe: (inst, avg, peak) => ({ readings: [["Tension moyenne", fmt(avg.V, "V")], ["Efficace vrai", fmt(rms(avg.V2), "V")], ["Crête récente", fmt(peak.V, "V")]], warnings: [] }),
  label: () => "",
  symbol(inst) {
    const c = inst.params.ch ? SCOPE_COLORS[inst.params.ch - 1] : "var(--muted)";
    return `<line x1="0" y1="0" x2="12" y2="-12" style="stroke:${c}"/><rect x="9" y="-33" width="30" height="16" rx="8" transform="rotate(0)" style="fill:${c};stroke:${c}"/>`
      + `<text class="probe-text" x="24" y="-21">${inst.params.ch ? `CH${inst.params.ch}` : "—"}</text>`;
  },
};

// ---------- Générateur de fonctions ----------
const WAVES = {
  sine: "Sinus", square: "Carré", triangle: "Triangle", saw: "Dent de scie", clock: "Horloge logique (0 V → amplitude)", dc: "Continu (décalage seul)",
};
const frac = (x) => x - Math.floor(x);

export function waveValue(p, t) {
  if (t === undefined || p.wave === "dc") return p.wave === "clock" ? 0 : p.offset;
  const ph = frac(t * p.f);
  switch (p.wave) {
    case "sine": return p.offset + p.A * Math.sin(2 * Math.PI * ph);
    case "square": return p.offset + (ph < p.duty ? p.A : -p.A);
    case "clock": return ph < p.duty ? p.A : 0;
    case "triangle": return p.offset + p.A * (ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4);
    default: return p.offset + p.A * (2 * ph - 1);
  }
}

/** Prochain front d'un signal rectangulaire de fréquence f et de rapport cyclique duty, après t. */
export function nextEdge(t, f, duty) {
  const T = 1 / f, k = Math.floor(t * f), eps = T * 1e-9 + 2e-12;
  for (const c of [k * T, (k + duty) * T, (k + 1) * T, (k + 1 + duty) * T]) if (c > t + eps) return c;
  return (k + 2) * T;
}

const WAVE_ICON = {
  sine: "M28,0 q6,-16 12,0 t12,0", square: "M28,6 v-12 h12 v12 h12 v-12", clock: "M28,6 v-12 h12 v12 h12 v-12",
  triangle: "M28,0 l6,-8 l12,16 l6,-8", saw: "M28,6 l12,-12 v12 l12,-12 v12", dc: "M28,-3 h24",
};

export const funcgen = {
  type: "funcgen",
  name: "Générateur de fonctions",
  category: "Instruments",
  summary: "Générateur basse fréquence : sinus, carré, triangle, dent de scie, horloge. Sortie 50 Ω.",
  pins: [{ id: "+", label: "Sortie", x: 0, y: 0 }, { id: "-", label: "Masse du générateur", x: 4, y: 0 }],
  bounds: { x: 0, y: -1, w: 4, h: 2 },
  rotatable: true,
  params: [
    { key: "wave", label: "Forme d'onde", kind: "select", default: "sine", options: Object.entries(WAVES).map(([value, label]) => ({ value, label })) },
    { key: "f", label: "Fréquence", kind: "number", unit: "Hz", default: 1000, min: 1e-3 },
    { key: "A", label: "Amplitude crête", kind: "number", unit: "V", default: 1, min: 0 },
    { key: "offset", label: "Décalage continu", kind: "number", unit: "V", default: 0 },
    { key: "duty", label: "Rapport cyclique (carré, horloge)", kind: "range", default: 0.5, min: 0.01, max: 0.99, step: 0.01 },
  ],
  datasheet: {
    source: "Générateur de fonctions de laboratoire : impédance de sortie 50 Ω (ex. Rigol DG1022, Siglent SDG1032X).",
    notes: ["L'amplitude est celle à vide. Sur une charge de 50 Ω elle est divisée par deux, comme sur un vrai générateur.", "En mode Horloge, le signal va de 0 V à l'amplitude : pratique pour cadencer des circuits logiques.", "Fronts idéaux (temps de montée nul)."],
  },
  internalNodes: () => 1,
  branches: () => 1,
  stamp(ctx, inst, [p, n, x], [k]) {
    ctx.voltageSource(x, n, waveValue(inst.params, ctx.t) * ctx.srcFactor, k);
    ctx.conductance(x, p, 1 / 50);
  },
  evaluate(ctx, inst, [p, n], [k]) {
    const V = ctx.v(p) - ctx.v(n), I = -ctx.branchI(k);
    return { V, V2: V * V, I, P: V * I };
  },
  nextBreak(inst, t) {
    const { wave, f, duty } = inst.params;
    if (wave === "square" || wave === "clock") return nextEdge(t, f, duty);
    if (wave === "saw") return nextEdge(t, f, 1);
    return Infinity;
  },
  maxStep(inst) {
    const { wave, f } = inst.params;
    return wave === "sine" || wave === "triangle" || wave === "saw" ? 1 / (64 * f) : Infinity;
  },
  describe(inst, avg, peak) {
    return {
      readings: [["Tension de sortie (moyenne)", fmt(avg.V, "V")], ["Tension efficace", fmt(rms(avg.V2), "V")], ["Courant débité (moyen)", fmt(avg.I, "A")]],
      warnings: Math.abs(peak.I) > 0.2 ? [{ level: "warn", text: `Sortie très chargée (${fmt(Math.abs(peak.I), "A")}) : un générateur 50 Ω ne fournit que quelques dizaines de mA.` }] : [],
    };
  },
  label: (inst) => (inst.params.wave === "dc" ? fmt(inst.params.offset, "V") : `${fmt(inst.params.f, "Hz")} · ${fmt(inst.params.A, "V")}`),
  symbol: (inst) => `${lead(0, 24)}<circle cx="40" cy="0" r="16"/><path d="${WAVE_ICON[inst.params.wave]}"/>${lead(56, 80)}<text class="pm" x="6" y="-8">+</text>`,
};
