// Relais électromécanique.
import { fmt } from "../engine/units.js";
import { OPEN_G } from "../engine/devices.js";

const RELAYS = {
  "5": { label: "SRD-05VDC-SL-C (bobine 5 V)", Vn: 5, R: 70 },
  "12": { label: "SRD-12VDC-SL-C (bobine 12 V)", Vn: 12, R: 400 },
};
const R_CONTACT = 0.1, I_CONTACT = 10;

export const relay = {
  type: "relay",
  name: "Relais",
  category: "Commandes",
  summary: "Relais inverseur : la bobine alimentée fait basculer le contact de NC (repos) vers NO (travail).",
  pins: [{ id: "A1", label: "Bobine A1", x: 0, y: 0 }, { id: "A2", label: "Bobine A2", x: 0, y: 2 }, { id: "COM", label: "Commun", x: 6, y: 1 }, { id: "NO", label: "NO (travail)", x: 6, y: 0 }, { id: "NC", label: "NC (repos)", x: 6, y: 2 }],
  bounds: { x: 1, y: -0.8, w: 4, h: 3.6 },
  rotatable: false,
  params: [{ key: "kind", label: "Modèle", kind: "select", default: "5", options: Object.entries(RELAYS).map(([value, r]) => ({ value, label: r.label })) }],
  datasheet: {
    source: "Songle SRD-xxVDC-SL-C : bobine 0,36 W (5 V : 70 Ω, 71 mA ; 12 V : 400 Ω, 30 mA), collage à 75 % de la tension nominale, décollage à 10 %, contacts 10 A, résistance de contact ≤ 100 mΩ.",
    notes: ["La bobine consomme bien plus qu'une broche de microcontrôleur ne peut fournir : il faut un transistor de commande.", "Non modélisé : inductance de la bobine (la diode de roue libre reste indispensable en vrai), temps de commutation (~10 ms), rebonds."],
  },
  stamp(ctx, inst, [a1, a2, com, no, nc]) {
    const on = inst.rt?.s?.on;
    ctx.conductance(a1, a2, 1 / RELAYS[inst.params.kind].R);
    ctx.conductance(com, no, on ? 1 / R_CONTACT : OPEN_G);
    ctx.conductance(com, nc, on ? OPEN_G : 1 / R_CONTACT);
  },
  update(ctx, inst, [a1, a2]) {
    const s = ((inst.rt ??= {}).s ??= { on: 0 });
    const v = Math.abs(ctx.v(a1) - ctx.v(a2)), vn = RELAYS[inst.params.kind].Vn;
    const on = v >= 0.75 * vn ? 1 : v <= 0.1 * vn ? 0 : s.on;
    if (on === s.on) return false;
    s.on = on;
    return true;
  },
  evaluate(ctx, inst, [a1, a2, com, no, nc]) {
    const on = inst.rt?.s?.on ? 1 : 0;
    const Vcoil = ctx.v(a1) - ctx.v(a2), Icoil = Vcoil / RELAYS[inst.params.kind].R;
    const I = on ? (ctx.v(com) - ctx.v(no)) / R_CONTACT : (ctx.v(com) - ctx.v(nc)) / R_CONTACT;
    return { Vcoil, Icoil, I, on, P: Vcoil * Icoil };
  },
  describe(inst, avg, peak) {
    const r = RELAYS[inst.params.kind];
    const warnings = [];
    let damage;
    if (Math.abs(avg.Vcoil) > 1.5 * r.Vn) damage = `Bobine grillée : ${fmt(Math.abs(avg.Vcoil), "V")} pour ${r.Vn} V nominal.`;
    else if (Math.abs(avg.Vcoil) > 1.1 * r.Vn) warnings.push({ level: "danger", text: `Bobine à ${fmt(Math.abs(avg.Vcoil), "V")} : au-delà de 110 % de sa tension nominale.` });
    else if (Math.abs(avg.Vcoil) > 0.1 * r.Vn && Math.abs(avg.Vcoil) < 0.75 * r.Vn) warnings.push({ level: "warn", text: `Bobine à ${fmt(Math.abs(avg.Vcoil), "V")} : il faut ${fmt(0.75 * r.Vn, "V")} pour coller à coup sûr.` });
    if (Math.abs(peak.I) > I_CONTACT) warnings.push({ level: "danger", text: `Contacts à ${fmt(Math.abs(peak.I), "A")} : au-delà de 10 A.` });
    return { readings: [["État", avg.on > 0.5 ? "collé (COM–NO)" : "au repos (COM–NC)"], ["Bobine", `${fmt(avg.Vcoil, "V")} · ${fmt(avg.Icoil, "A")}`], ["Courant dans le contact", fmt(avg.I, "A")]], warnings, damage };
  },
  reading: (inst, avg) => (avg.on > 0.5 ? "collé" : "repos"),
  label: (inst) => `Relais ${RELAYS[inst.params.kind].Vn} V`,
  symbol(inst) {
    const on = inst.rt?.s?.on;
    return `<rect class="body" x="20" y="-16" width="80" height="72" rx="4"/>`
      + `<polyline points="0,0 34,0 34,8"/><rect x="26" y="8" width="16" height="24"/><polyline points="34,32 34,40 0,40"/>`
      + `<line class="dash" x1="42" y1="20" x2="74" y2="20"/>`
      + `<line x1="120" y1="20" x2="92" y2="20"/><circle class="fill" cx="92" cy="20" r="2.5"/><line x1="92" y1="20" x2="70" y2="${on ? 3 : 37}"/>`
      + `<polyline points="120,0 72,0"/><circle class="fill" cx="72" cy="0" r="2.5"/><polyline points="120,40 72,40"/><circle class="fill" cx="72" cy="40" r="2.5"/>`
      + `<text class="pinlabel dark" x="98" y="-4" text-anchor="end">NO</text><text class="pinlabel dark" x="98" y="52" text-anchor="end">NC</text>`;
  },
};
