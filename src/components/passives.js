// Composants passifs : résistance, potentiomètre, interrupteur, bouton poussoir, masse.
import { fmt } from "../engine/units.js";
import { OPEN_G } from "../engine/devices.js";

const lead = (x1, x2) => `<line x1="${x1}" y1="0" x2="${x2}" y2="0"/>`;

export const ground = {
  type: "ground",
  name: "Masse",
  category: "Alimentation",
  summary: "Référence 0 V du circuit.",
  isGround: true,
  pins: [{ id: "G", label: "GND", x: 0, y: 0 }],
  bounds: { x: -1, y: 0, w: 2, h: 1.2 },
  rotatable: false,
  params: [],
  stamp() {},
  evaluate: () => ({}),
  describe: () => ({ readings: [], warnings: [] }),
  symbol: () => `<line x1="0" y1="0" x2="0" y2="10"/><line x1="-12" y1="10" x2="12" y2="10"/><line x1="-7" y1="15" x2="7" y2="15"/><line x1="-2" y1="20" x2="2" y2="20"/>`,
};

export const resistor = {
  type: "resistor",
  name: "Résistance",
  category: "Passifs",
  summary: "Résistance à couche carbone/métal, avec puissance nominale.",
  pins: [{ id: "1", x: 0, y: 0 }, { id: "2", x: 4, y: 0 }],
  bounds: { x: 0, y: -0.6, w: 4, h: 1.2 },
  rotatable: true,
  params: [
    { key: "R", label: "Résistance", kind: "number", unit: "Ω", default: 220, min: 0.01 },
    { key: "Pmax", label: "Puissance nominale", kind: "select", unit: "W", default: 0.25,
      options: [{ value: 0.125, label: "1/8 W" }, { value: 0.25, label: "1/4 W" }, { value: 0.5, label: "1/2 W" }, { value: 1, label: "1 W" }, { value: 2, label: "2 W" }] },
  ],
  datasheet: {
    source: "Résistances traversantes standard (ex. Yageo MFR/CFR series) : 1/4 W à 70 °C, tolérance 1 à 5 %.",
    notes: ["Au-delà de la puissance nominale, la résistance chauffe. À plus de 2× la puissance nominale en continu, on la considère brûlée (circuit ouvert)."],
  },
  stamp(ctx, inst, [a, b]) { ctx.conductance(a, b, 1 / Math.max(inst.params.R, 1e-6)); },
  evaluate(ctx, inst, [a, b]) {
    const V = ctx.v(a) - ctx.v(b);
    const I = V / inst.params.R;
    return { V, I, P: V * I };
  },
  describe(inst, avg, peak) {
    const { Pmax } = inst.params;
    const warnings = [];
    let damage;
    if (avg.P > 2 * Pmax) damage = `Brûlée : ${fmt(avg.P, "W")} dissipés pour ${fmt(Pmax, "W")} nominal.`;
    else if (avg.P > Pmax) warnings.push({ level: "danger", text: `Surchauffe : ${fmt(avg.P, "W")} > ${fmt(Pmax, "W")} nominal.` });
    else if (avg.P > 0.7 * Pmax) warnings.push({ level: "warn", text: `Proche de sa limite (${Math.round(100 * avg.P / Pmax)} % de la puissance nominale).` });
    return {
      readings: [["Tension", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")], ["Puissance", fmt(avg.P, "W")]],
      warnings, damage,
    };
  },
  label: (inst) => fmt(inst.params.R, "Ω"),
  symbol: () => `${lead(0, 22)}<rect x="22" y="-7" width="36" height="14" rx="1"/>${lead(58, 80)}`,
};

export const potentiometer = {
  type: "potentiometer",
  name: "Potentiomètre",
  category: "Passifs",
  summary: "Résistance variable à 3 broches (A, curseur W, B).",
  pins: [{ id: "A", x: 0, y: 0 }, { id: "B", x: 4, y: 0 }, { id: "W", label: "W", x: 2, y: 2 }],
  bounds: { x: 0, y: -0.6, w: 4, h: 2.6 },
  rotatable: true,
  params: [
    { key: "R", label: "Résistance totale", kind: "number", unit: "Ω", default: 10000, min: 1 },
    { key: "pos", label: "Position du curseur", kind: "range", default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: "Pmax", label: "Puissance nominale", kind: "select", unit: "W", default: 0.2,
      options: [{ value: 0.1, label: "0,1 W" }, { value: 0.2, label: "0,2 W" }, { value: 0.5, label: "0,5 W" }] },
  ],
  datasheet: {
    source: "Potentiomètre rotatif carbone (ex. Bourns PTV09) : 0,05 W à 0,2 W, résistance de fin de course ≤ 20 Ω.",
    notes: ["Résistance résiduelle minimale de 1 Ω entre curseur et extrémités."],
  },
  stamp(ctx, inst, [a, b, w]) {
    const { R, pos } = inst.params;
    ctx.conductance(a, w, 1 / Math.max(pos * R, 1));
    ctx.conductance(w, b, 1 / Math.max((1 - pos) * R, 1));
  },
  evaluate(ctx, inst, [a, b, w]) {
    const { R, pos } = inst.params;
    const Raw = Math.max(pos * R, 1), Rwb = Math.max((1 - pos) * R, 1);
    const Vaw = ctx.v(a) - ctx.v(w), Vwb = ctx.v(w) - ctx.v(b);
    return { V: ctx.v(a) - ctx.v(b), Vw: ctx.v(w), Iaw: Vaw / Raw, Iwb: Vwb / Rwb, P: Vaw * Vaw / Raw + Vwb * Vwb / Rwb };
  },
  describe(inst, avg) {
    const warnings = [];
    if (avg.P > inst.params.Pmax) warnings.push({ level: "danger", text: `Surchauffe : ${fmt(avg.P, "W")} > ${fmt(inst.params.Pmax, "W")}.` });
    return {
      readings: [["Position", `${Math.round(inst.params.pos * 100)} %`], ["Tension A–B", fmt(avg.V, "V")], ["Courant A→W", fmt(avg.Iaw, "A")], ["Puissance", fmt(avg.P, "W")]],
      warnings,
    };
  },
  label: (inst) => fmt(inst.params.R, "Ω"),
  symbol: (inst) => {
    const x = 22 + 36 * inst.params.pos;
    return `${lead(0, 22)}<rect x="22" y="-7" width="36" height="14" rx="1"/>${lead(58, 80)}<polyline points="40,40 40,24 ${x},24 ${x},10"/><polygon class="fill" points="${x - 4},14 ${x + 4},14 ${x},8"/>`;
  },
};

function switchDef({ type, name, momentary }) {
  return {
    type, name,
    category: "Commandes",
    summary: momentary ? "Bouton poussoir : fermé tant qu'on appuie dessus." : "Interrupteur à bascule : cliquez pour l'ouvrir ou le fermer.",
    pins: [{ id: "1", x: 0, y: 0 }, { id: "2", x: 4, y: 0 }],
    bounds: { x: 0, y: -1.2, w: 4, h: 1.8 },
    rotatable: true,
    interactive: true,
    params: momentary ? [] : [{ key: "closed", label: "Fermé", kind: "bool", default: false }],
    datasheet: {
      source: momentary ? "Bouton tactile 6×6 mm (ex. Omron B3F) : résistance de contact ≤ 100 mΩ, isolement ≥ 100 MΩ." : "Interrupteur à glissière (ex. C&K OS102011) : résistance de contact ≤ 30 mΩ.",
      notes: ["Les rebonds mécaniques ne sont pas encore simulés (analyse DC)."],
    },
    isClosed: (inst) => (momentary ? !!inst.rt?.pressed : !!inst.params.closed),
    stamp(ctx, inst, [a, b]) { ctx.conductance(a, b, this.isClosed(inst) ? 1 / (momentary ? 0.1 : 0.03) : OPEN_G); },
    evaluate(ctx, inst, [a, b]) {
      const V = ctx.v(a) - ctx.v(b);
      return { V, I: V * (this.isClosed(inst) ? 1 / (momentary ? 0.1 : 0.03) : OPEN_G), closed: this.isClosed(inst) ? 1 : 0 };
    },
    describe(inst, avg) {
      const warnings = [];
      if (Math.abs(avg.I) > (momentary ? 0.05 : 0.5)) warnings.push({ level: "danger", text: `Courant ${fmt(avg.I, "A")} au-delà du calibre des contacts (${momentary ? "50 mA" : "500 mA"}).` });
      return { readings: [["État", this.isClosed(inst) ? "fermé" : "ouvert"], ["Tension", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")]], warnings };
    },
    press(inst, down) {
      if (momentary) { inst.rt = { ...inst.rt, pressed: down }; return true; }
      if (down) { inst.params.closed = !inst.params.closed; return true; }
      return false;
    },
    symbol(inst) {
      const c = this.isClosed(inst);
      const blade = c ? `<line x1="22" y1="0" x2="58" y2="0"/>` : `<line x1="22" y1="0" x2="56" y2="-14"/>`;
      const cap = momentary ? `<line x1="40" y1="${c ? -2 : -9}" x2="40" y2="-22"/><line x1="32" y1="-22" x2="48" y2="-22"/>` : "";
      return `${lead(0, 22)}<circle class="fill" cx="22" cy="0" r="2.5"/><circle class="fill" cx="58" cy="0" r="2.5"/>${lead(58, 80)}${momentary ? `<line x1="22" y1="${c ? 0 : -9}" x2="58" y2="${c ? 0 : -9}"/>` : blade}${cap}`;
    },
  };
}

export const toggleSwitch = switchDef({ type: "switch", name: "Interrupteur", momentary: false });
export const pushButton = switchDef({ type: "button", name: "Bouton poussoir", momentary: true });
