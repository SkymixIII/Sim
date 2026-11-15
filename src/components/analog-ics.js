// Circuits intégrés analogiques : temporisateur NE555 et régulateurs de tension.
import { fmt } from "../engine/units.js";
import { OPEN_G } from "../engine/devices.js";
import { dipPins, dipBounds, dipSymbol, boxSymbol } from "./shapes.js";

// ---------- NE555 ----------
const N555 = ["GND", "TRIG", "OUT", "~RESET", "CTRL", "THR", "DISCH", "VCC"];
const T555 = { Rdiv: 5e3, Rsupply: 1600, VdropH: 1.2, RoutH: 5, RoutL: 10, Rdis: 10, Rreset: 100e3, Vreset: 0.7, Vmin: 4.5, Vmax: 16, absMax: 18, Iout: 0.2 };

export const ne555 = {
  type: "ne555",
  name: "NE555 (temporisateur)",
  category: "Circuits intégrés analogiques",
  summary: "Le temporisateur universel : astable (clignotant, oscillateur), monostable, bascule.",
  pins: dipPins(N555),
  bounds: dipBounds(N555),
  rotatable: false,
  params: [],
  datasheet: {
    source: "TI NE555 : alimentation 4,5 à 16 V, seuils à 1/3 et 2/3 de VCC (pont interne 3 × 5 kΩ), sortie ±200 mA, courant d'alimentation 3 mA à 5 V et 10 mA à 15 V.",
    notes: [
      "Sortie haute : VCC − 1,7 V à 100 mA (VCC − 1,2 V à vide). Sortie basse : 0,1 V à 10 mA. Transistor de décharge : ~10 Ω.",
      "RESET (actif bas) est tiré en interne vers VCC ; seuil 0,7 V. TRIG prioritaire sur THR.",
      "Astable : f = 1,44 / ((RA + 2·RB)·C), rapport cyclique (RA + RB) / (RA + 2·RB).",
      "Non modélisé : pointe de courant d'alimentation à chaque commutation (d'où le condensateur de découplage en vrai), temps de propagation (~100 ns), courants d'entrée (TRIG 0,5 µA, THR 30 nA).",
    ],
  },
  stamp(ctx, inst, n) {
    const [gnd, , out, rst, ctl, , dis, vcc] = n;
    const q = inst.rt?.s?.q;
    ctx.conductance(vcc, ctl, 1 / T555.Rdiv);
    ctx.conductance(ctl, gnd, 1 / (2 * T555.Rdiv));
    ctx.conductance(vcc, gnd, 1 / T555.Rsupply - 1 / (3 * T555.Rdiv));
    ctx.conductance(rst, vcc, 1 / T555.Rreset);
    if (ctx.v(vcc) - ctx.v(gnd) < 2) return; // non alimenté : sortie flottante
    if (q) {
      ctx.conductance(vcc, out, 1 / T555.RoutH);
      ctx.current(out, vcc, T555.VdropH / T555.RoutH);
    } else ctx.conductance(out, gnd, 1 / T555.RoutL);
    ctx.conductance(dis, gnd, q ? OPEN_G : 1 / T555.Rdis);
  },
  update(ctx, inst, n) {
    const [gnd, trig, , rst, ctl, thr, , vcc] = n;
    const s = ((inst.rt ??= {}).s ??= { q: 0 });
    const g = ctx.v(gnd), vctl = ctx.v(ctl) - g;
    let q = s.q;
    if (ctx.v(vcc) - g < 2 || ctx.v(rst) - g < T555.Vreset) q = 0;
    else if (ctx.v(trig) - g < vctl / 2) q = 1;
    else if (ctx.v(thr) - g > vctl) q = 0;
    if (q === s.q) return false;
    s.q = q;
    return true;
  },
  evaluate(ctx, inst, n) {
    const [gnd, trig, out, , ctl, thr, dis, vcc] = n;
    const g = ctx.v(gnd), Vcc = ctx.v(vcc) - g, Vout = ctx.v(out) - g, q = inst.rt?.s?.q ? 1 : 0;
    const on = Vcc >= 2;
    const Iout = !on ? 0 : q ? (Vcc - T555.VdropH - Vout) / T555.RoutH : -Vout / T555.RoutL;
    const Idis = on && !q ? (ctx.v(dis) - g) / T555.Rdis : 0;
    return { Vcc, Vout, Iout, Vtrig: ctx.v(trig) - g, Vthr: ctx.v(thr) - g, Vctl: ctx.v(ctl) - g, Vdis: ctx.v(dis) - g, Idis, q,
      P: Vcc * Vcc / T555.Rsupply + (q ? (Vcc - Vout) * Math.max(Iout, 0) : Vout * Math.max(-Iout, 0)) + (ctx.v(dis) - g) * Idis };
  },
  describe(inst, avg, peak) {
    const warnings = [];
    let damage;
    if (avg.Vcc > T555.absMax) damage = `Détruit : ${fmt(avg.Vcc, "V")} d'alimentation (max absolu 18 V).`;
    else if (avg.Vcc > T555.Vmax) warnings.push({ level: "danger", text: `Alimentation ${fmt(avg.Vcc, "V")} > 16 V recommandés.` });
    else if (avg.Vcc < 0.5) warnings.push({ level: "warn", text: "Non alimenté : reliez VCC (8) et GND (1)." });
    else if (avg.Vcc < T555.Vmin) warnings.push({ level: "warn", text: `Alimentation ${fmt(avg.Vcc, "V")} sous les 4,5 V minimum du NE555.` });
    if (Math.abs(peak.Iout) > T555.Iout) warnings.push({ level: "danger", text: `Sortie à ${fmt(Math.abs(peak.Iout), "A")} : au-delà de ±200 mA.` });
    if (avg.P > 0.6) warnings.push({ level: "danger", text: `Dissipe ${fmt(avg.P, "W")} (boîtier DIP-8 : 600 mW max).` });
    return {
      readings: [["Sortie (3)", `${fmt(avg.Vout, "V")} · ${fmt(avg.Iout, "A")}`], ["Temps à l'état haut", `${Math.round(avg.q * 100)} %`], ["TRIG (2)", `${fmt(avg.Vtrig, "V")} (seuil ${fmt(avg.Vctl / 2, "V")})`], ["THR (6)", `${fmt(avg.Vthr, "V")} (seuil ${fmt(avg.Vctl, "V")})`], ["DISCH (7)", `${fmt(avg.Vdis, "V")} · ${fmt(avg.Idis, "A")}`], ["Alimentation", fmt(avg.Vcc, "V")]],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(avg.Vout, "V"),
  label: () => "NE555",
  symbol(inst, avg) {
    return dipSymbol(N555, "", (i) => (i === 2 && avg ? (avg.Vout > avg.Vcc / 2 ? "hi out" : "lo") : ""));
  },
};

// ---------- Régulateurs linéaires ----------
// Vdo : tension de déchet (chute minimale entrée-sortie). Ilim : limitation de courant. theta : °C/W jonction-air.
export const VREG_MODELS = {
  L7805: { label: "L7805 (5 V, 1,5 A)", Vnom: 5, Vdo: 2, Ilim: 2.2, Iq: 4.2e-3, Vinmax: 35, theta: 50, Tj: 125, pin: "GND",
    ref: "ST L7805CV (TO-220) : 5 V ± 4 %, tension de déchet 2 V à 1 A, courant de repos 4,2 mA, crête 2,2 A, entrée 35 V max, Rth j-amb 50 °C/W." },
  L7812: { label: "L7812 (12 V, 1,5 A)", Vnom: 12, Vdo: 2, Ilim: 2.2, Iq: 4.3e-3, Vinmax: 35, theta: 50, Tj: 125, pin: "GND",
    ref: "ST L7812CV (TO-220) : 12 V ± 4 %, tension de déchet 2 V à 1 A, courant de repos 4,3 mA, entrée 35 V max, Rth j-amb 50 °C/W." },
  "AMS1117-3.3": { label: "AMS1117-3.3 (3,3 V, LDO 1 A)", Vnom: 3.3, Vdo: 1.1, Ilim: 1.1, Iq: 5e-3, Vinmax: 15, theta: 90, Tj: 125, pin: "GND",
    ref: "AMS AMS1117-3.3 (SOT-223) : 3,3 V ± 1,5 %, tension de déchet 1,1 V (1,3 V max) à 800 mA, courant de repos 5 mA, limitation 1,1 A typ., entrée 15 V max, 90 °C/W." },
  LM317: { label: "LM317 (réglable 1,25 à 37 V)", Vnom: 1.25, Vdo: 2, Ilim: 2.2, Iq: 50e-6, Vinmax: 40, theta: 50, Tj: 125, pin: "ADJ", Imin: 3.5e-3,
    ref: "ST / TI LM317T (TO-220) : référence 1,25 V entre OUT et ADJ, courant de la broche ADJ 50 µA, charge minimale 3,5 mA, limitation 2,2 A typ., VIN − VOUT ≤ 40 V. VOUT = 1,25 V·(1 + R2/R1) + 50 µA·R2." },
};
const REG = 0, DROP = 1, LIM = 2, ROFF = 3;
const VREG_PINS = [{ id: "IN", label: "Entrée", x: 0, y: 0, name: "IN" }, { id: "REF", label: "GND / ADJ", x: 3, y: 2, name: "" }, { id: "OUT", label: "Sortie", x: 6, y: 0, name: "OUT" }];

export const vreg = {
  type: "vreg",
  name: "Régulateur de tension",
  category: "Circuits intégrés analogiques",
  summary: "Régulateur linéaire : tension de sortie fixe tant que l'entrée dépasse la sortie de la tension de déchet.",
  pins: VREG_PINS,
  bounds: { x: 1, y: -1, w: 4, h: 2 },
  rotatable: false,
  params: [{ key: "model", label: "Référence", kind: "select", default: "L7805", options: Object.entries(VREG_MODELS).map(([value, m]) => ({ value, label: m.label })) }],
  get datasheet() {
    return {
      source: "Régulateur série : source de tension tant que VIN − VOUT dépasse la tension de déchet et que le courant reste sous la limitation ; sinon la sortie suit l'entrée ou le courant est plafonné.",
      notes: [...Object.values(VREG_MODELS).map((m) => m.ref), "La puissance (VIN − VOUT)·I part en chaleur : l'alerte thermique suppose un boîtier sans dissipateur à 25 °C.", "Non modélisé : régulation de ligne et de charge (quelques mV), arrêt thermique effectif, stabilité (condensateurs d'entrée et de sortie indispensables en vrai)."],
    };
  },
  branches: () => 1,
  stamp(ctx, inst, [nin, ref, out], [k], state) {
    const m = VREG_MODELS[inst.params.model];
    const vin = ctx.v(nin), vout = ctx.v(out), vref = ctx.v(ref), i = ctx.branchI(k);
    if (vin - vref > 3) ctx.current(nin, ref, m.Iq); else ctx.conductance(nin, ref, m.Iq / 3);
    const r = ctx.branchRow(k), R = ctx.nodeRow;
    ctx.addA(R(nin), r, 1); ctx.addA(R(out), r, -1);
    let mode = state.mode ?? REG;
    const tooLow = vin - vout < m.Vdo - 1e-9, over = vout - vref > m.Vnom + 1e-9;
    if (mode === REG) { if (i > m.Ilim * 1.000001) mode = LIM; else if (tooLow) mode = DROP; else if (i < -1e-9) mode = ROFF; }
    else if (mode === DROP) { if (over) mode = REG; else if (i > m.Ilim * 1.000001) mode = LIM; else if (i < -1e-9) mode = ROFF; }
    else if (mode === LIM) { if (over) mode = REG; else if (tooLow) mode = DROP; }
    else if (vin - vout > m.Vdo + 1e-9) mode = DROP;
    if (mode !== (state.mode ?? REG)) ctx.markLimited();
    state.mode = mode;
    if (mode === REG) { ctx.addA(r, R(out), 1); ctx.addA(r, R(ref), -1); ctx.addB(r, m.Vnom); }
    else if (mode === DROP) { ctx.addA(r, R(nin), 1); ctx.addA(r, R(out), -1); ctx.addB(r, m.Vdo); }
    else { ctx.addA(r, r, 1); ctx.addB(r, mode === LIM ? m.Ilim : 0); }
  },
  evaluate(ctx, inst, [nin, ref, out], [k]) {
    const m = VREG_MODELS[inst.params.model];
    const Vin = ctx.v(nin) - ctx.v(ref), Vout = ctx.v(out) - ctx.v(ref), I = ctx.branchI(k);
    return { Vin, Vout, I, P: (Vin - Vout) * I + Vin * (Vin > 3 ? m.Iq : m.Iq * Vin / 3) };
  },
  describe(inst, avg, peak) {
    const m = VREG_MODELS[inst.params.model];
    const warnings = [];
    let damage;
    const tj = 25 + avg.P * m.theta;
    if (peak.Vin - (m.pin === "ADJ" ? avg.Vout : 0) > m.Vinmax) damage = `Détruit : ${fmt(peak.Vin, "V")} en entrée (max ${m.Vinmax} V).`;
    else if (avg.Vin < -0.5) warnings.push({ level: "danger", text: "Entrée inversée." });
    const regulating = avg.Vout > m.Vnom * 0.98;
    if (avg.Vin > 0.5 && !regulating) {
      if (peak.I >= m.Ilim * 0.98) warnings.push({ level: "danger", text: `Limitation de courant (${fmt(peak.I, "A")}) : la tension de sortie s'effondre.` });
      else warnings.push({ level: "warn", text: `Ne régule pas : il faut au moins ${fmt(m.Vnom + m.Vdo, "V")} ${m.pin === "ADJ" ? "entre l'entrée et ADJ" : "en entrée"} (tension de déchet ${fmt(m.Vdo, "V")}).` });
    }
    if (tj > 150) warnings.push({ level: "danger", text: `Dissipe ${fmt(avg.P, "W")} : jonction à ~${Math.round(tj)} °C sans dissipateur. Le vrai composant se met en sécurité thermique.` });
    else if (tj > m.Tj) warnings.push({ level: "warn", text: `Dissipe ${fmt(avg.P, "W")} : jonction à ~${Math.round(tj)} °C, au-delà de ${m.Tj} °C. Ajoutez un dissipateur.` });
    if (m.Imin && regulating && avg.I < m.Imin) warnings.push({ level: "warn", text: `Charge de ${fmt(avg.I, "A")} : le LM317 demande au moins 3,5 mA pour réguler (R1 = 240 Ω habituellement).` });
    return {
      readings: [["Entrée", fmt(avg.Vin, "V")], [m.pin === "ADJ" ? "Sortie − ADJ" : "Sortie", fmt(avg.Vout, "V")], ["Courant de sortie", fmt(avg.I, "A")], ["Puissance dissipée", fmt(avg.P, "W")], ["Température de jonction estimée", `${Math.round(tj)} °C`]],
      warnings, damage,
    };
  },
  reading: (inst, avg) => fmt(avg.Vout, "V"),
  label: (inst) => inst.params.model,
  symbol(inst) {
    const m = VREG_MODELS[inst.params.model];
    return boxSymbol({ x: 1, y: -1, w: 4, h: 2 }, VREG_PINS.map((p) => (p.id === "REF" ? { ...p, name: m.pin } : p)), "REG");
  },
};
