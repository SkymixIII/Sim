// Transistors : bipolaires (Ebers-Moll) et MOSFET (modèle quadratique + diode de corps).
import { fmt } from "../engine/units.js";
import { stampBJT, bjtCurrents, stampMOS, mosCurrents, stampJunction, junctionIG } from "../engine/devices.js";

// Is, BR : modèles SPICE publiés par les fabricants. BF : hFE typique de la fiche au courant de test
// (le modèle complet ajoute IKF/ISE pour reproduire la variation du gain avec le courant, pas simulée ici).
export const BJT_MODELS = {
  "2N2222A": { label: "2N2222A (NPN, 600 mA)", pol: 1, Is: 14.34e-15, BF: 200, BR: 6.092, Icmax: 0.6, Vceo: 40, Pmax: 0.5, hfe: [100, 300, 0.15],
    ref: "ON Semi / Fairchild PN2222A-2N2222A : hFE 100 à 300 à 150 mA, VCE(sat) ≤ 0,3 V et VBE(sat) 0,6 à 1,2 V à 150 mA / 15 mA, VCEO 40 V, IC 600 mA, 500 mW. SPICE IS=14.34f BR=6.092." },
  "2N3904": { label: "2N3904 (NPN, 200 mA)", pol: 1, Is: 6.734e-15, BF: 200, BR: 0.7371, Icmax: 0.2, Vceo: 40, Pmax: 0.625, hfe: [100, 300, 0.01],
    ref: "ON Semi 2N3904 : hFE 100 à 300 à 10 mA, VBE(sat) 0,65 à 0,85 V à 10 mA / 1 mA, VCEO 40 V, IC 200 mA, 625 mW. SPICE IS=6.734f BR=0.7371." },
  BC547B: { label: "BC547B (NPN, 100 mA)", pol: 1, Is: 2.39e-14, BF: 290, BR: 7.946, Icmax: 0.1, Vceo: 45, Pmax: 0.5, hfe: [200, 450, 0.002],
    ref: "NXP / Philips BC547B : hFE 200 à 450 (typ. 290) à 2 mA, VCEO 45 V, IC 100 mA, 500 mW. SPICE IS=2.39E-14 BR=7.946." },
  "2N3906": { label: "2N3906 (PNP, 200 mA)", pol: -1, Is: 1.41e-15, BF: 180, BR: 4.977, Icmax: 0.2, Vceo: 40, Pmax: 0.625, hfe: [100, 300, 0.01],
    ref: "ON Semi 2N3906 : hFE 100 à 300 à 10 mA, VCEO −40 V, IC −200 mA, 625 mW. SPICE IS=1.41f BF=180.7 BR=4.977." },
  BC557B: { label: "BC557B (PNP, 100 mA)", pol: -1, Is: 3.83e-14, BF: 290, BR: 14.84, Icmax: 0.1, Vceo: 45, Pmax: 0.5, hfe: [220, 475, 0.002],
    ref: "NXP / Philips BC557B : hFE 220 à 475 (typ. 290) à 2 mA, VCEO −45 V, IC −100 mA, 500 mW. SPICE IS=3.834E-14 BR=14.84." },
};

