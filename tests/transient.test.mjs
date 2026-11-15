// Analyse temporelle et nouveaux composants, confrontés à la théorie et aux fiches techniques.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveDC } from "../src/engine/solver.js";
import { simulate } from "../src/engine/circuit.js";
import { Simulation } from "../src/engine/transient.js";
import { REGISTRY, COMPONENTS, defaultParams } from "../src/components/index.js";

const el = (type, params, nodes, rt) => {
  const def = REGISTRY[type];
  return { def, inst: { id: `${type}${Math.random()}`, type, params: { ...defaultParams(def), ...params }, rt }, nodes };
};
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} attendu ${expected} ± ${tol}`);

// Petit langage de montage pour les tests : chaque composant est posé loin des autres, puis relié par
// des fils directs entre broches nommées ("r1.2", "c1.1"…). `net("a.1", "b.2", …)` relie tout le monde.
export function bench() {
  const circuit = { components: [], wires: [] };
  let row = 0;
  const pos = new Map();
  const api = {
    circuit,
    add(id, type, params = {}) {
      const def = REGISTRY[type];
      const c = { id, type, x: 0, y: row, rot: 0, params: { ...defaultParams(def), ...params } };
      row += 40;
      circuit.components.push(c);
      for (const p of def.pins) for (const n of [p.id, p.name, p.name?.replace("~", "")]) if (n) pos.set(`${id}.${n}`, [p.x, c.y + p.y]);
      return api;
    },
    net(...names) {
      const pts = names.map((n) => { const p = pos.get(n); assert.ok(p, `broche inconnue ${n}`); return p; });
      for (let i = 1; i < pts.length; i++) circuit.wires.push({ id: `w${circuit.wires.length}`, x1: pts[0][0] + 1000 + circuit.wires.length, y1: pts[0][1], x2: pts[i][0], y2: pts[i][1] });
      // Fils en étoile depuis un point privé : aucune broche ne peut se trouver par hasard sur un fil.
      const hub = [5000 + circuit.wires.length, -7 - circuit.wires.length];
      circuit.wires.splice(circuit.wires.length - (pts.length - 1));
      for (const p of pts) circuit.wires.push({ id: `w${circuit.wires.length}`, x1: hub[0], y1: hub[1], x2: p[0] + 0, y2: p[1] });
      return api;
    },
    sim() { return new Simulation(circuit); },
    comp: (id) => circuit.components.find((c) => c.id === id),
  };
  return api;
}

// Enregistre une grandeur au fil du temps.
function record(sim, id, key, tEnd) {
  const ts = [], vs = [];
  sim.onStep = (t, s) => { ts.push(t); vs.push(s.instant(id)[key]); };
  sim.advance(tEnd);
  assert.equal(sim.error, null);
  return { ts, vs };
}
// Instants de franchissement montant d'un seuil (interpolés).
function risingEdges({ ts, vs }, level) {
  const out = [];
  for (let i = 1; i < ts.length; i++) if (vs[i - 1] < level && vs[i] >= level) out.push(ts[i - 1] + (ts[i] - ts[i - 1]) * (level - vs[i - 1]) / (vs[i] - vs[i - 1]));
  return out;
}

test("chaque composant du registre respecte le contrat", () => {
  const types = new Set();
  for (const def of COMPONENTS) {
    assert.ok(!types.has(def.type), `type en double : ${def.type}`);
    types.add(def.type);
    for (const k of ["name", "category", "summary", "pins", "bounds", "params", "stamp", "evaluate", "describe", "symbol"]) assert.ok(def[k] !== undefined, `${def.type}.${k}`);
    assert.equal(typeof def.symbol.call(def, { params: defaultParams(def), rt: {} }, undefined), "string", `${def.type}.symbol`);
    if (!def.isGround) assert.ok(def.datasheet?.source, `${def.type} : fiche technique`);
  }
});

test("RC : charge à 63,2 % en une constante de temps", () => {
  const b = bench().add("v", "dc", { V: 5 }).add("r", "resistor", { R: 1000 }).add("c", "capacitor", { C: 1e-6 })
    .net("v.+", "r.1").net("r.2", "c.1").net("c.2", "v.-");
  const sim = b.sim();
  sim.advance(1e-3);
  near(sim.instant("c").V, 5 * (1 - Math.exp(-1)), 0.01, "V(τ)");
  sim.advance(5e-3);
  near(sim.instant("c").V, 5 * (1 - Math.exp(-5)), 0.01, "V(5τ)");
  assert.ok(sim.steps < 400, `pas adaptatif : ${sim.steps} pas`);
});

test("RL : le courant s'établit avec τ = L/R", () => {
  const b = bench().add("v", "dc", { V: 5 }).add("l", "inductor", { L: 10e-3, R: 10 }).add("r", "resistor", { R: 90, Pmax: 1 })
    .net("v.+", "r.1").net("r.2", "l.1").net("l.2", "v.-");
  const sim = b.sim();
  sim.advance(1e-4); // τ = 10 mH / 100 Ω = 100 µs
  near(sim.instant("l").I, 0.05 * (1 - Math.exp(-1)), 2e-4, "I(τ)");
  sim.advance(2e-3);
  near(sim.instant("l").I, 0.05, 1e-4, "I final");
});

test("LC : oscillation à f = 1/(2π√LC)", () => {
  // Condensateur chargé par une source qu'on coupe : on observe l'oscillation amortie du circuit RLC.
  const b = bench().add("g", "funcgen", { wave: "clock", f: 50, A: 5, duty: 0.5 }).add("l", "inductor", { L: 10e-3, R: 1 }).add("c", "capacitor", { C: 1e-6 })
    .net("g.+", "l.1").net("l.2", "c.1").net("c.2", "g.-");
  const sim = b.sim();
  const rec = record(sim, "c", "V", 8e-3);
  const edges = risingEdges(rec, 5).filter((t) => t > 1e-4);
  assert.ok(edges.length >= 3, `oscillations observées : ${edges.length}`);
  const f = 1 / (edges[2] - edges[1]);
  // Pseudo-pulsation d'un RLC série amorti (R = 1 Ω de bobinage + 50 Ω du générateur) : ωd = √(ω0² − (R/2L)²).
  const wd = Math.sqrt(1 / (10e-3 * 1e-6) - (51 / (2 * 10e-3)) ** 2);
  near(f, wd / (2 * Math.PI), 20, "pseudo-fréquence (1539 Hz)");
});

test("filtre RC passe-bas : −3 dB à la fréquence de coupure", () => {
  const fc = 1 / (2 * Math.PI * 1000 * 100e-9); // 1592 Hz
  const b = bench().add("g", "funcgen", { wave: "sine", f: fc, A: 1 }).add("r", "resistor", { R: 1000 - 50 }).add("c", "capacitor", { C: 100e-9 })
    .net("g.+", "r.1").net("r.2", "c.1").net("c.2", "g.-");
  const sim = b.sim();
  sim.advance(5 / fc);
  const rec = record(sim, "c", "V", 8 / fc);
  near(Math.max(...rec.vs), Math.SQRT1_2, 0.01, "amplitude à fc");
});

test("générateur de fonctions : sortie 50 Ω (amplitude divisée par 2 sur 50 Ω)", () => {
  const b = bench().add("g", "funcgen", { wave: "square", f: 1000, A: 2 }).add("r", "resistor", { R: 50 }).net("g.+", "r.1").net("g.-", "r.2");
  const sim = b.sim();
  const rec = record(sim, "r", "V", 3e-3);
  near(Math.max(...rec.vs), 1, 1e-6, "crête");
  near(Math.min(...rec.vs), -1, 1e-6, "creux");
  const edges = risingEdges(rec, 0);
  near(edges[1] - edges[0], 1e-3, 1e-7, "période");
});

test("2N2222A : gain dans la plage de la fiche (100 à 300 à 150 mA) et VBE(sat) 0,6 à 1,2 V", () => {
  // Base alimentée par une source de courant, collecteur à 10 V : régime linéaire.
  const r = solveDC(3, [el("dc", { V: 10 }, [1, 0]), el("isource", { I: 0.75e-3 }, [0, 2]), el("bjt", { model: "2N2222A" }, [2, 1, 0])]);
  const q = r.results[2];
  assert.ok(q.Ic / q.Ib >= 100 && q.Ic / q.Ib <= 300, `hFE = ${q.Ic / q.Ib}`);
  near(q.Ic, 0.15, 0.002, "IC");
  assert.ok(q.Vbe > 0.6 && q.Vbe < 1.2, `VBE = ${q.Vbe}`);
});

test("2N3904 en commutation : saturé, VCE(sat) ≤ 0,2 V à 10 mA / 1 mA", () => {
  const r = solveDC(4, [el("dc", { V: 5 }, [1, 0]), el("resistor", { R: 470 }, [1, 2]), el("isource", { I: 1e-3 }, [0, 3]), el("bjt", { model: "2N3904" }, [3, 2, 0])]);
  const q = r.results[3];
  assert.ok(q.Vce > 0 && q.Vce <= 0.2, `VCE(sat) = ${q.Vce}`);
  assert.ok(q.Vbe >= 0.65 && q.Vbe <= 0.85, `VBE(sat) = ${q.Vbe}`);
});

test("2N3906 (PNP) : conduit quand la base est tirée sous l'émetteur", () => {
  // Émetteur au +5 V, charge 470 Ω entre collecteur et masse, base tirée à la masse par 4,7 kΩ.
  const r = solveDC(4, [el("dc", { V: 5 }, [1, 0]), el("resistor", { R: 4700 }, [2, 0]), el("resistor", { R: 470 }, [3, 0]), el("bjt", { model: "2N3906" }, [2, 3, 1])]);
  const q = r.results[3];
  assert.ok(q.Ic < -0.009, `IC = ${q.Ic}`);
  assert.ok(r.v(3) > 4.7, `tension sur la charge = ${r.v(3)}`);
});

test("2N7000 : RDS(on) 1,2 Ω à VGS = 10 V et 1,8 Ω à 4,5 V (typiques ON Semi)", () => {
  const rds = (vgs, id) => {
    const r = solveDC(3, [el("dc", { V: vgs }, [1, 0]), el("isource", { I: id }, [0, 2]), el("mosfet", { model: "2N7000" }, [1, 2, 0])]);
    return r.v(2) / id;
  };
  near(rds(10, 0.5), 1.2, 0.08, "RDS(on) à 10 V");
  near(rds(4.5, 0.075), 1.8, 0.1, "RDS(on) à 4,5 V");
});

test("2N7000 : bloqué sous le seuil, la diode de corps conduit en inverse", () => {
  const off = solveDC(3, [el("dc", { V: 5 }, [1, 0]), el("resistor", { R: 1000 }, [1, 2]), el("mosfet", { model: "2N7000" }, [0, 2, 0])]);
  near(off.v(2), 5, 0.01, "drain bloqué");
  const rev = solveDC(2, [el("isource", { I: 0.1 }, [1, 0]), el("mosfet", { model: "2N7000" }, [0, 1, 0])]);
  assert.ok(rev.v(1) < -0.5 && rev.v(1) > -1.2, `VSD = ${-rev.v(1)}`);
});

test("IRLZ44N : RDS(on) ≤ 22 mΩ à 10 V et ≤ 25 mΩ à 5 V ; IRF9540N (canal P) ≤ 117 mΩ à −10 V", () => {
  const rds = (vgs) => solveDC(3, [el("dc", { V: vgs }, [1, 0]), el("isource", { I: 5 }, [0, 2]), el("mosfet", { model: "IRLZ44N" }, [1, 2, 0])]).v(2) / 5;
  assert.ok(rds(10) <= 0.0221 && rds(10) > 0.015, `à 10 V : ${rds(10)}`);
  assert.ok(rds(5) <= 0.0251 && rds(5) > 0.02, `à 5 V : ${rds(5)}`);
  // Canal P : source au +12 V, grille à 2 V (VGS = −10 V), on tire 5 A du drain.
  const p = solveDC(4, [el("dc", { V: 12 }, [1, 0]), el("dc", { V: 2 }, [2, 0]), el("isource", { I: 11 }, [3, 0]), el("mosfet", { model: "IRF9540N" }, [2, 3, 1])]);
  const r = (12 - p.v(3)) / 11;
  assert.ok(r <= 0.1171 && r > 0.1, `RDS(on) canal P : ${r}`);
});

// Ampli-op : noeuds [in+, in−, out, V+, V−].
test("LM358 suiveur : recopie l'entrée à la tension de décalage près, sature à VCC − 1,5 V", () => {
  const mk = (vin) => solveDC(4, [el("dc", { V: 5 }, [1, 0]), el("dc", { V: vin }, [2, 0]), el("opamp", { model: "LM358" }, [2, 3, 3, 1, 0]), el("resistor", { R: 10e3 }, [3, 0])]);
  near(mk(2).v(3), 2.002, 0.0005, "suiveur (2 V + 2 mV de décalage)");
  near(mk(4.5).v(3), 3.5 * 10e3 / 10.1e3, 0.005, "saturation haute (VCC − 1,5 V, moins la chute dans ~100 Ω de sortie)");
  near(mk(0).v(3), 0.005, 0.004, "saturation basse (5 mV)");
});

test("µA741 non inverseur de gain 11 sous ±15 V, excursion ±14 V", () => {
  const mk = (vin) => solveDC(6, [el("dc", { V: 15 }, [1, 0]), el("dc", { V: 15 }, [0, 2]), el("dc", { V: vin }, [3, 0]),
    el("opamp", { model: "uA741" }, [3, 4, 5, 1, 2]), el("resistor", { R: 10e3 }, [5, 4]), el("resistor", { R: 1e3 }, [4, 0])]);
  near(mk(0.5).v(5), 11 * 0.501, 0.01, "gain 11");
  near(mk(-0.5).v(5), 11 * -0.499, 0.01, "gain 11 (négatif)");
  // Charge totale 11 kΩ, résistance de sortie 75 Ω : ±13,9 V (fiche : ±14 V typ. sur 10 kΩ, ±13 V sur 2 kΩ).
  near(mk(2).v(5), 14 * 11e3 / 11.075e3, 0.02, "saturation haute");
  near(mk(-2).v(5), -14 * 11e3 / 11.075e3, 0.02, "saturation basse");
});

test("MCP6002 : sortie rail à rail (25 mV) et limitation de courant à 23 mA", () => {
  const sat = solveDC(4, [el("dc", { V: 5 }, [1, 0]), el("dc", { V: 3 }, [2, 0]), el("opamp", { model: "MCP6002" }, [2, 0, 3, 1, 0]), el("resistor", { R: 1e6 }, [3, 0])]);
  near(sat.v(3), 4.975, 0.003, "saturation haute");
  const sc = solveDC(4, [el("dc", { V: 5 }, [1, 0]), el("dc", { V: 3 }, [2, 0]), el("opamp", { model: "MCP6002" }, [2, 0, 3, 1, 0]), el("resistor", { R: 10 }, [3, 0])]);
  near(sc.results[2].Iout, 0.023, 1e-4, "courant de court-circuit");
  near(sc.results[0].I, 0.023 + 0.1e-3, 1e-4, "le courant de sortie vient de l'alimentation");
});

test("LM358 : slew rate 0,6 V/µs sur un échelon", () => {
  const b = bench().add("v", "dc", { V: 12 }).add("g", "funcgen", { wave: "clock", f: 10e3, A: 5 }).add("u", "opamp", { model: "LM358" }).add("r", "resistor", { R: 10e3 })
    .net("v.+", "u.V+").net("v.-", "u.V-", "g.-", "r.2").net("g.+", "u.IN+").net("u.OUT", "u.IN-", "r.1");
  const sim = b.sim();
  sim.advance(100.2e-6); // juste après le front montant à t = 100 µs
  const rec = record(sim, "u", "Vout", 108e-6);
  const t1 = risingEdges(rec, 1)[0], t4 = risingEdges(rec, 4)[0];
  near(3 / (t4 - t1), 0.6e6, 0.03e6, "pente (V/s)");
});

test("TL072 : gain −10 à 1 kHz, bande passante limitée par le produit gain-bande (3 MHz)", () => {
  const mk = (f) => {
    const b = bench().add("vp", "dc", { V: 12 }).add("vn", "dc", { V: 12 }).add("g", "funcgen", { wave: "sine", f, A: 0.1 }).add("u", "opamp", { model: "TL072" })
      .add("ri", "resistor", { R: 1e3 }).add("rf", "resistor", { R: 10e3 })
      .net("vp.+", "u.V+").net("vn.-", "u.V-").net("vp.-", "vn.+", "g.-", "u.IN+").net("g.+", "ri.1").net("ri.2", "u.IN-", "rf.1").net("rf.2", "u.OUT");
    const sim = b.sim();
    sim.advance(3 / f);
    const rec = record(sim, "u", "Vout", 5 / f);
    return (Math.max(...rec.vs) - Math.min(...rec.vs)) / 2;
  };
  // L'amplitude vue par l'ampli : 0,1 V à vide derrière 50 Ω + 1 kΩ -> gain réel 10·1000/1050.
  near(mk(1000), 0.1 * 10e3 / 1050, 0.01, "amplitude à 1 kHz");
  // Gain de bruit 10,5 → coupure à 3 MHz / 10,5 ≈ 285 kHz : à cette fréquence, −3 dB.
  near(mk(285e3) / (0.1 * 10e3 / 1050), Math.SQRT1_2, 0.06, "atténuation à la coupure");
});

test("LM393 : collecteur ouvert, VOL = 150 mV à 4 mA", () => {
  const mk = (vp, vn) => simulate(bench().add("v", "dc", { V: 5 }).add("a", "dc", { V: vp }).add("b", "dc", { V: vn }).add("u", "comparator").add("r", "resistor", { R: (5 - 0.15) / 0.004 })
    .net("v.+", "u.V+", "r.1").net("v.-", "u.GND", "a.-", "b.-").net("a.+", "u.IN+").net("b.+", "u.IN-").net("r.2", "u.OUT").circuit);
  near(mk(1, 2).comps.get("u").avg.Vout, 0.15, 0.002, "sortie basse");
  near(mk(2, 1).comps.get("u").avg.Vout, 5, 0.01, "sortie en l'air, tirée au +");
});

test("NE555 astable : f = 1,44 / ((RA + 2·RB)·C) et rapport cyclique (RA + RB)/(RA + 2·RB)", () => {
  const RA = 1e3, RB = 10e3, C = 100e-9;
  const b = bench().add("v", "dc", { V: 9 }).add("u", "ne555").add("ra", "resistor", { R: RA }).add("rb", "resistor", { R: RB }).add("c", "capacitor", { C })
    .net("v.+", "u.VCC", "u.RESET", "ra.1").net("ra.2", "u.DISCH", "rb.1").net("rb.2", "u.THR", "u.TRIG", "c.1").net("c.2", "u.GND", "v.-");
  const sim = b.sim();
  const rec = record(sim, "u", "Vout", 12e-3);
  const up = risingEdges(rec, 4);
  assert.ok(up.length >= 5, `fronts : ${up.length}`);
  const T = up[up.length - 1] - up[up.length - 2];
  // Formule exacte : T = ln(2)·(RA + 2·RB)·C. La résistance du transistor de décharge (10 Ω) allonge un peu le temps bas.
  // Temps haut : ln(2)·(RA + RB)·C. Temps bas : la décharge vise la tension de saturation du transistor
  // de décharge (10 Ω parcourus par le courant de RA), d'où un temps bas un peu plus long que ln(2)·RB·C.
  const vd = 9 * 10 / (RA + 10);
  const tHigh = Math.LN2 * (RA + RB) * C, tLow = Math.log((6 - vd) / (3 - vd)) * (RB + 10) * C;
  near(T, tHigh + tLow, 0.004 * T, "période");
  near(1 / T, 1.44 / ((RA + 2 * RB) * C), 15, "formule usuelle de la fiche (686 Hz) à 2 % près");
  const down = rec.ts.filter((t, i) => i > 0 && rec.vs[i - 1] >= 4 && rec.vs[i] < 4 && t > up[up.length - 2])[0];
  near(down - up[up.length - 2], tHigh, 0.004 * tHigh, "temps haut");
  near(sim.instant("u").Vctl, 6, 0.01, "CTRL = 2/3 VCC");
});

test("NE555 : sortie haute à VCC − 1,7 V sous 100 mA, basse à 0,1 V sous 10 mA", () => {
  // TRIG à la masse -> sortie haute ; charge qui tire 100 mA.
  const hi = solveDC(4, [el("dc", { V: 5 }, [1, 0]), el("ne555", {}, [0, 0, 2, 1, 3, 0, 0, 1]), el("isource", { I: 0.1 }, [2, 0])]);
  near(hi.v(2), 3.3, 0.02, "VOH à 100 mA");
  // TRIG et THR au + -> sortie basse ; on injecte 10 mA.
  const lo = solveDC(4, [el("dc", { V: 5 }, [1, 0]), el("ne555", {}, [0, 1, 2, 1, 3, 1, 0, 1]), el("isource", { I: 0.01 }, [0, 2])]);
  near(lo.v(2), 0.1, 0.01, "VOL à 10 mA");
  near(hi.results[0].I, 0.1 + 5 / 1600, 0.001, "courant d'alimentation : charge + 3 mA");
});

test("L7805 : 5 V régulés, déchet de 2 V, limitation de courant", () => {
  const mk = (vin, rl) => solveDC(3, [el("dc", { V: vin }, [1, 0]), el("vreg", { model: "L7805" }, [1, 0, 2]), el("resistor", { R: rl, Pmax: 2 }, [2, 0])]);
  near(mk(12, 100).v(2), 5, 1e-6, "régulation");
  near(mk(12, 100).results[0].I, 0.05 + 4.2e-3, 1e-5, "courant d'entrée = charge + repos");
  near(mk(6, 100).v(2), 4, 1e-3, "déchet : VOUT = VIN − 2 V");
  near(mk(12, 1).results[1].I, 2.2, 1e-3, "limitation 2,2 A");
});

test("AMS1117-3.3 : régule dès 4,4 V d'entrée", () => {
  const mk = (vin) => solveDC(3, [el("dc", { V: vin }, [1, 0]), el("vreg", { model: "AMS1117-3.3" }, [1, 0, 2]), el("resistor", { R: 33 }, [2, 0])]);
  near(mk(5).v(2), 3.3, 1e-6, "sous 5 V");
  near(mk(4).v(2), 2.9, 1e-3, "sous 4 V : déchet de 1,1 V");
});

test("LM317 : VOUT = 1,25·(1 + R2/R1) + Iadj·R2", () => {
  const R1 = 240, R2 = 720;
  const r = solveDC(4, [el("dc", { V: 12 }, [1, 0]), el("vreg", { model: "LM317" }, [1, 3, 2]), el("resistor", { R: R1 }, [2, 3]), el("resistor", { R: R2 }, [3, 0])]);
  near(r.v(2), 1.25 * (1 + R2 / R1) + 50e-6 * R2, 1e-4, "tension de sortie");
});

// Logique : montage sur alimentation 5 V, entrées pilotées par des sources.
function logicBench(type, inputs) {
  const b = bench().add("v", "dc", { V: 5 }).add("u", type).net("v.+", "u.VCC").net("v.-", "u.GND");
  const lo = ["v.-"], hi = ["v.+"];
  for (const [pin, level] of Object.entries(inputs)) (level ? hi : lo).push(`u.${pin}`);
  if (hi.length > 1) b.net(...hi);
  if (lo.length > 1) b.net(...lo);
  return b;
}
const pinV = (res, def, name) => res.comps.get("u").avg[`V${def.pins.findIndex((p) => p.name.replace("~", "") === name || p.name === name) + 1}`];

test("portes 74HC : tables de vérité", () => {
  const tables = { "74hc00": [1, 1, 1, 0], "74hc02": [1, 0, 0, 0], "74hc08": [0, 0, 0, 1], "74hc32": [0, 1, 1, 1], "74hc86": [0, 1, 1, 0] };
  for (const [type, table] of Object.entries(tables)) {
    for (const [i, expected] of table.entries()) {
      const a = i & 1, bb = i >> 1;
      const res = simulate(logicBench(type, { "1A": a, "1B": bb, "2A": 0, "2B": 0, "3A": 0, "3B": 0, "4A": 0, "4B": 0 }).circuit);
      assert.ok(res.ok);
      near(pinV(res, REGISTRY[type], "1Y"), expected ? 5 : 0, 0.01, `${type} A=${a} B=${bb}`);
    }
  }
  const inv = simulate(logicBench("74hc04", { "1A": 1, "2A": 0, "3A": 0, "4A": 0, "5A": 0, "6A": 0 }).circuit);
  near(pinV(inv, REGISTRY["74hc04"], "1Y"), 0, 0.01, "NON 1");
  near(pinV(inv, REGISTRY["74hc04"], "2Y"), 5, 0.01, "NON 0");
});

test("74HC : VOH = 4,32 V à −4 mA et VOL = 0,15 V à 4 mA sous 4,5 V (Nexperia, typ.)", () => {
  // Noeuds DIP-14 : 1A=1B=0 -> 1Y haut (noeud 3). 2A=2B=VCC -> 2Y bas (noeud 4).
  const r = solveDC(5, [el("dc", { V: 4.5 }, [1, 0]), el("74hc00", {}, [0, 0, 3, 1, 1, 4, 0, 2, 0, 0, 2, 0, 0, 1]), el("isource", { I: 0.004 }, [3, 0]), el("isource", { I: 0.004 }, [0, 4])]);
  near(r.v(3), 4.32, 0.005, "VOH");
  near(r.v(4), 0.15, 0.005, "VOL");
});

test("74HC14 : trigger de Schmitt, oscillateur RC", () => {
  const b = bench().add("v", "dc", { V: 5 }).add("u", "74hc14").add("r", "resistor", { R: 10e3 }).add("c", "capacitor", { C: 100e-9 })
    .net("v.+", "u.VCC").net("v.-", "u.GND", "c.2", "u.2A", "u.3A", "u.4A", "u.5A", "u.6A").net("u.1Y", "r.1").net("r.2", "u.1A", "c.1");
  const sim = b.sim();
  const rec = record(sim, "c", "V", 10e-3);
  const tail = rec.vs.slice(Math.floor(rec.vs.length / 2));
  near(Math.max(...tail), 0.53 * 5, 0.03, "seuil haut");
  near(Math.min(...tail), 0.31 * 5, 0.03, "seuil bas");
  const def = REGISTRY["74hc14"];
  const out = record(sim, "u", "V2", 20e-3);
  const e = risingEdges(out, 2.5);
  // T = RC·ln((VCC−VT−)/(VCC−VT+)) + RC·ln(VT+/VT−), avec ~40 Ω de sortie en plus des 10 kΩ.
  const T = 10040 * 100e-9 * (Math.log((1 - 0.31) / (1 - 0.53)) + Math.log(0.53 / 0.31));
  near(e[e.length - 1] - e[e.length - 2], T, T * 0.01, "période");
  assert.ok(def);
});

// Horloge logique appliquée par un générateur, lecture des sorties après n fronts.
function clocked(type, extra, wire) {
  const b = bench().add("v", "dc", { V: 5 }).add("u", type).add("g", "funcgen", { wave: "clock", f: 1000, A: 5, ...extra }).net("v.+", "u.VCC");
  wire(b);
  return b.sim();
}
const logicOut = (sim, type, name) => sim.instant("u")[`V${REGISTRY[type].pins.findIndex((p) => p.name === name) + 1}`] > 2.5 ? 1 : 0;

test("74HC4017 : la sortie active avance à chaque front montant", () => {
  const sim = clocked("74hc4017", {}, (b) => b.net("v.-", "u.GND", "g.-", "u.~CE", "u.MR").net("g.+", "u.CLK"));
  // Générateur : front montant à t = 0, 1 ms, 2 ms… Le premier (mise sous tension) ne compte pas.
  for (let n = 0; n < 12; n++) {
    sim.advance(n * 1e-3 + 0.7e-3);
    for (let k = 0; k < 10; k++) assert.equal(logicOut(sim, "74hc4017", `Q${k}`), k === n % 10 ? 1 : 0, `t = ${n} ms, Q${k}`);
    assert.equal(logicOut(sim, "74hc4017", "CO"), n % 10 < 5 ? 1 : 0, "CO");
  }
});

test("74HC161 : compte en binaire de 0 à 15 puis reboucle, RCO à 15", () => {
  const sim = clocked("74hc161", {}, (b) => b.net("v.-", "u.GND", "g.-", "u.A", "u.B", "u.C", "u.D").net("v.+", "u.~CLR", "u.~LOAD", "u.ENP", "u.ENT").net("g.+", "u.CLK"));
  for (let n = 0; n < 18; n++) {
    sim.advance(n * 1e-3 + 0.7e-3);
    const val = ["QA", "QB", "QC", "QD"].reduce((s, q, i) => s | (logicOut(sim, "74hc161", q) << i), 0);
    assert.equal(val, n % 16, `t = ${n} ms`);
    assert.equal(logicOut(sim, "74hc161", "RCO"), n % 16 === 15 ? 1 : 0);
  }
});

test("74HC74 : diviseur de fréquence par 2 (Q̅ rebouclée sur D)", () => {
  const sim = clocked("74hc74", {}, (b) => b.net("v.-", "u.GND", "g.-", "u.2D", "u.2CLK").net("v.+", "u.~1PRE", "u.~1CLR", "u.~2PRE", "u.~2CLR").net("g.+", "u.1CLK").net("u.~1Q", "u.1D"));
  const rec = record(sim, "u", "V5", 10.5e-3); // broche 5 = 1Q
  const e = risingEdges(rec, 2.5);
  near(e[2] - e[1], 2e-3, 1e-6, "période de Q = 2 périodes d'horloge");
});

test("74HC595 : décalage série puis recopie sur les sorties", () => {
  // SER à 1 en permanence : après n fronts de SRCLK le registre contient n bits à 1 ; RCLK = horloge inversée.
  const b = bench().add("v", "dc", { V: 5 }).add("u", "74hc595").add("g", "funcgen", { wave: "clock", f: 1000, A: 5 }).add("inv", "74hc04")
    .net("v.+", "u.VCC", "inv.VCC", "u.SER", "u.~SRCLR").net("v.-", "u.GND", "inv.GND", "g.-", "u.~OE", "inv.2A", "inv.3A", "inv.4A", "inv.5A", "inv.6A")
    .net("g.+", "u.SRCLK", "inv.1A").net("inv.1Y", "u.RCLK");
  const sim = b.sim();
  sim.advance(3.2e-3); // fronts SRCLK à 1, 2, 3 ms ; RCLK monte à 0,5 ms, 1,5 ms, 2,5 ms
  assert.deepEqual(["QA", "QB", "QC", "QD"].map((q) => logicOut(sim, "74hc595", q)), [1, 1, 0, 0]);
  sim.advance(3.7e-3);
  assert.deepEqual(["QA", "QB", "QC", "QD"].map((q) => logicOut(sim, "74hc595", q)), [1, 1, 1, 0]);
});

test("74HC138 et 74HC4511 : décodage", () => {
  const d = simulate(logicBench("74hc138", { A: 1, B: 0, C: 1, G1: 1, G2A: 0, G2B: 0 }).circuit);
  for (let k = 0; k < 8; k++) near(pinV(d, REGISTRY["74hc138"], `Y${k}`), k === 5 ? 0 : 5, 0.01, `Y${k}`);
  const seg = (n) => {
    const r = simulate(logicBench("74hc4511", { A: n & 1, B: (n >> 1) & 1, C: (n >> 2) & 1, D: (n >> 3) & 1, LE: 0, LT: 1, BL: 1 }).circuit);
    return "abcdefg".split("").filter((s) => pinV(r, REGISTRY["74hc4511"], s) > 2.5).join("");
  };
  assert.equal(seg(0), "abcdef");
  assert.equal(seg(1), "bc");
  assert.equal(seg(7), "abc");
  assert.equal(seg(8), "abcdefg");
  assert.equal(seg(12), "");
});

test("afficheur 7 segments : VF = 2,0 V à 20 mA par segment, grille sans résistance", () => {
  // Noeuds : a..g, dp, COM. Segment a alimenté à 20 mA, COM à la masse.
  const r = solveDC(2, [el("isource", { I: 0.02 }, [0, 1]), el("sevenseg", {}, [1, 0, 0, 0, 0, 0, 0, 0, 0])]);
  near(r.v(1), 2.0, 0.01, "VF segment a");
  const b = bench().add("v", "dc", { V: 5 }).add("d", "sevenseg").net("v.+", "d.a").net("v.-", "d.COM");
  simulate(b.circuit);
  assert.match(b.comp("d").damaged, /grillé/);
});

test("capteurs : CTN 10 kΩ à 25 °C, LDR 12 kΩ à 10 lux, TMP36 750 mV à 25 °C, LM35 250 mV", () => {
  near(REGISTRY.ntc.R({ params: { T: 25 } }), 10e3, 1, "CTN à 25 °C");
  near(REGISTRY.ntc.R({ params: { T: 85 } }), 10e3 * Math.exp(3977 * (1 / 358.15 - 1 / 298.15)), 1, "CTN à 85 °C (1,07 kΩ)");
  near(REGISTRY.ldr.R({ params: { lux: 10 } }), 12e3, 1, "LDR à 10 lux");
  const t = (model, T, vs = 5) => solveDC(3, [el("dc", { V: vs }, [1, 0]), el("tempic", { model, T }, [1, 2, 0]), el("resistor", { R: 100e3 }, [2, 0])]).v(2);
  near(t("TMP36", 25), 0.75, 0.001, "TMP36");
  near(t("TMP36", -10), 0.4, 0.001, "TMP36 à −10 °C");
  near(t("LM35", 25), 0.25, 0.001, "LM35");
  near(t("LM35", 25, 3), 0, 0.001, "LM35 sous-alimenté");
});

test("relais 5 V : colle à 75 % de la tension nominale, décolle à 10 %", () => {
  const b = bench().add("v", "dc", { V: 5 }).add("k", "relay").add("p", "dc", { V: 12 }).add("r", "resistor", { R: 1000, Pmax: 1 })
    .net("v.+", "k.A1").net("v.-", "k.A2").net("p.+", "k.COM").net("k.NO", "r.1").net("r.2", "p.-");
  const on = simulate(b.circuit);
  near(on.comps.get("r").avg.I, 0.012, 1e-4, "charge alimentée par le contact NO");
  near(on.comps.get("k").avg.Icoil, 5 / 70, 1e-4, "courant de bobine 71 mA");
  b.comp("v").params.V = 3; // sous le seuil de collage, mais au-dessus du décollage : reste collé
  near(simulate(b.circuit).comps.get("r").avg.I, 0.012, 1e-4, "hystérésis");
  b.comp("v").params.V = 0.3;
  near(simulate(b.circuit).comps.get("r").avg.I, 0, 1e-6, "décollé");
});

test("voltmètre 10 MΩ : charge un pont à haute impédance ; ampèremètre : shunt 0,1 Ω, fusible 10 A", () => {
  const r = solveDC(3, [el("dc", { V: 10 }, [1, 0]), el("resistor", { R: 10e6 }, [1, 2]), el("resistor", { R: 10e6 }, [2, 0]), el("voltmeter", {}, [2, 0])]);
  near(r.v(2), 10 / 3, 1e-4, "lecture faussée par l'impédance d'entrée");
  const b = bench().add("v", "dc", { V: 5 }).add("a", "ammeter").add("r", "resistor", { R: 100 }).net("v.+", "a.A").net("a.COM", "r.1").net("r.2", "v.-");
  const res = simulate(b.circuit);
  near(res.comps.get("a").avg.I, 5 / 100.1, 1e-6, "courant mesuré");
  const short = bench().add("v", "dc", { V: 5 }).add("a", "ammeter").net("v.+", "a.A").net("v.-", "a.COM");
  simulate(short.circuit);
  assert.match(short.comp("a").damaged, /Fusible/);
});

test("multimètre : ohmmètre et test de diode", () => {
  const ohm = bench().add("m", "multimeter", { mode: "ohm" }).add("r", "resistor", { R: 4700 }).net("m.V", "r.1").net("m.COM", "r.2");
  assert.match(simulate(ohm.circuit).comps.get("m").info.readings[0][1], /^4[.,]7 kΩ$/);
  const open = bench().add("m", "multimeter", { mode: "ohm" });
  assert.equal(simulate(open.circuit).comps.get("m").info.readings[0][1], "O.L");
  const d = bench().add("m", "multimeter", { mode: "diode" }).add("d", "diode", { model: "1N4148" }).net("m.V", "d.A").net("m.COM", "d.K");
  const v = simulate(d.circuit).comps.get("m").avg.V;
  assert.ok(v > 0.55 && v < 0.7, `tension directe lue : ${v}`);
});

test("voltmètre en alternatif : valeur efficace d'un sinus = crête / √2", () => {
  const b = bench().add("g", "funcgen", { wave: "sine", f: 50, A: 10, offset: 3 }).add("m", "voltmeter", { mode: "ac" }).net("g.+", "m.V").net("g.-", "m.COM");
  const sim = b.sim();
  sim.tau = 0.2;
  sim.advance(2);
  const res = sim.frame();
  near(REGISTRY.voltmeter.value(b.comp("m"), res.comps.get("m").avg), 10 / Math.SQRT2, 0.15, "efficace AC");
  near(res.comps.get("m").avg.V, 3, 0.2, "composante continue");
});

test("ESP32 : PWM temporelle à 1 kHz, rapport cyclique respecté", () => {
  const b = bench().add("e", "esp32").add("r", "resistor", { R: 10e3 }).net("e.IO2", "r.1").net("e.GND", "r.2");
  b.comp("e").rt = { pins: { 2: { mode: "PWM", duty: 0.25 } } };
  const sim = b.sim();
  const rec = record(sim, "r", "V", 5e-3);
  const up = risingEdges(rec, 1.65);
  near(up[2] - up[1], 1e-3, 1e-7, "période");
  sim.advance(0.3);
  near(sim.frame().comps.get("r").avg.V, 0.25 * 3.3 * 10e3 / (10e3 + 33), 0.02, "tension moyenne");
});

test("une broche posée sur un fil y est connectée", () => {
  const circuit = {
    components: [{ id: "v", type: "dc", x: 0, y: 0, rot: 0, params: { V: 5 } }, { id: "r", type: "resistor", x: 0, y: 4, rot: 0, params: { R: 100, Pmax: 1 } }],
    // Un seul long fil vertical passe sur la broche + de la source (0,0) et finit sur r.1 ; idem côté −.
    wires: [{ id: "a", x1: 0, y1: -3, x2: 0, y2: 4 }, { id: "b", x1: 4, y1: -3, x2: 4, y2: 4 }],
  };
  near(simulate(circuit).comps.get("r").avg.I, 0.05, 1e-9, "courant");
});
