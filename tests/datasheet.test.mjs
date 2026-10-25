// Vérifie chaque modèle contre des points de sa fiche technique.
// Lancer : node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveDC } from "../src/engine/solver.js";
import { simulate } from "../src/engine/circuit.js";
import { REGISTRY, defaultParams } from "../src/components/index.js";

const el = (type, params, nodes, rt) => {
  const def = REGISTRY[type];
  return { def, inst: { id: `${type}${Math.random()}`, type, params: { ...defaultParams(def), ...params }, rt }, nodes };
};
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} attendu ${expected} ± ${tol}`);

// Force un courant I dans le composant (anode = noeud 1, cathode = masse) et lit la tension.
function vfAt(type, params, I) {
  const r = solveDC(2, [el("isource", { I }, [0, 1]), el(type, params, [1, 0])]);
  assert.ok(r.ok);
  return r.v(1);
}

test("loi d'Ohm : 5 V sur 220 Ω", () => {
  const r = solveDC(2, [el("dc", { V: 5 }, [1, 0]), el("resistor", { R: 220 }, [1, 0])]);
  const res = r.results[1];
  near(res.I, 5 / 220, 1e-9, "courant");
  near(res.P, 25 / 220, 1e-9, "puissance");
});

test("pont diviseur 10k/10k", () => {
  const r = solveDC(3, [el("dc", { V: 9 }, [1, 0]), el("resistor", { R: 1e4 }, [1, 2]), el("resistor", { R: 1e4 }, [2, 0])]);
  near(r.v(2), 4.5, 1e-6, "milieu du pont");
});

test("1N4148 : VF ≤ 1 V à 10 mA (Vishay), ~0,62 V à 1 mA", () => {
  const v10 = vfAt("diode", { model: "1N4148" }, 0.01);
  assert.ok(v10 > 0.6 && v10 <= 1.0, `VF(10 mA) = ${v10}`);
  near(vfAt("diode", { model: "1N4148" }, 0.001), 0.62, 0.05, "VF(1 mA)");
});

test("1N4007 : VF ≤ 1,1 V à 1 A", () => {
  const v = vfAt("diode", { model: "1N4007" }, 1);
  assert.ok(v > 0.7 && v <= 1.1, `VF(1 A) = ${v}`);
});

test("1N5819 Schottky : VF ≤ 0,6 V à 1 A et ≤ 0,34 V à 100 mA (max ON Semi)", () => {
  const v1 = vfAt("diode", { model: "1N5819" }, 1), v01 = vfAt("diode", { model: "1N5819" }, 0.1);
  assert.ok(v1 > 0.3 && v1 <= 0.6, `VF(1 A) = ${v1}`);
  assert.ok(v01 > 0.2 && v01 <= 0.34, `VF(100 mA) = ${v01}`);
});

test("Zener 1N4733A : VZ = 5,1 V ± 5 % à IZT = 49 mA", () => {
  // Courant forcé de la cathode vers l'anode (polarisation inverse).
  const r = solveDC(2, [el("isource", { I: 0.049 }, [0, 1]), el("diode", { model: "1N4733A" }, [0, 1])]);
  near(r.v(1), 5.1, 0.255, "VZ");
});

for (const [color, vf] of [["red", 2.0], ["yellow", 2.1], ["green", 3.1], ["blue", 3.2], ["white", 3.2]]) {
  test(`LED ${color} : VF = ${vf} V à 20 mA`, () => near(vfAt("led", { color }, 0.02), vf, 0.01, "VF"));
}

test("LED rouge + 220 Ω sur 5 V : ~13,5 mA", () => {
  const r = solveDC(3, [el("dc", { V: 5 }, [1, 0]), el("resistor", { R: 220 }, [1, 2]), el("led", { color: "red" }, [2, 0])]);
  near(r.results[2].I, 0.0135, 0.001, "courant LED");
});

test("LED en direct sur une pile 9 V : grillée", () => {
  const circuit = {
    components: [
      { id: "b", type: "battery", x: 0, y: 0, rot: 0, params: { kind: "9v" } },
      { id: "l", type: "led", x: 0, y: 2, rot: 0, params: { color: "red" } },
    ],
    wires: [{ x1: 0, y1: 0, x2: 0, y2: 2 }, { x1: 4, y1: 0, x2: 4, y2: 2 }],
  };
  const r = simulate(circuit);
  assert.ok(r.ok);
  assert.match(circuit.components[1].damaged, /Grillée/);
});

test("ESP32 : sortie HIGH à 20 mA (drive 2) ≥ 0,8·VDD = 2,64 V", () => {
  const rt = { pins: { 2: { mode: "OUTPUT", level: 1 } } };
  // Noeuds : 3V3=1, GND=0, IO34..IO22 = 2..10, GND2=0. GPIO2 est le 5e GPIO (index 4) -> noeud 6.
  const nodes = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0];
  const r = solveDC(11, [el("esp32", {}, nodes, rt), el("isource", { I: 0.02 }, [6, 0])]);
  assert.ok(r.ok);
  near(r.v(6), 2.64, 0.01, "VOH");
});

test("ESP32 : sortie LOW à 14 mA (drive 2) ≤ 0,495 V", () => {
  const rt = { pins: { 2: { mode: "OUTPUT", level: 0 } } };
  const nodes = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0];
  const r = solveDC(11, [el("esp32", {}, nodes, rt), el("isource", { I: 0.014 }, [0, 6])]);
  near(r.v(6), 0.495, 0.01, "VOL");
});

test("ESP32 : pull-up interne 45 kΩ", () => {
  const rt = { pins: { 4: { mode: "INPUT_PULLUP" } } };
  const nodes = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0];
  // GPIO4 est l'index 2 -> noeud 4 ; 45 kΩ externe vers la masse -> moitié de 3,3 V.
  const r = solveDC(11, [el("esp32", {}, nodes, rt), el("resistor", { R: 45e3 }, [4, 0])]);
  near(r.v(4), 1.65, 0.01, "pont pull-up");
});

test("ESP32 : 5 V sur une entrée fait conduire la diode de protection", () => {
  const nodes = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0];
  const r = solveDC(11, [el("esp32", {}, nodes, { pins: {} }), el("dc", { V: 5 }, [11, 0]), el("resistor", { R: 1000 }, [11, 2])]);
  const pinI = r.results[0].I34;
  assert.ok(r.v(2) > 3.6 && r.v(2) < 4.2, `V broche = ${r.v(2)}`);
  assert.ok(pinI < -1e-3, `courant absorbé ${pinI}`);
});

test("PWM 50 % sur LED : courant moyen = moitié du courant à l'état haut", () => {
  const mk = (pins) => ({
    components: [
      { id: "e", type: "esp32", x: 0, y: 0, rot: 0, params: { drive: 2 }, rt: { pins } },
      { id: "r", type: "resistor", x: 10, y: 4, rot: 0, params: { R: 220, Pmax: 0.25 } },
      { id: "l", type: "led", x: 14, y: 4, rot: 0, params: { color: "red" } },
      { id: "g", type: "ground", x: 18, y: 4, rot: 0, params: {} },
    ],
    wires: [{ x1: 10, y1: 9, x2: 18, y2: 4 }],
  });
  const on = simulate(mk({ 2: { mode: "OUTPUT", level: 1 } })).comps.get("l").avg.I;
  const half = simulate(mk({ 2: { mode: "PWM", duty: 0.5 } })).comps.get("l").avg.I;
  near(half, on / 2, 1e-6, "courant moyen");
});

test("îlot sans masse (pile + résistance + LED seules) : simulé avec sa propre référence", () => {
  const circuit = {
    components: [
      { id: "b", type: "battery", x: 0, y: 0, rot: 0, params: { kind: "9v" } },
      { id: "r", type: "resistor", x: 0, y: 2, rot: 0, params: { R: 470, Pmax: 0.25 } },
      { id: "l", type: "led", x: 4, y: 2, rot: 0, params: { color: "green" } },
    ],
    wires: [{ x1: 0, y1: 0, x2: 0, y2: 2 }, { x1: 4, y1: 0, x2: 8, y2: 2 }],
  };
  const r = simulate(circuit);
  assert.ok(r.ok);
  near(r.comps.get("l").avg.I, (9 - 3.0) / (470 + 1.7 + 12), 0.0005, "courant");
});
