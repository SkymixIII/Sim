// Analyse transitoire : solutions analytiques, codeur/décodeur LTC, et
// comparaison avec les simulations ngspice du boîtier timecode
// (projets/timecode-ltc/sim/*/resultats.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { solveTransient, solveDC } from "../src/engine/solver.js";
import { REGISTRY, defaultParams } from "../src/components/index.js";
import { LTC_RATES, ltcEdges, decodeEdges, tcAdd, fmtTc, crossings } from "../src/engine/ltc.js";
import { measureTrace } from "../src/engine/measure.js";

const el = (type, params, nodes) => {
  const def = REGISTRY[type];
  return { def, inst: { id: `${type}${Math.random()}`, type, params: { ...defaultParams(def), ...params } }, nodes };
};
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} attendu ${expected} ± ${tol}`);
const ngspice = (bloc) => JSON.parse(readFileSync(new URL(`../projets/timecode-ltc/sim/${bloc}/resultats.json`, import.meta.url)));

test("RC : charge d'un condensateur, erreur < 0,1 % sur l'exponentielle", () => {
  // Carré 0/1 V à 100 Hz (front 1 ns) sur 1 kΩ + 1 µF : τ = 1 ms
  const els = [
    el("siggen", { shape: "square", Vpp: 1, offset: 0.5, Rout: 1000, freq: 100, rise: 1e-9 }, [1, 0]),
    el("capacitor", { C: 1e-6 }, [1, 0]),
  ];
  // Point initial : générateur à sa moyenne 0,5 V ; on part donc de 0,5 V.
  const r = solveTransient(2, els, { tstop: 4.9e-3, dt: 5e-6, record: [1] });
  assert.ok(r.ok, r.error);
  const v = r.traces.get(1);
  for (const tm of [0.5e-3, 1e-3, 2e-3, 4e-3]) {
    const k = Math.round(tm / 5e-6);
    near(v[k], 1 - 0.5 * Math.exp(-tm / 1e-3), 1e-3, `V(${tm * 1e3} ms)`);
  }
});

test("Condensateur en DC : circuit ouvert", () => {
  const r = solveDC(3, [el("dc", { V: 5 }, [1, 0]), el("resistor", { R: 1e3 }, [1, 2]), el("capacitor", { C: 1e-6 }, [2, 0])]);
  near(r.v(2), 5, 1e-6, "tension aux bornes");
});

test("LTC : codage puis décodage exact à toutes les cadences, drop-frame compris", () => {
  for (const rate of Object.keys(LTC_RATES)) {
    const { nominal, drop } = LTC_RATES[rate];
    const tc0 = drop ? [10, 9, 59, 27] : [1, 2, 3, 4];
    const { edges, tcs } = ltcEdges(tc0, 6, rate);
    const fr = decodeEdges(edges.map((e, i) => e + 3e-6 * Math.sin(i * 1.7))); // 3 µs de gigue
    assert.ok(fr.length >= 5, `${rate} : ${fr.length} images`);
    fr.forEach((f, i) => assert.deepEqual(f.tc, tcs[i], `${rate} image ${i}`));
    assert.ok(fr.every((f) => f.evenZeros), `${rate} : parité`);
    assert.equal(fr[0].drop, drop ? 1 : 0);
  }
  assert.deepEqual(tcAdd([0, 0, 59, 29], 1, 30, true), [0, 1, 0, 2]);
  assert.deepEqual(tcAdd([0, 9, 59, 29], 1, 30, true), [0, 10, 0, 0]);
});

// ---------------- Boîtier timecode : circuit d'entrée (mode TX) ----------------
// Mêmes valeurs que projets/timecode-ltc/design.py (C3 = 8 µF effectifs, comme dans la simulation ngspice).
const N = { bnc: 1, in_ac: 2, in_a: 3, vmid: 4, inn: 5, inp: 6, out: 7, gpio: 8, v3: 9 };
function entree(src) {
  return [
    el("dc", { V: 3.3 }, [N.v3, 0]),
    el("siggen", src, [N.bnc, 0]),
    el("capacitor", { C: 670e-12 }, [N.bnc, 0]),          // 10 m de RG-59
    el("resistor", { R: 1e6 }, [N.bnc, 0]),               // R1
    el("capacitor", { C: 100e-9 }, [N.bnc, N.in_ac]),     // C1
    el("resistor", { R: 10e3 }, [N.in_ac, N.in_a]),       // R2
    el("diode", { model: "BAT54" }, [0, N.in_a]),         // D2 (bas)
    el("diode", { model: "BAT54" }, [N.in_a, N.v3]),      // D2 (haut)
    el("capacitor", { C: 680e-12 }, [N.in_a, 0]),         // C2
    el("resistor", { R: 100e3 }, [N.in_a, N.vmid]),       // R3
    el("resistor", { R: 1e3 }, [N.in_a, N.inn]),          // R4
    el("resistor", { R: 47e3 }, [N.v3, N.vmid]),          // R5
    el("resistor", { R: 47e3 }, [N.vmid, 0]),             // R6
    el("capacitor", { C: 8e-6 }, [N.vmid, 0]),            // C3
    el("resistor", { R: 10e3 }, [N.vmid, N.inp]),         // R7
    el("resistor", { R: 470e3 }, [N.out, N.inp]),         // R8
    el("tlv3201", { VOS: 1e-3 }, [N.inn, N.inp, N.out, N.v3, 0]),
    el("resistor", { R: 100 }, [N.out, N.gpio]),          // R9
    el("resistor", { R: 1e6 }, [N.gpio, 0]),              // entrée GPIO
  ];
}

const A = ngspice("A_entree").cases;
const ENTREE = [
  ["A1", { Vpp: 1, Rout: 50, rate: "25" }],
  ["A3", { Vpp: 18, Rout: 50, rate: "24" }],
  ["A4", { Vpp: 3, Rout: 1000, rate: "29.97DF", tc: "10:09:59:27" }],
  ["A7", { Vpp: 1, Rout: 50, rate: "25", offset: 5 }],
];
for (const [name, src] of ENTREE) {
  test(`Entrée LTC, cas ${name} : images décodées identiques à ngspice`, (t) => {
    const ref = A.find((c) => c.name === name);
    const p = { shape: "ltc", tc: "12:34:56:00", rise: 25e-6, offset: 0, ...src };
    const { fps } = LTC_RATES[p.rate];
    const tstop = 5 / fps;
    const r = solveTransient(10, entree(p), { tstop, dt: 1e-6, record: [N.gpio, N.inn] });
    assert.ok(r.ok, r.error);
    const m = measureTrace(r.t, r.traces.get(N.gpio), 1 / fps);
    assert.ok(m.ltc, "aucune image décodée");
    const { edges, tcs } = ltcEdges(p.tc.split(":").map(Number), 6, p.rate);
    // toutes les images décodées sont exactes et consécutives
    const i0 = tcs.findIndex((tc) => fmtTc(tc) === fmtTc(m.ltc.frames[0].tc));
    assert.ok(i0 >= 0 && m.ltc.frames.length >= 3, `${m.ltc.frames.length} images`);
    m.ltc.frames.forEach((f, i) => assert.deepEqual(f.tc, tcs[i0 + i]));
    // niveaux logiques, minimum d'IN− et retard comparés à ngspice
    assert.ok(m.hi > 0.75 * 3.3 && m.lo < 0.25 * 3.3, `niveaux ${m.lo} / ${m.hi}`);
    const k0 = Math.round(1 / fps / 1e-6);
    const inn = r.traces.get(N.inn).subarray(k0);
    near(inn.reduce((a, b) => Math.min(a, b)), ref.v_inn_min, 0.1, "IN− min");
    // retard : fronts logiques (seuil VDD/2) contre le milieu des fronts de la source
    const ideal = edges.map((e) => e + p.rise / 0.8 / 2);
    const dig = crossings(r.t, r.traces.get(N.gpio), 1.65).filter((x) => x > 1 / fps);
    const delays = dig.map((x) => ideal.reduce((best, e) => (Math.abs(x - e) < Math.abs(x - best) ? e : best), Infinity)).map((e, i) => dig[i] - e);
    const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
    // le modèle bascule un pas (1 µs) après l'entrée : tolérance 2,5 µs
    t.diagnostic(`${name} : ${m.ltc.frames.length} images, retard ${(mean * 1e6).toFixed(1)} µs (ngspice ${ref.delay_mean_us.toFixed(1)}), IN− min ${inn.reduce((a, b) => Math.min(a, b)).toFixed(2)} V (ngspice ${ref.v_inn_min.toFixed(2)})`);
    near(mean * 1e6, ref.delay_mean_us, 2.5, "retard moyen (µs)");
  });
}

// ---------------- Boîtier timecode : circuit de sortie (mode RX) ----------------
const S = { gpio: 1, sh: 2, opa: 3, p: 4, ac: 5, bnc: 6, far: 7, v3: 8 };
function sortie(rate, rl, cableM) {
  const cab = cableM * 67e-12;
  return [
    el("dc", { V: 3.3 }, [S.v3, 0]),
    // GPIO5 : 0/3,3 V push-pull, 16,5 Ω, fronts de 5 ns
    el("siggen", { shape: "ltc", rate, tc: "12:34:56:00", Vpp: 3.3, offset: 1.65, Rout: 16.5, rise: 5e-9 }, [S.gpio, 0]),
    el("resistor", { R: 10e3 }, [S.gpio, S.sh]),          // R10
    el("resistor", { R: 30e3 }, [S.v3, S.sh]),            // R11
    el("resistor", { R: 30e3 }, [S.sh, 0]),               // R12
    el("capacitor", { C: 1.8e-9 }, [S.sh, 0]),            // C5
    el("tlv9061", {}, [S.opa, S.sh, S.opa, S.v3, 0]),     // suiveur
    el("resistor", { R: 56 }, [S.opa, S.p]),              // R13
    el("diode", { model: "BAT54" }, [0, S.p]),            // D4
    el("diode", { model: "BAT54" }, [S.p, S.v3]),
    el("capacitor", { C: 37e-6 }, [S.p, S.ac]),           // C7 (47 µF X5R, 37 µF effectifs)
    el("capacitor", { C: 37e-6 }, [S.p, S.ac]),           // C8
    el("resistor", { R: 22 }, [S.ac, S.bnc]),             // R14
    el("resistor", { R: 100e3 }, [S.bnc, 0]),             // R15
    el("capacitor", { C: cab / 2 }, [S.bnc, 0]),          // câble
    el("resistor", { R: 0.1 * cableM }, [S.bnc, S.far]),
    el("capacitor", { C: cab / 2 }, [S.far, 0]),
    el("resistor", { R: rl }, [S.far, 0]),                // charge
  ];
}

const B = ngspice("B_sortie").cases;
for (const [name, rate, rl, cable] of [["B2", "25", 75, 1], ["B4", "24", 1e6, 1], ["B5", "29.97DF", 600, 2]]) {
  test(`Sortie LTC, cas ${name} : amplitude et fronts identiques à ngspice`, (t) => {
    const ref = B.find((c) => c.name === name);
    const { fps } = LTC_RATES[rate];
    const r = solveTransient(9, sortie(rate, rl, cable), { tstop: 4 / fps, dt: 1e-6, record: [S.far] });
    assert.ok(r.ok, r.error);
    const m = measureTrace(r.t, r.traces.get(S.far), 1 / fps);
    t.diagnostic(`${name} : ${m.vpp.toFixed(3)} Vcc (ngspice ${ref.vpp.toFixed(3)}), fronts ${(m.rise * 1e6).toFixed(1)} / ${(m.fall * 1e6).toFixed(1)} µs (ngspice ${ref.rise_us.toFixed(1)} / ${ref.fall_us.toFixed(1)})`);
    near(m.vpp, ref.vpp, 0.02 * ref.vpp, "Vcc");
    near(m.rise * 1e6, ref.rise_us, 1.5, "front montant (µs)");
    near(m.fall * 1e6, ref.fall_us, 1.5, "front descendant (µs)");
    assert.ok(m.ltc && m.ltc.frames.length >= 2, "décodage");
    assert.ok(Math.abs(m.mean) < 0.05 * m.vpp, `composante continue ${m.mean}`);
  });
}

test("TLV9061 en court-circuit : limité à 50 mA", () => {
  const r = solveDC(4, [el("dc", { V: 3.3 }, [1, 0]), el("dc", { V: 3 }, [2, 0]), el("tlv9061", {}, [3, 2, 3, 1, 0]), el("resistor", { R: 0.1 }, [3, 0])]);
  assert.ok(r.ok);
  near(r.results[2].Iout, 0.05, 0.002, "courant de sortie");
});

test("TLV3201 : VOL ≤ 230 mV à 4 mA sous 2,7 V (fiche TI)", () => {
  // IN+ < IN− : sortie basse ; 4 mA tirés depuis 2,7 V à travers 600 Ω
  const r = solveDC(5, [el("dc", { V: 2.7 }, [1, 0]), el("dc", { V: 1 }, [2, 0]), el("tlv3201", {}, [2, 0, 3, 1, 0]), el("isource", { I: 4e-3 }, [0, 3])]);
  assert.ok(r.ok);
  assert.ok(r.v(3) <= 0.23 + 1e-3 && r.v(3) > 0.15, `VOL = ${r.v(3)}`);
});
