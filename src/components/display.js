// Afficheur 7 segments à LED.
import { fmt } from "../engine/units.js";
import { stampJunction, junctionIG, fitIsFromVf } from "../engine/devices.js";

const SEGS = ["a", "b", "c", "d", "e", "f", "g", "dp"];
const COLORS = {
  red: { label: "Rouge", color: "#ff2a1a", vf: 2.0, n: 2.0, Rs: 8 },
  green: { label: "Vert", color: "#22e04a", vf: 2.2, n: 2.0, Rs: 10 },
  blue: { label: "Bleu", color: "#2f6bff", vf: 3.2, n: 3.2, Rs: 12 },
};
const IF = 0.02, IFMAX = 0.03, IFPEAK = 0.15;
const params = (c) => ({ ...COLORS[c], Is: fitIsFromVf(COLORS[c].vf, IF, COLORS[c].n, COLORS[c].Rs), BV: 25, Ibv: 1e-5, nbv: 2 });

// Géométrie des segments (px) dans un chiffre de 44 × 76.
const SEG_SHAPE = {
  a: "8,0 36,0 31,6 13,6", b: "38,2 44,7 44,34 38,37 33,32 33,8", c: "38,39 44,42 44,69 38,74 33,68 33,44",
  d: "8,76 36,76 31,70 13,70", e: "6,39 0,42 0,69 6,74 11,68 11,44", f: "6,2 0,7 0,34 6,37 11,32 11,8", g: "8,38 13,34 31,34 36,38 31,42 13,42",
};

export const sevenSeg = {
  type: "sevenseg",
  name: "Afficheur 7 segments",
  category: "Optoélectronique",
  summary: "Sept LED en forme de 8 plus un point, à cathode ou anode commune. Une résistance par segment.",
  pins: [...SEGS.map((id, i) => ({ id, label: `Segment ${id}`, x: 0, y: i })), { id: "COM", label: "Commun", x: 3, y: 9 }],
  bounds: { x: 1, y: -0.8, w: 4.4, h: 8.8 },
  rotatable: false,
  params: [
    { key: "color", label: "Couleur", kind: "select", default: "red", options: Object.entries(COLORS).map(([value, c]) => ({ value, label: c.label })) },
    { key: "common", label: "Montage", kind: "select", default: "cathode", options: [{ value: "cathode", label: "Cathode commune (COM à la masse)" }, { value: "anode", label: "Anode commune (COM au +)" }] },
  ],
  datasheet: {
    source: "Afficheur 14,2 mm (0,56\") type Kingbright SC56-11 / SA56-11 : VF 2,0 V typ. à 20 mA par segment (rouge), 30 mA max en continu, 150 mA en crête, VR 5 V.",
    notes: ["Chaque segment est une LED : sans résistance série (220 Ω à 1 kΩ sous 5 V), il grille.", "Cathode commune : COM à la masse, un niveau haut allume le segment (74HC4511). Anode commune : COM au +, un niveau bas l'allume."],
  },
  internalNodes: () => 8,
  stamp(ctx, inst, nodes, br, state) {
    const p = params(inst.params.color), com = nodes[8], ca = inst.params.common === "anode";
    for (let i = 0; i < 8; i++) {
      const pin = nodes[i], mid = nodes[9 + i];
      ctx.conductance(pin, mid, 1 / p.Rs);
      if (ca) stampJunction(ctx, state, `d${i}`, com, mid, p); else stampJunction(ctx, state, `d${i}`, mid, com, p);
    }
  },
  evaluate(ctx, inst, nodes) {
    const p = params(inst.params.color), com = nodes[8], ca = inst.params.common === "anode";
    const r = { Itot: 0, Imax: 0, Vminr: 0 };
    for (let i = 0; i < 8; i++) {
      const vj = ca ? ctx.v(com) - ctx.v(nodes[9 + i]) : ctx.v(nodes[9 + i]) - ctx.v(com);
      const I = junctionIG(vj, p, ctx.tempC).I;
      r[`I${SEGS[i]}`] = I;
      r.Itot += I; r.Imax = Math.max(r.Imax, I);
      r.Vminr = Math.min(r.Vminr, ca ? ctx.v(com) - ctx.v(nodes[i]) : ctx.v(nodes[i]) - ctx.v(com));
    }
    return r;
  },
  describe(inst, avg, peak) {
    const warnings = [];
    let damage;
    if (avg.Imax > IFPEAK) damage = `Segment grillé : ${fmt(avg.Imax, "A")} en continu (30 mA max). Ajoutez une résistance par segment.`;
    else if (avg.Imax > IFMAX) warnings.push({ level: "danger", text: `Un segment reçoit ${fmt(avg.Imax, "A")} : au-delà de 30 mA en continu.` });
    if (peak.Vminr < -5) warnings.push({ level: "danger", text: `Tension inverse ${fmt(-peak.Vminr, "V")} > 5 V sur un segment.` });
    return {
      readings: [["Courant total", fmt(avg.Itot, "A")], ...SEGS.map((s) => [`Segment ${s}`, avg[`I${s}`] > 1e-4 ? fmt(avg[`I${s}`], "A") : "éteint"])],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(avg.Itot, "A"),
  label: () => "",
  symbol(inst, avg) {
    const c = COLORS[inst.params.color].color;
    const glow = (id) => (inst.damaged || !avg ? 0 : Math.min(1, Math.sqrt(Math.max(0, avg[`I${id}`] ?? 0) / 0.01)));
    let s = `<rect class="ic" x="20" y="-16" width="88" height="176" rx="5"/>`;
    SEGS.forEach((id, i) => { s += `<line x1="0" y1="${i * 20}" x2="20" y2="${i * 20}"/><text class="pinlabel" x="25" y="${i * 20 + 3}">${id}</text>`; });
    s += `<line x1="60" y1="180" x2="60" y2="160"/><text class="pinlabel" x="60" y="155" text-anchor="middle">COM</text>`;
    s += `<g transform="translate(46,22) skewX(-6)">`;
    for (const id of Object.keys(SEG_SHAPE)) s += `<polygon class="seg" points="${SEG_SHAPE[id]}" style="fill:${c};fill-opacity:${(0.08 + 0.92 * glow(id)).toFixed(3)}"/>`;
    s += `<circle class="seg" cx="53" cy="73" r="4" style="fill:${c};fill-opacity:${(0.08 + 0.92 * glow("dp")).toFixed(3)}"/></g>`;
    return s;
  },
};