export const bjt = {
  type: "bjt",
  name: "Transistor bipolaire",
  category: "Semi-conducteurs",
  summary: "NPN ou PNP : un petit courant de base commande un courant collecteur hFE fois plus grand.",
  pins: [{ id: "B", label: "Base", x: 0, y: 0 }, { id: "C", label: "Collecteur", x: 2, y: -2 }, { id: "E", label: "Émetteur", x: 2, y: 2 }],
  bounds: { x: 0, y: -2, w: 2.6, h: 4 },
  rotatable: true,
  params: [{ key: "model", label: "Référence", kind: "select", default: "2N2222A", options: Object.entries(BJT_MODELS).map(([value, m]) => ({ value, label: m.label })) }],
  get datasheet() {
    return {
      source: "Modèle d'Ebers-Moll (forme transport de SPICE). Is et BR viennent des modèles SPICE des fabricants, BF est le gain typique de la fiche technique.",
      notes: [...Object.values(BJT_MODELS).map((m) => m.ref), "Non modélisé : variation du gain avec le courant, effet Early, résistances d'accès (VCE(sat) simulé un peu plus faible que le réel), claquage, capacités (commutation instantanée)."],
    };
  },
  stamp(ctx, inst, [b, c, e], br, state) {
    const m = BJT_MODELS[inst.params.model];
    stampBJT(ctx, state, b, c, e, m, m.pol);
  },
  evaluate(ctx, inst, [b, c, e]) {
    const m = BJT_MODELS[inst.params.model];
    const vbe = ctx.v(b) - ctx.v(e), vce = ctx.v(c) - ctx.v(e);
    const r = bjtCurrents(m.pol * vbe, m.pol * (vbe - vce), m, ctx.tempC);
    const Ic = m.pol * r.Ic, Ib = m.pol * r.Ib;
    return { Vbe: vbe, Vce: vce, Ic, Ib, P: vce * Ic + vbe * Ib };
  },
  describe(inst, avg, peak) {
    const m = BJT_MODELS[inst.params.model];
    const warnings = [];
    let damage;
    const ic = Math.abs(peak.Ic), vce = m.pol * peak.Vce;
    if (avg.P > 2 * m.Pmax) damage = `Détruit par échauffement : ${fmt(avg.P, "W")} dissipés (max ${fmt(m.Pmax, "W")}).`;
    else if (avg.P > m.Pmax) warnings.push({ level: "danger", text: `Dissipe ${fmt(avg.P, "W")}, au-delà de ${fmt(m.Pmax, "W")}.` });
    if (ic > m.Icmax) warnings.push({ level: "danger", text: `Courant collecteur ${fmt(ic, "A")} > IC max ${fmt(m.Icmax, "A")}.` });
    if (vce > m.Vceo) warnings.push({ level: "danger", text: `VCE = ${fmt(vce, "V")} > VCEO ${fmt(m.Vceo, "V")} : claquage.` });
    if (m.pol * avg.Vbe < -6) warnings.push({ level: "danger", text: `Jonction base-émetteur en inverse à ${fmt(Math.abs(avg.Vbe), "V")} (max 6 V environ).` });
    const on = Math.abs(avg.Ic) > 1e-6;
    const sat = on && m.pol * avg.Vce < 0.3;
    return {
      readings: [["Régime", !on ? "bloqué" : sat ? "saturé (interrupteur fermé)" : "linéaire (amplificateur)"], ["VBE", fmt(avg.Vbe, "V")], ["VCE", fmt(avg.Vce, "V")], ["Courant de base", fmt(avg.Ib, "A")], ["Courant collecteur", fmt(avg.Ic, "A")], ["Gain IC/IB", on && Math.abs(avg.Ib) > 1e-12 ? (avg.Ic / avg.Ib).toFixed(0) : "—"], ["Puissance", fmt(avg.P, "W")]],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(Math.abs(avg.Ic), "A"),
  label: (inst) => inst.params.model,
  symbol(inst) {
    const npn = BJT_MODELS[inst.params.model].pol > 0;
    const arrow = npn ? `<polygon class="fill" points="40,24 31,22 36,15"/>` : `<polygon class="fill" points="24,9 33,11 28,18"/>`;
    return `<circle class="outline" cx="30" cy="0" r="23"/><line x1="0" y1="0" x2="22" y2="0"/><line class="thick3" x1="22" y1="-14" x2="22" y2="14"/>`
      + `<polyline points="22,-7 40,-22 40,-40"/><polyline points="22,7 40,22 40,40"/>${arrow}`;
  },
};

// Vt : VGS(th) typique. Kp et Rd ajustés pour passer par les RDS(on) de la fiche (voir notes).
export const MOS_MODELS = {
  "2N7000": { label: "2N7000 (canal N, 200 mA)", pol: 1, Vt: 2.1, Kp: 0.4835, Rd: 0.94, Idmax: 0.2, Vdss: 60, Vgsmax: 20, Pmax: 0.4,
    ref: "ON Semi 2N7000 : VGS(th) 0,8 à 3 V (typ. 2,1), RDS(on) typ. 1,2 Ω à VGS = 10 V et 1,8 Ω à 4,5 V, VDSS 60 V, ID 200 mA, 400 mW. Kp = 0,48 A/V² et Rd = 0,94 Ω ajustés sur ces deux points." },
  IRLZ44N: { label: "IRLZ44N (canal N, niveau logique, 47 A)", pol: 1, Vt: 1.8, Kp: 63.5, Rd: 0.0201, Idmax: 47, Vdss: 55, Vgsmax: 16, Pmax: 2.4,
    ref: "Infineon / IR IRLZ44N : VGS(th) 1 à 2 V, RDS(on) ≤ 22 mΩ à VGS = 10 V et ≤ 25 mΩ à 5 V, VDSS 55 V, ID 47 A, VGS ±16 V, RθJA 62 °C/W (≈ 2,4 W sans dissipateur). Kp = 63,5 A/V² et Rd = 20 mΩ ajustés sur ces deux points." },
  IRF9540N: { label: "IRF9540N (canal P, 23 A)", pol: -1, Vt: 3, Kp: 2.0, Rd: 0.04, Idmax: 23, Vdss: 100, Vgsmax: 20, Pmax: 2.4,
    ref: "Infineon / IR IRF9540N : VGS(th) −2 à −4 V, RDS(on) ≤ 117 mΩ à VGS = −10 V, gfs ≥ 5,3 S à −11 A, VDSS −100 V, ID −23 A, RθJA 62 °C/W. Kp = 2,0 A/V² et Rd = 40 mΩ ajustés pour passer par RDS(on) à −11 A en respectant gfs." },
};
const BODY = { Is: 1e-12, n: 1 };

export const mosfet = {
  type: "mosfet",
  name: "MOSFET",
  category: "Semi-conducteurs",
  summary: "Interrupteur commandé en tension : la grille ne consomme aucun courant en continu.",
  pins: [{ id: "G", label: "Grille", x: 0, y: 0 }, { id: "D", label: "Drain", x: 2, y: -2 }, { id: "S", label: "Source", x: 2, y: 2 }],
  bounds: { x: 0, y: -2, w: 2.6, h: 4 },
  rotatable: true,
  params: [{ key: "model", label: "Référence", kind: "select", default: "2N7000", options: Object.entries(MOS_MODELS).map(([value, m]) => ({ value, label: m.label })) }],
  get datasheet() {
    return {
      source: "Modèle quadratique de Shichman-Hodges (SPICE niveau 1) + résistance de drain + diode de corps.",
      notes: [...Object.values(MOS_MODELS).map((m) => m.ref), "Non modélisé : capacités de grille (commutation instantanée, pas de courant de grille), dispersion du seuil d'une pièce à l'autre, échauffement."],
    };
  },
  internalNodes: () => 1,
  stamp(ctx, inst, [g, d, s, di], br, state) {
    const m = MOS_MODELS[inst.params.model];
    ctx.conductance(d, di, 1 / m.Rd);
    stampMOS(ctx, g, di, s, m, m.pol);
    if (m.pol > 0) stampJunction(ctx, state, "bd", s, d, BODY); else stampJunction(ctx, state, "bd", d, s, BODY);
  },
  evaluate(ctx, inst, [g, d, s, di]) {
    const m = MOS_MODELS[inst.params.model];
    const vgs = ctx.v(g) - ctx.v(s), vds = ctx.v(d) - ctx.v(s);
    const ch = m.pol * mosCurrents(m.pol * vgs, m.pol * (ctx.v(di) - ctx.v(s)), m).Id;
    const body = m.pol * junctionIG(-m.pol * vds, BODY, ctx.tempC).I; // courant source → drain dans la diode
    const Id = ch - body;
    return { Vgs: vgs, Vds: vds, Id, Ibody: body, P: vds * Id };
  },
  describe(inst, avg, peak) {
    const m = MOS_MODELS[inst.params.model];
    const warnings = [];
    let damage;
    if (Math.abs(peak.Vgs) > m.Vgsmax) damage = `Oxyde de grille percé : VGS = ${fmt(peak.Vgs, "V")} (max ±${m.Vgsmax} V).`;
    else if (avg.P > 2 * m.Pmax) damage = `Détruit par échauffement : ${fmt(avg.P, "W")} dissipés sans dissipateur (max ≈ ${fmt(m.Pmax, "W")}).`;
    else if (avg.P > m.Pmax) warnings.push({ level: "danger", text: `Dissipe ${fmt(avg.P, "W")} : il faut un dissipateur (≈ ${fmt(m.Pmax, "W")} à l'air libre).` });
    if (Math.abs(peak.Id) > m.Idmax) warnings.push({ level: "danger", text: `Courant de drain ${fmt(Math.abs(peak.Id), "A")} > ID max ${fmt(m.Idmax, "A")}.` });
    if (m.pol * peak.Vds > m.Vdss) warnings.push({ level: "danger", text: `VDS = ${fmt(peak.Vds, "V")} > VDSS ${m.Vdss} V : avalanche.` });
    const on = Math.abs(avg.Id) > 1e-6;
    const vov = m.pol * avg.Vgs - m.Vt;
    const ohmic = on && m.pol * avg.Vds < vov;
    if (on && !ohmic && avg.P > 0.25 * m.Pmax) warnings.push({ level: "warn", text: `Pas complètement passant (VGS = ${fmt(avg.Vgs, "V")}) : il chauffe. Augmentez la tension de grille.` });
    return {
      readings: [["Régime", !on ? "bloqué" : avg.Ibody * m.pol > 1e-6 ? "diode de corps passante" : ohmic ? "passant (ohmique)" : "saturation (source de courant)"], ["VGS", fmt(avg.Vgs, "V")], ["VDS", fmt(avg.Vds, "V")], ["Courant de drain", fmt(avg.Id, "A")], ["Résistance drain-source", on && ohmic ? fmt(avg.Vds / avg.Id, "Ω") : "—"], ["Puissance", fmt(avg.P, "W")]],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(Math.abs(avg.Id), "A"),
  label: (inst) => inst.params.model,
  symbol(inst) {
    const n = MOS_MODELS[inst.params.model].pol > 0;
    const arrow = n ? `<polygon class="fill" points="26,0 34,-4 34,4"/>` : `<polygon class="fill" points="36,0 28,-4 28,4"/>`;
    return `<circle class="outline" cx="30" cy="0" r="23"/><line x1="0" y1="0" x2="17" y2="0"/><line x1="17" y1="-12" x2="17" y2="12"/>`
      + `<line class="thick3" x1="24" y1="-15" x2="24" y2="-7"/><line class="thick3" x1="24" y1="-4" x2="24" y2="4"/><line class="thick3" x1="24" y1="7" x2="24" y2="15"/>`
      + `<polyline points="24,-11 40,-11 40,-40"/><polyline points="24,11 40,11 40,40"/><polyline points="24,0 40,0 40,11"/>${arrow}`;
  },
};
