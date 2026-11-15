// Amplificateurs opérationnels et comparateur.
// Macro-modèle : gain fini, un pôle (produit gain-bande), vitesse de balayage (slew rate),
// excursion de sortie limitée par les alimentations, courant de sortie limité, tension de décalage.
import { fmt } from "../engine/units.js";
import { OPEN_G } from "../engine/devices.js";

// hh / hl : marge entre la sortie et le rail + / le rail − (V). Valeurs typiques des fiches techniques.
export const OPAMP_MODELS = {
  LM358: { label: "LM358 (alimentation simple, 1 MHz)", A0: 1e5, GBW: 1.1e6, SR: 0.6e6, Vos: 2e-3, hh: 1.5, hl: 0.005, Isrc: 0.04, Isink: 0.02, Iq: 0.35e-3, Ro: 100,
    Vmin: 3, Vmax: 32, cmLo: 0, cmHi: -1.5,
    ref: "ST LM358 : alimentation 3 à 32 V, Vio typ. 2 mV, gain 100 V/mV, GBP 1,1 MHz, SR 0,6 V/µs, sortie de 5 mV à VCC − 1,5 V, +40 / −20 mA, 0,7 mA pour les deux amplis. Mode commun : de 0 V à VCC − 1,5 V." },
  uA741: { label: "µA741 (classique, alimentation ±15 V)", A0: 2e5, GBW: 1e6, SR: 0.5e6, Vos: 1e-3, hh: 1, hl: 1, Isrc: 0.025, Isink: 0.025, Iq: 1.7e-3, Ro: 75,
    Vmin: 10, Vmax: 36, cmLo: 2, cmHi: -2,
    ref: "TI µA741 : alimentation ±5 à ±18 V, VIO typ. 1 mV, gain 200 V/mV, B1 1 MHz, SR 0,5 V/µs, excursion ±14 V sous ±15 V, court-circuit ±25 mA, 1,7 mA, résistance de sortie 75 Ω. Mode commun : à 2 V des rails." },
  TL072: { label: "TL072 (entrées JFET, 3 MHz, faible bruit)", A0: 2e5, GBW: 3e6, SR: 13e6, Vos: 3e-3, hh: 1.5, hl: 1.5, Isrc: 0.04, Isink: 0.04, Iq: 1.4e-3, Ro: 100,
    Vmin: 7, Vmax: 36, cmLo: 3, cmHi: 0,
    ref: "ST / TI TL072 : alimentation ±3,5 à ±18 V, Vio typ. 3 mV, gain 200 V/mV, GBP 3 MHz, SR 13 V/µs, excursion ±13,5 V sous ±15 V, court-circuit 40 mA, 1,4 mA par ampli. Mode commun : de V− + 3 V à V+." },
  MCP6002: { label: "MCP6002 (rail à rail, 1,8 à 6 V)", A0: 4e5, GBW: 1e6, SR: 0.6e6, Vos: 0, hh: 0.025, hl: 0.025, Isrc: 0.023, Isink: 0.023, Iq: 0.1e-3, Ro: 100,
    Vmin: 1.8, Vmax: 6, absMax: 7, cmLo: -0.3, cmHi: 0.3,
    ref: "Microchip MCP6002 : alimentation 1,8 à 6 V (7 V max absolu), gain 112 dB, GBWP 1 MHz, SR 0,6 V/µs, sortie à 25 mV des rails, court-circuit ±23 mA, 100 µA par ampli, entrées rail à rail. Décalage ≤ ±4,5 mV (typique non spécifié : 0 dans le modèle)." },
};

const LIN = 0, HI = 1, LO = 2, OFF = 3;

// Bornes relatives au milieu des alimentations, et consigne u de la sortie interne.
function opState(ctx, inst, nodes, m) {
  const [inp, inn, , vp, vm] = nodes;
  const span = ctx.v(vp) - ctx.v(vm);
  const vd = ctx.v(inp) - ctx.v(inn) + m.Vos;
  let g = m.A0, c0 = 0, hi = span / 2 - m.hh, lo = -span / 2 + m.hl;
  if (ctx.dt) {
    const xp = inst.rt?.s?.x ?? 0;
    const alpha = ctx.dt * 2 * Math.PI * m.GBW / m.A0;
    g = m.A0 * alpha / (1 + alpha); c0 = xp / (1 + alpha);
    hi = Math.min(hi, Math.max(xp, lo) + m.SR * ctx.dt);
    lo = Math.max(lo, Math.min(xp, span / 2 - m.hh) - m.SR * ctx.dt);
  }
  const u = g * vd + c0;
  return { span, vd, g, c0, hi, lo, u, on: span >= Math.min(m.Vmin, 3) * 0.9 && hi > lo };
}

