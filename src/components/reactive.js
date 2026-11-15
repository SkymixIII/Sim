// Composants réactifs : condensateur et bobine. Ils n'existent que dans le temps :
// en continu, un condensateur est un circuit ouvert et une bobine un simple fil résistif.
import { fmt } from "../engine/units.js";
import { OPEN_G } from "../engine/devices.js";
import { lead } from "./shapes.js";

export const capacitor = {
  type: "capacitor",
  name: "Condensateur",
  category: "Passifs",
  summary: "Condensateur céramique/film ou électrolytique polarisé, avec tension de service.",
  reactive: true,
  pins: [{ id: "1", label: "+", x: 0, y: 0 }, { id: "2", label: "−", x: 4, y: 0 }],
  bounds: { x: 0, y: -0.8, w: 4, h: 1.6 },
  rotatable: true,
  params: [
    { key: "C", label: "Capacité", kind: "number", unit: "F", default: 100e-9, min: 1e-13 },
    { key: "Vmax", label: "Tension de service", kind: "select", unit: "V", default: 50,
      options: [6.3, 10, 16, 25, 35, 50, 100, 400].map((v) => ({ value: v, label: `${String(v).replace(".", ",")} V` })) },
    { key: "polar", label: "Électrolytique polarisé (+ à gauche)", kind: "bool", default: false },
  ],
  datasheet: {
    source: "Condensateur idéal i = C·dv/dt. Céramique X7R / film (ex. Kemet C315) ou électrolytique aluminium (ex. Panasonic série FR).",
    notes: [
      "Tension de service : au-delà, le diélectrique vieillit ; à 1,5× on considère qu'il claque.",
      "Électrolytique : une tension inverse de plus de 1 V environ le détruit (dégagement gazeux). Panasonic autorise au plus ~1 V inverse.",
      "Non modélisé : résistance série (ESR), courant de fuite, dérive de capacité des céramiques avec la tension.",
    ],
  },
  stamp(ctx, inst, [a, b]) {
    if (!ctx.dt) { ctx.conductance(a, b, OPEN_G); return; }
    const s = inst.rt?.s ?? { v: 0, i: 0 };
    const g = (ctx.trap ? 2 : 1) * inst.params.C / ctx.dt;
    ctx.conductance(a, b, g);
    ctx.current(a, b, -g * s.v - (ctx.trap ? s.i : 0));
  },
  evaluate(ctx, inst, [a, b]) {
    const V = ctx.v(a) - ctx.v(b);
    let I = 0;
    if (ctx.dt) {
      const s = inst.rt?.s ?? { v: 0, i: 0 };
      I = (ctx.trap ? 2 : 1) * inst.params.C / ctx.dt * (V - s.v) - (ctx.trap ? s.i : 0);
    }
    return { V, I, Vmin: V };
  },
  commit(ctx, inst, nodes) {
    const { V, I } = this.evaluate(ctx, inst, nodes);
    (inst.rt ??= {}).s = { v: V, i: I };
  },
  describe(inst, avg, peak) {
    const { C, Vmax, polar } = inst.params;
    const warnings = [];
    let damage;
    const vpk = Math.max(Math.abs(peak.V ?? 0), Math.abs(peak.Vmin ?? 0));
    if (vpk > 1.5 * Vmax) damage = `Claqué : ${fmt(vpk, "V")} pour une tension de service de ${fmt(Vmax, "V")}.`;
    else if (vpk > Vmax) warnings.push({ level: "danger", text: `${fmt(vpk, "V")} dépasse la tension de service (${fmt(Vmax, "V")}).` });
    if (polar && avg.V < -1.5) damage = `Électrolytique monté à l'envers (${fmt(avg.V, "V")}) : il a éclaté.`;
    else if (polar && peak.Vmin < -1) warnings.push({ level: "danger", text: `Tension inverse ${fmt(peak.Vmin, "V")} sur un électrolytique : il va gonfler puis éclater.` });
    return {
      readings: [["Tension", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")], ["Charge", fmt(C * avg.V, "C")], ["Énergie stockée", fmt(0.5 * C * avg.V * avg.V, "J")]],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(avg.V, "V"),
  label: (inst) => fmt(inst.params.C, "F"),
  symbol: (inst) => `${lead(0, 35)}<line class="thick3" x1="35" y1="-12" x2="35" y2="12"/>`
    + (inst.params.polar ? `<path d="M49,-12 Q41,0 49,12"/><text class="pm" x="20" y="-6">+</text>` : `<line class="thick3" x1="45" y1="-12" x2="45" y2="12"/>`)
    + lead(45, 80),
};

export const inductor = {
  type: "inductor",
  name: "Bobine",
  category: "Passifs",
  summary: "Inductance avec sa résistance de bobinage et son courant nominal.",
  reactive: true,
  pins: [{ id: "1", x: 0, y: 0 }, { id: "2", x: 4, y: 0 }],
  bounds: { x: 0, y: -0.8, w: 4, h: 1.4 },
  rotatable: true,
  params: [
    { key: "L", label: "Inductance", kind: "number", unit: "H", default: 10e-3, min: 1e-10 },
    { key: "R", label: "Résistance du bobinage", kind: "number", unit: "Ω", default: 10, min: 1e-4 },
    { key: "Imax", label: "Courant nominal", kind: "number", unit: "A", default: 0.3, min: 1e-6 },
  ],
  datasheet: {
    source: "Inductance série L + R : v = R·i + L·di/dt. Valeurs par défaut d'une self radiale 10 mH (ex. Würth WE-TI 7447720103 : ~10 Ω, ~0,3 A).",
    notes: [
      "Couper brutalement le courant d'une bobine crée une surtension : prévoir une diode de roue libre.",
      "Non modélisé : saturation du noyau (au-delà du courant nominal l'inductance réelle s'effondre), capacité parasite.",
    ],
  },
  stamp(ctx, inst, [a, b]) {
    const { L, R } = inst.params;
    if (!ctx.dt) { ctx.conductance(a, b, 1 / R); return; }
    const s = inst.rt?.s ?? { v: 0, i: 0 };
    if (ctx.trap) {
      const g = 1 / (R + 2 * L / ctx.dt);
      ctx.conductance(a, b, g);
      ctx.current(a, b, g * (s.v + (2 * L / ctx.dt - R) * s.i));
    } else {
      const g = 1 / (R + L / ctx.dt);
      ctx.conductance(a, b, g);
      ctx.current(a, b, g * (L / ctx.dt) * s.i);
    }
  },
  evaluate(ctx, inst, [a, b]) {
    const { L, R } = inst.params;
    const V = ctx.v(a) - ctx.v(b);
    let I;
    if (!ctx.dt) I = V / R;
    else {
      const s = inst.rt?.s ?? { v: 0, i: 0 };
      I = ctx.trap ? (V + s.v + (2 * L / ctx.dt - R) * s.i) / (R + 2 * L / ctx.dt) : (V + (L / ctx.dt) * s.i) / (R + L / ctx.dt);
    }
    return { V, I, P: R * I * I };
  },
  commit(ctx, inst, nodes) {
    const { V, I } = this.evaluate(ctx, inst, nodes);
    (inst.rt ??= {}).s = { v: V, i: I };
  },
  describe(inst, avg, peak) {
    const { L, Imax } = inst.params;
    const warnings = [];
    if (Math.abs(peak.I) > Imax) warnings.push({ level: "warn", text: `Courant ${fmt(Math.abs(peak.I), "A")} au-delà du courant nominal (${fmt(Imax, "A")}) : le noyau sature et le fil chauffe.` });
    return {
      readings: [["Tension", fmt(avg.V, "V")], ["Courant", fmt(avg.I, "A")], ["Énergie stockée", fmt(0.5 * L * avg.I * avg.I, "J")], ["Pertes cuivre", fmt(avg.P, "W")]],
      warnings,
    };
  },
  reading: (inst, avg) => fmt(avg.I, "A"),
  label: (inst) => fmt(inst.params.L, "H"),
  symbol: () => `${lead(0, 16)}<path d="M16,0 a6,7 0 0 1 12,0 a6,7 0 0 1 12,0 a6,7 0 0 1 12,0 a6,7 0 0 1 12,0"/>${lead(64, 80)}`,
};
