// Sources : alimentation DC, piles/batteries, source de courant.
import { fmt } from "../engine/units.js";

// Tension du + (broche 1) par rapport au − (broche 2).
const plusMinus = `<text class="pm" x="6" y="-8">+</text><text class="pm" x="70" y="-8">−</text>`;

export const dcSupply = {
  type: "dc",
  name: "Alimentation DC",
  category: "Alimentation",
  summary: "Source de tension idéale réglable (alimentation de laboratoire).",
  pins: [{ id: "+", x: 0, y: 0 }, { id: "-", x: 4, y: 0 }],
  bounds: { x: 0, y: -1, w: 4, h: 2 },
  rotatable: true,
  params: [{ key: "V", label: "Tension", kind: "number", unit: "V", default: 5 }],
  datasheet: { source: "Source idéale : résistance interne nulle, pas de limitation de courant.", notes: [] },
  branches: () => 1,
  stamp(ctx, inst, [p, n], [k]) { ctx.voltageSource(p, n, inst.params.V * ctx.srcFactor, k); },
  evaluate(ctx, inst, [p, n], [k]) {
    const I = -ctx.branchI(k); // courant débité par la borne +
    return { V: ctx.v(p) - ctx.v(n), I, P: (ctx.v(p) - ctx.v(n)) * I };
  },
  describe: (inst, avg) => ({
    readings: [["Tension", fmt(avg.V, "V")], ["Courant débité", fmt(avg.I, "A")], ["Puissance fournie", fmt(avg.P, "W")]],
    warnings: Math.abs(avg.I) > 5 ? [{ level: "danger", text: `Courant de ${fmt(avg.I, "A")} : court-circuit probable.` }] : [],
  }),
  label: (inst) => fmt(inst.params.V, "V"),
  symbol: () => `<line x1="0" y1="0" x2="24" y2="0"/><circle cx="40" cy="0" r="16"/><line x1="56" y1="0" x2="80" y2="0"/><line x1="30" y1="0" x2="36" y2="0"/><line x1="33" y1="-3" x2="33" y2="3"/><line x1="44" y1="0" x2="50" y2="0"/>${plusMinus}`,
};

// Valeurs typiques : tension à vide d'une cellule neuve et résistance interne (fiches Energizer/Duracell).
export const BATTERIES = {
  "9v": { label: "Pile 9 V alcaline (6LR61)", V: 9.0, R: 1.7, Imax: 0.5, ref: "Energizer 522 : 9 V nominal, ~1,7 Ω de résistance interne à 25 °C." },
  aa: { label: "Pile AA alcaline 1,5 V", V: 1.5, R: 0.15, Imax: 2, ref: "Energizer E91 : 1,5 V nominal, ~150 mΩ de résistance interne." },
  "2aa": { label: "2 × AA en série (3 V)", V: 3.0, R: 0.3, Imax: 2, ref: "2 × Energizer E91 en série." },
  "3aa": { label: "3 × AA en série (4,5 V)", V: 4.5, R: 0.45, Imax: 2, ref: "3 × Energizer E91 en série." },
  cr2032: { label: "Pile bouton CR2032 (3 V)", V: 3.0, R: 15, Imax: 0.003, ref: "Energizer CR2032 : 3 V, résistance interne 10 à 20 Ω, courant continu max ~3 mA." },
  lipo: { label: "Accu LiPo 1S 3,7 V", V: 3.7, R: 0.08, Imax: 1, ref: "Cellule LiPo 1000 mAh typique : 3,7 V nominal, ~80 mΩ." },
};

export const battery = {
  type: "battery",
  name: "Pile / batterie",
  category: "Alimentation",
  summary: "Pile réelle avec sa résistance interne : la tension chute quand elle débite.",
  pins: [{ id: "+", x: 0, y: 0 }, { id: "-", x: 4, y: 0 }],
  bounds: { x: 0, y: -1, w: 4, h: 2 },
  rotatable: true,
  params: [{ key: "kind", label: "Modèle", kind: "select", default: "9v", options: Object.entries(BATTERIES).map(([value, b]) => ({ value, label: b.label })) }],
  get datasheet() { return { source: "Modèle de Thévenin : f.é.m. en série avec la résistance interne.", notes: Object.values(BATTERIES).map((b) => b.ref) }; },
  internalNodes: () => 1,
  branches: () => 1,
  stamp(ctx, inst, [p, n, x], [k]) {
    const b = BATTERIES[inst.params.kind];
    ctx.voltageSource(x, n, b.V * ctx.srcFactor, k);
    ctx.conductance(x, p, 1 / b.R);
  },
  evaluate(ctx, inst, [p, n], [k]) {
    const I = -ctx.branchI(k);
    const V = ctx.v(p) - ctx.v(n);
    return { V, I, P: V * I };
  },
  describe(inst, avg) {
    const b = BATTERIES[inst.params.kind];
    const warnings = [];
    if (avg.I > b.Imax) warnings.push({ level: "danger", text: `Débite ${fmt(avg.I, "A")}, au-delà de ce qu'elle peut fournir durablement (${fmt(b.Imax, "A")}).` });
    return {
      readings: [["Tension aux bornes", fmt(avg.V, "V")], ["F.é.m. à vide", fmt(b.V, "V")], ["Chute interne", fmt(b.V - avg.V, "V")], ["Courant débité", fmt(avg.I, "A")]],
      warnings,
    };
  },
  label: (inst) => BATTERIES[inst.params.kind].label.replace(/ \(.*\)/, ""),
  symbol: () => `<line x1="0" y1="0" x2="34" y2="0"/><line x1="34" y1="-14" x2="34" y2="14"/><line class="thick" x1="44" y1="-7" x2="44" y2="7"/><line x1="44" y1="0" x2="80" y2="0"/>${plusMinus}`,
};

export const currentSource = {
  type: "isource",
  name: "Source de courant",
  category: "Alimentation",
  summary: "Source de courant idéale (le courant sort par la flèche).",
  pins: [{ id: "1", x: 0, y: 0 }, { id: "2", x: 4, y: 0 }],
  bounds: { x: 0, y: -1, w: 4, h: 2 },
  rotatable: true,
  params: [{ key: "I", label: "Courant", kind: "number", unit: "A", default: 0.01 }],
  datasheet: { source: "Source idéale, utile pour relever une caractéristique I-V.", notes: [] },
  // Le courant entre par la broche 1 et ressort par la broche 2 dans le circuit extérieur.
  stamp(ctx, inst, [a, b]) { ctx.current(a, b, inst.params.I * ctx.srcFactor); },
  evaluate: (ctx, inst, [a, b]) => ({ V: ctx.v(b) - ctx.v(a), I: inst.params.I }),
  describe: (inst, avg) => ({ readings: [["Courant", fmt(avg.I, "A")], ["Tension aux bornes", fmt(avg.V, "V")]], warnings: [] }),
  label: (inst) => fmt(inst.params.I, "A"),
  symbol: () => `<line x1="0" y1="0" x2="24" y2="0"/><circle cx="40" cy="0" r="16"/><line x1="56" y1="0" x2="80" y2="0"/><line x1="30" y1="0" x2="48" y2="0"/><polygon class="fill" points="50,0 43,-4 43,4"/>`,
};
