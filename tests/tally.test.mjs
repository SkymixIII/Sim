// Essai de bout en bout du montage « Tally ATEM 4 lampes » :
// les 6 sketches tournent ensemble, l'ATEM et l'émetteur parlent le protocole ATEM sur le lien RJ45,
// l'émetteur diffuse en ESP-NOW, et on lit le courant réel dans les LED des lampes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../src/runtime/bench.js";
import { REGISTRY } from "../src/components/index.js";
import { tallyCircuit } from "../src/ui/montages/tally.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const circuit = tallyCircuit();
  const serial = [];
  const errors = [];
  const bench = new Bench({
    getCircuit: () => circuit,
    onSerial: (id, line) => serial.push(`[${id}] ${line}`),
    onState: (id, s, msg) => { if (s === "error") errors.push(`${id}: ${msg}`); },
  });
  const ledOn = (id) => {
    bench.resimulate();
    return (bench.sim.comps.get(id)?.avg.I ?? 0) > 0.003; // > 3 mA : nettement allumée
  };
  const lampe = (n) => ({ rouge: ledOn(`lampe${n}_led_rouge`), vert: ledOn(`lampe${n}_led_vert`) });
  const press = async (id) => {
    const c = circuit.components.find((x) => x.id === id);
    REGISTRY.button.press(c, true); bench.resimulate();
    await sleep(120);                       // > anti-rebond de 30 ms
    REGISTRY.button.press(c, false); bench.resimulate();
    await sleep(400);                       // propagation ATEM -> émetteur -> radio (10 Hz)
  };
  // Échantillonne une lampe pendant `ms` et compte les changements d'état de la LED rouge.
  const toggles = async (n, ms) => {
    let last = null, count = 0;
    for (let t = 0; t < ms; t += 50) {
      const r = lampe(n).rouge;
      if (last !== null && r !== last) count++;
      last = r;
      await sleep(50);
    }
    return count;
  };
  return { circuit, bench, serial, errors, lampe, press, toggles, ledOn };
}

test("tally ATEM : programme rouge, preview vert, coupure et perte radio", { timeout: 30000 }, async () => {
  const t = setup();
  t.bench.startAll();
  try {
    await sleep(1500);
    assert.deepEqual(t.errors, [], "aucune erreur de sketch");
    assert.ok(t.serial.some((l) => l.includes("[emetteur] Connecté à l'ATEM")), "l'émetteur se connecte à l'ATEM\n" + t.serial.join("\n"));
    assert.equal(t.ledOn("em_led_statut"), false, "LED statut éteinte quand l'ATEM est connecté");

    // État initial : programme = CAM 1, preview = CAM 2
    assert.deepEqual(t.lampe(1), { rouge: true, vert: false }, "lampe 1 (CAM 1) au programme");
    assert.deepEqual(t.lampe(3), { rouge: true, vert: false }, "lampe 3 (CAM 1) au programme");
    assert.deepEqual(t.lampe(2), { rouge: false, vert: true }, "lampe 2 (CAM 2) en preview");
    assert.deepEqual(t.lampe(4), { rouge: false, vert: true }, "lampe 4 (CAM 2) en preview");

    // Courant réel dans les LED (modèle de Shockley, sortie ESP32 drive 3)
    t.bench.resimulate();
    const iRouge = t.bench.sim.comps.get("lampe1_led_rouge").avg.I;
    const iVert = t.bench.sim.comps.get("lampe2_led_vert").avg.I;
    assert.ok(iRouge > 0.005 && iRouge < 0.02, `courant LED rouge ${iRouge}`);
    assert.ok(iVert > 0.003 && iVert < 0.02, `courant LED verte ${iVert}`);

    // CUT CAM 2 : la 2 passe au programme, la 1 (ancien programme) passe en preview
    await t.press("atem_btn_c2_cut");
    assert.deepEqual(t.lampe(2), { rouge: true, vert: false }, "CAM 2 au programme après CUT");
    assert.deepEqual(t.lampe(1), { rouge: false, vert: true }, "CAM 1 en preview après CUT");

    // PREV CAM 2 alors qu'elle est au programme : rien ne change
    await t.press("atem_btn_c2_pvw");
    assert.deepEqual(t.lampe(2), { rouge: true, vert: false });
    assert.deepEqual(t.lampe(1), { rouge: false, vert: true });

    // Lampe 3 hors de portée : elle seule clignote
    t.circuit.links.find((l) => l.id === "l_radio_3").cut = true;
    await sleep(2300);
    assert.ok(await t.toggles(3, 1000) >= 3, "lampe 3 clignote à 2 Hz");
    assert.deepEqual(t.lampe(1), { rouge: false, vert: true }, "lampe 1 toujours à jour");
    t.circuit.links.find((l) => l.id === "l_radio_3").cut = false;
    await sleep(300);
    assert.deepEqual(t.lampe(3), { rouge: false, vert: true }, "lampe 3 revient en preview");

    // Câble RJ45 débranché : LED statut allumée, toutes les lampes clignotent
    t.circuit.links.find((l) => l.id === "l_eth").cut = true;
    await sleep(2400);
    assert.equal(t.ledOn("em_led_statut"), true, "LED statut allumée sans ATEM");
    assert.ok(await t.toggles(1, 1000) >= 3, "lampe 1 clignote sans ATEM");

    // Rebranché : reconnexion automatique, l'état est retrouvé
    t.circuit.links.find((l) => l.id === "l_eth").cut = false;
    await sleep(1800);
    assert.equal(t.ledOn("em_led_statut"), false, "LED statut éteinte après reconnexion");
    assert.deepEqual(t.lampe(2), { rouge: true, vert: false }, "CAM 2 toujours au programme après reconnexion");
    assert.deepEqual(t.errors, []);
  } finally {
    t.bench.stopAll();
  }
});

test("ESP-NOW : une lampe sur un autre canal ne reçoit rien", { timeout: 10000 }, async () => {
  const t = setup();
  const l4 = t.circuit.components.find((c) => c.id === "lampe4");
  l4.code = l4.code.replace("const int CANAL_ESPNOW = 1;", "const int CANAL_ESPNOW = 6;");
  t.bench.startAll();
  try {
    await sleep(1500);
    assert.ok(await t.toggles(4, 1000) >= 3, "lampe 4 (canal 6) clignote : aucun message reçu");
    assert.deepEqual(t.lampe(2), { rouge: false, vert: true }, "lampe 2 (canal 1) fonctionne");
  } finally {
    t.bench.stopAll();
  }
});