export const opamp = {
  type: "opamp",
  name: "Ampli opérationnel",
  category: "Circuits intégrés analogiques",
  summary: "Amplificateur opérationnel réel : gain, bande passante, slew rate et excursion de sortie de la référence choisie.",
  reactive: true,
  pins: [
    { id: "IN+", label: "Entrée non inverseuse (+)", x: 0, y: -1 }, { id: "IN-", label: "Entrée inverseuse (−)", x: 0, y: 1 },
    { id: "OUT", label: "Sortie", x: 6, y: 0 }, { id: "V+", label: "Alimentation +", x: 3, y: -3 }, { id: "V-", label: "Alimentation − (ou masse)", x: 3, y: 3 },
  ],
  bounds: { x: 1, y: -2.4, w: 4, h: 4.8 },
  rotatable: false,
  params: [{ key: "model", label: "Référence", kind: "select", default: "LM358", options: Object.entries(OPAMP_MODELS).map(([value, m]) => ({ value, label: m.label })) }],
  get datasheet() {
    return {
      source: "Macro-modèle à un pôle : gain en boucle ouverte, produit gain-bande, slew rate, saturation aux rails, limitation de courant, tension de décalage typique. Un symbole = un ampli du boîtier.",
      notes: [...Object.values(OPAMP_MODELS).map((m) => m.ref), "Non modélisé : courants de polarisation d'entrée, bruit, inversion de phase hors mode commun (signalée par une alerte), résistance de sortie exacte (ordre de grandeur 100 Ω en boucle ouverte)."],
    };
  },
  internalNodes: () => 1,
  branches: () => 1,
  stamp(ctx, inst, nodes, [k], state) {
    const m = OPAMP_MODELS[inst.params.model];
    const [inp, inn, out, vp, vm, ni] = nodes;
    const s = opState(ctx, inst, nodes, m);
    ctx.conductance(ni, out, 1 / m.Ro);
    // Courant de repos.
    if (s.span > 3) ctx.current(vp, vm, m.Iq); else ctx.conductance(vp, vm, m.Iq / 3);
    const r = ctx.branchRow(k), R = ctx.nodeRow;
    const i = ctx.branchI(k);
    // Le courant de sortie vient du rail + (sortie qui fournit) ou repart vers le rail − (sortie qui absorbe).
    ctx.addA(R(ni), r, -1);
    ctx.addA(R(i >= 0 ? vp : vm), r, 1);
    if (!s.on) { ctx.addA(r, r, 1); state.reg = OFF; return; }
    // Région de la caractéristique : linéaire, saturée haute ou basse.
    const natural = s.u > s.hi ? HI : s.u < s.lo ? LO : LIN;
    let reg = natural;
    if ((natural === HI && state.reg === LO) || (natural === LO && state.reg === HI)) { reg = LIN; ctx.markLimited(); }
    else if (state.reg !== undefined && state.reg !== natural) ctx.markLimited();
    state.reg = reg;
    // Limitation du courant de sortie.
    const target = Math.min(s.hi, Math.max(s.lo, s.u));
    const vint = ctx.v(ni) - (ctx.v(vp) + ctx.v(vm)) / 2;
    let cl = state.cl ?? 0;
    if (cl === 0) { if (i > m.Isrc * 1.000001) cl = 1; else if (i < -m.Isink * 1.000001) cl = -1; }
    else if ((cl === 1 && vint > target + 1e-9) || (cl === -1 && vint < target - 1e-9)) cl = 0;
    if (cl !== (state.cl ?? 0)) ctx.markLimited();
    state.cl = cl;
    if (cl) { ctx.addA(r, r, 1); ctx.addB(r, cl > 0 ? m.Isrc : -m.Isink); return; }
    // v(ni) − (V+ + V−)/2 = g·(v+ − v− + Vos) + c0, ou = borne.
    ctx.addA(r, R(ni), 1); ctx.addA(r, R(vp), -0.5); ctx.addA(r, R(vm), -0.5);
    if (reg === LIN) { ctx.addA(r, R(inp), -s.g); ctx.addA(r, R(inn), s.g); ctx.addB(r, s.g * m.Vos + s.c0); }
    else ctx.addB(r, reg === HI ? s.hi : s.lo);
  },
  evaluate(ctx, inst, nodes, [k]) {
    const [inp, inn, out, vp, vm] = nodes;
    const m = OPAMP_MODELS[inst.params.model];
    const I = ctx.branchI(k), span = ctx.v(vp) - ctx.v(vm);
    const Vout = ctx.v(out) - ctx.v(vm);
    return {
      Vout, Vd: ctx.v(inp) - ctx.v(inn), Vp: ctx.v(inp) - ctx.v(vm), Vn: ctx.v(inn) - ctx.v(vm), Vs: span, Iout: I,
      Icc: (span > 3 ? m.Iq : m.Iq * span / 3) + Math.max(I, 0),
      P: m.Iq * Math.max(span, 0) + (I >= 0 ? (span - Vout) * I : -Vout * I),
    };
  },
  commit(ctx, inst, nodes) {
    const m = OPAMP_MODELS[inst.params.model];
    const s = opState(ctx, inst, nodes, m);
    (inst.rt ??= {}).s = { x: s.on ? Math.min(s.hi, Math.max(s.lo, s.u)) : 0 };
  },
  describe(inst, avg, peak) {
    const m = OPAMP_MODELS[inst.params.model];
    const warnings = [];
    let damage;
    if (avg.Vs > (m.absMax ?? m.Vmax * 1.1)) damage = `Détruit : ${fmt(avg.Vs, "V")} d'alimentation (max ${fmt(m.absMax ?? m.Vmax, "V")}).`;
    else if (avg.Vs > m.Vmax) warnings.push({ level: "danger", text: `Alimentation ${fmt(avg.Vs, "V")} > ${fmt(m.Vmax, "V")} recommandés.` });
    else if (avg.Vs < m.Vmin * 0.98) warnings.push({ level: "warn", text: avg.Vs < 0.5 ? "Non alimenté : reliez V+ et V− à une alimentation." : `Alimentation ${fmt(avg.Vs, "V")} sous le minimum (${fmt(m.Vmin, "V")}).` });
    const powered = avg.Vs >= m.Vmin * 0.98;
    const satHi = powered && avg.Vout > avg.Vs - m.hh - 0.02, satLo = powered && avg.Vout < m.hl + 0.02;
    if (powered) {
      const cmLo = m.cmLo, cmHi = avg.Vs + m.cmHi;
      for (const [name, v] of [["+", avg.Vp], ["−", avg.Vn]]) {
        if (v < cmLo - 0.05 || v > cmHi + 0.05) { warnings.push({ level: "warn", text: `Entrée ${name} à ${fmt(v, "V")} : hors de la plage de mode commun (${fmt(cmLo, "V")} à ${fmt(cmHi, "V")} par rapport à V−). Le vrai composant ne fonctionne plus correctement.` }); break; }
      }
      if (Math.abs(peak.Iout) > 0.98 * (peak.Iout > 0 ? m.Isrc : m.Isink)) warnings.push({ level: "danger", text: `Sortie en limitation de courant (${fmt(Math.abs(peak.Iout), "A")}).` });
    }
    return {
      readings: [["Sortie (par rapport à V−)", fmt(avg.Vout, "V")], ["État", !powered ? "non alimenté" : satHi ? "saturé en haut" : satLo ? "saturé en bas" : "linéaire"], ["V(+) − V(−)", fmt(avg.Vd, "V")], ["Courant de sortie", fmt(avg.Iout, "A")], ["Alimentation", `${fmt(avg.Vs, "V")} · ${fmt(avg.Icc, "A")}`], ["Puissance", fmt(avg.P, "W")]],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(avg.Vout, "V"),
  label: (inst) => inst.params.model.replace("uA", "µA"),
  symbol: () => `<polygon class="body" points="20,-44 20,44 100,0"/><line x1="0" y1="-20" x2="20" y2="-20"/><line x1="0" y1="20" x2="20" y2="20"/><line x1="100" y1="0" x2="120" y2="0"/>`
    + `<line x1="60" y1="-60" x2="60" y2="-22"/><line x1="60" y1="60" x2="60" y2="22"/>`
    + `<text class="sym" x="30" y="-15">+</text><text class="sym" x="30" y="25">−</text><text class="pinlabel dark" x="65" y="-30">V+</text><text class="pinlabel dark" x="65" y="37">V−</text>`,
};

// Comparateur à sortie collecteur ouvert.
const LM393 = { Vos: 1e-3, Rsat: 37.5, Isink: 0.016, Iq: 0.2e-3, Vmin: 2, Vmax: 36 };

export const comparator = {
  type: "comparator",
  name: "Comparateur LM393",
  category: "Circuits intégrés analogiques",
  summary: "Compare deux tensions. Sortie à collecteur ouvert : elle tire vers la masse ou reste en l'air (prévoir une résistance de tirage).",
  pins: [
    { id: "IN+", label: "Entrée +", x: 0, y: -1 }, { id: "IN-", label: "Entrée −", x: 0, y: 1 },
    { id: "OUT", label: "Sortie (collecteur ouvert)", x: 6, y: 0 }, { id: "V+", label: "Alimentation +", x: 3, y: -3 }, { id: "GND", label: "Masse", x: 3, y: 3 },
  ],
  bounds: { x: 1, y: -2.4, w: 4, h: 4.8 },
  rotatable: false,
  params: [],
  datasheet: {
    source: "TI / ST LM393 : alimentation 2 à 36 V, décalage typ. 1 mV, sortie collecteur ouvert, VOL typ. 150 mV à 4 mA, courant absorbé 16 mA typ., 0,4 mA pour les deux comparateurs.",
    notes: ["Sortie basse quand V(−) > V(+), en l'air sinon : sans résistance de tirage vers le +, la sortie ne monte jamais.", "Non modélisé : temps de réponse (1,3 µs), courants d'entrée (25 nA)."],
  },
  stamp(ctx, inst, [inp, inn, out, vp, gnd]) {
    const on = inst.rt?.s?.on;
    ctx.conductance(out, gnd, on ? 1 / LM393.Rsat : OPEN_G);
    if (ctx.v(vp) - ctx.v(gnd) > 3) ctx.current(vp, gnd, LM393.Iq); else ctx.conductance(vp, gnd, LM393.Iq / 3);
  },
  update(ctx, inst, [inp, inn, out, vp, gnd]) {
    const s = ((inst.rt ??= {}).s ??= { on: 0 });
    const powered = ctx.v(vp) - ctx.v(gnd) >= LM393.Vmin;
    const on = powered && ctx.v(inn) > ctx.v(inp) + LM393.Vos ? 1 : 0;
    if (on === s.on) return false;
    s.on = on;
    return true;
  },
  evaluate(ctx, inst, [inp, inn, out, vp, gnd]) {
    const Vout = ctx.v(out) - ctx.v(gnd);
    const on = inst.rt?.s?.on ? 1 : 0;
    const I = on ? Vout / LM393.Rsat : 0;
    return { Vout, Vd: ctx.v(inp) - ctx.v(inn), Vs: ctx.v(vp) - ctx.v(gnd), Isink: I, on, P: Vout * I };
  },
  describe(inst, avg, peak) {
    const warnings = [];
    let damage;
    if (avg.Vs > LM393.Vmax * 1.05) damage = `Détruit : ${fmt(avg.Vs, "V")} d'alimentation (max 36 V).`;
    else if (avg.Vs < LM393.Vmin) warnings.push({ level: "warn", text: "Non alimenté (2 V minimum entre V+ et la masse)." });
    if (peak.Isink > LM393.Isink) warnings.push({ level: "danger", text: `La sortie absorbe ${fmt(peak.Isink, "A")} : au-delà de 16 mA le transistor de sortie quitte la saturation et chauffe.` });
    return {
      readings: [["Sortie", `${avg.on > 0.5 ? "basse (transistor passant)" : "en l'air (haute impédance)"} · ${fmt(avg.Vout, "V")}`], ["V(+) − V(−)", fmt(avg.Vd, "V")], ["Courant absorbé", fmt(avg.Isink, "A")], ["Alimentation", fmt(avg.Vs, "V")]],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(avg.Vout, "V"),
  label: () => "LM393",
  symbol: () => `<polygon class="body" points="20,-44 20,44 100,0"/><line x1="0" y1="-20" x2="20" y2="-20"/><line x1="0" y1="20" x2="20" y2="20"/><line x1="100" y1="0" x2="120" y2="0"/>`
    + `<line x1="60" y1="-60" x2="60" y2="-22"/><line x1="60" y1="60" x2="60" y2="22"/>`
    + `<text class="sym" x="30" y="-15">+</text><text class="sym" x="30" y="25">−</text><polyline points="52,6 60,6 60,-6 68,-6"/><text class="pinlabel dark" x="65" y="-30">V+</text><text class="pinlabel dark" x="65" y="37">GND</text>`,
};
