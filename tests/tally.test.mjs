// Essai de bout en bout du montage « Tally ATEM 8 caméras » :
// l'ATEM Constellation (appareil réseau) parle le protocole ATEM sur le lien RJ45,
// l'émetteur (sketch ESP32) le lit et diffuse en ESP-NOW, 8 lampes (sketches ESP32)
// pilotent leurs LED, dont on lit le courant réel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bench } from "../src/runtime/bench.js";
import { REGISTRY } from "../src/components/index.js";
import { AtemServer, atemHeader } from "../src/components/atem.js";
import { tallyCircuit } from "../src/ui/montages/tally.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OFF = { rouge: false, vert: false, bleu: false };
const RED = { ...OFF, rouge: true }, GREEN = { ...OFF, vert: true }, BLUE = { ...OFF, bleu: true };

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
    return (bench.sim.comps.get(id)?.avg.I ?? 0) > 0.002; // > 2 mA : nettement allumée
  };
  const lampe = (n) => ({ rouge: ledOn(`lampe${n}_led_rouge`), vert: ledOn(`lampe${n}_led_vert`), bleu: ledOn(`lampe${n}_led_bleu`) });
  const atem = circuit.components.find((c) => c.id === "atem");
  const key = async (k, wait = 400) => { REGISTRY.atem.press(atem, true, k); await sleep(wait); };
  const link = (id) => circuit.links.find((l) => l.id === id);
  return { circuit, bench, serial, errors, lampe, key, link, ledOn, atem };
}

test("tally 8 caméras : PGM rouge, PVW vert, CUT, AUTO, priorité bleu > rouge > vert", { timeout: 40000 }, async () => {
  const t = setup();
  t.bench.startAll();
  try {
    await sleep(1500);
    assert.deepEqual(t.errors, [], "aucune erreur de sketch");
    assert.ok(t.serial.some((l) => l.includes("[emetteur] Connecté à l'ATEM")), t.serial.join("\n"));
    assert.equal(t.atem.rt.clients, 1, "l'ATEM voit un client");
    assert.equal(t.ledOn("em_led_statut"), false, "LED statut éteinte quand l'ATEM est connecté");

    // État initial de l'ATEM : PGM 1, PVW 2
    assert.deepEqual(t.lampe(1), RED);
    assert.deepEqual(t.lampe(2), GREEN);
    for (let n = 3; n <= 8; n++) assert.deepEqual(t.lampe(n), OFF, `lampe ${n} éteinte`);

    // Courants réels (sortie ESP32 drive 3, résistances du montage)
    t.bench.resimulate();
    for (const [id, lo, hi] of [["lampe1_led_rouge", 0.005, 0.02], ["lampe2_led_vert", 0.003, 0.02]]) {
      const i = t.bench.sim.comps.get(id).avg.I;
      assert.ok(i > lo && i < hi, `${id} : ${i} A`);
    }

    // Preview sur la 7, programme direct sur la 8
    await t.key("pvw7");
    assert.deepEqual(t.lampe(7), GREEN); assert.deepEqual(t.lampe(2), OFF);
    await t.key("pgm8");
    assert.deepEqual(t.lampe(8), RED); assert.deepEqual(t.lampe(1), OFF);

    // CUT : 7 au programme, 8 en preview
    await t.key("cut");
    assert.deepEqual(t.lampe(7), RED); assert.deepEqual(t.lampe(8), GREEN);

    // Une caméra à la fois au programme et en preview : rouge seul (rouge > vert)
    await t.key("pvw7");
    assert.deepEqual(t.lampe(7), RED, "programme prioritaire sur preview");
    await t.key("pvw8");

    // AUTO (1 s) : pendant le mix, la 8 entrante passe au rouge avec la 7
    await t.key("auto", 450);
    assert.deepEqual(t.lampe(8), RED, "source entrante au programme pendant l'AUTO");
    assert.deepEqual(t.lampe(7), RED);
    await sleep(1000);
    assert.deepEqual(t.lampe(8), RED, "après l'AUTO");
    assert.deepEqual(t.lampe(7), GREEN);

    // Lampe 3 emportée loin de tout le monde : bleu seul, même au programme (bleu > rouge)
    await t.key("pgm3", 100);
    const n3 = t.circuit.radio.nodes.lampe3, pos = { x: n3.x, y: n3.y };
    Object.assign(n3, { x: 170, y: 0 });
    await sleep(2400);
    assert.deepEqual(t.lampe(3), BLUE, "bleu fixe sans trame");
    assert.deepEqual(t.lampe(7), GREEN, "les autres lampes restent à jour");
    Object.assign(n3, pos);
    await sleep(400);
    assert.deepEqual(t.lampe(3), RED, "retour au rouge");

    // Câble RJ45 débranché : LED statut allumée, lampes en bleu clignotant
    t.link("l_eth").cut = true;
    await sleep(2400);
    assert.equal(t.ledOn("em_led_statut"), true, "LED statut allumée sans ATEM");
    let blues = new Set();
    for (let i = 0; i < 24; i++) { const l = t.lampe(1); assert.ok(!l.rouge && !l.vert); blues.add(l.bleu); await sleep(50); }
    assert.equal(blues.size, 2, "bleu clignotant quand l'émetteur n'a plus l'ATEM");

    // Rebranché : reconnexion, état retrouvé
    t.link("l_eth").cut = false;
    await sleep(1800);
    assert.equal(t.ledOn("em_led_statut"), false);
    assert.deepEqual(t.lampe(3), RED);
    assert.deepEqual(t.errors, []);
  } finally {
    t.bench.stopAll();
  }
});

test("maillage : les lampes 5 à 8, hors de portée de l'émetteur, reçoivent par relais", { timeout: 15000 }, async () => {
  const t = setup();
  t.bench.startAll();
  try {
    await sleep(2000);
    await t.key("pvw8");
    assert.deepEqual(t.lampe(8), GREEN, "lampe 8 à jour via le maillage");
    assert.deepEqual(t.lampe(5), OFF);
    const hops = (n) => Math.max(...t.serial.filter((l) => l.startsWith(`[lampe${n}] Trame reçue en`)).map((l) => Number(l.match(/en (\d+) saut/)[1])));
    assert.ok(hops(8) >= 3, `lampe 8 : ${hops(8)} sauts`);
    assert.ok(t.bench.net.heard.get("lampe8")?.from !== "emetteur", "la lampe 8 n'entend pas l'émetteur directement");
  } finally {
    t.bench.stopAll();
  }
});

test("sans relais, les lampes hors de portée restent en bleu", { timeout: 10000 }, async () => {
  const t = setup();
  for (const c of t.circuit.components) if (c.code?.includes("const bool RELAIS = true;")) c.code = c.code.replace("const bool RELAIS = true;", "const bool RELAIS = false;");
  t.bench.startAll();
  try {
    await sleep(2600);
    assert.deepEqual(t.lampe(1), RED, "lampe 1 entend l'émetteur");
    for (const n of [5, 6, 7, 8]) assert.deepEqual(t.lampe(n), BLUE, `lampe ${n} hors de portée`);
  } finally {
    t.bench.stopAll();
  }
});

test("ESP-NOW : une lampe sur un autre canal reste en bleu", { timeout: 10000 }, async () => {
  const t = setup();
  const l8 = t.circuit.components.find((c) => c.id === "lampe8");
  l8.code = l8.code.replace("const int CANAL_ESPNOW = 1;", "const int CANAL_ESPNOW = 6;");
  t.bench.startAll();
  try {
    await sleep(1500);
    assert.deepEqual(t.lampe(8), BLUE);
    assert.deepEqual(t.lampe(2), GREEN);
  } finally {
    t.bench.stopAll();
  }
});

test("ATEM : renvoie les paquets non acquittés puis oublie le client muet", () => {
  let now = 0;
  const sent = [], inbox = [];
  const port = { rj45Send: (b) => sent.push(b), rj45Receive: () => inbox.shift() ?? null };
  const inst = { params: { inputs: 20, rate: 1 }, rt: {} };
  const srv = new AtemServer(inst, port, { now: () => now });
  const hello = [...atemHeader(0x10, 20, 0x53ab, 0, 0), 0x01, 0, 0, 0, 0, 0, 0, 0];
  inbox.push(hello); srv.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0] & 0xf8, 0x10); assert.equal(sent[0][12], 0x02, "connexion acceptée");
  inbox.push(atemHeader(0x80, 12, 0x53ab, 0, 0)); now = 10; srv.tick();
  const dump = sent.slice(1);
  assert.equal(dump.length, 4, "état initial en 4 paquets");
  const sid = (dump[0][2] << 8) | dump[0][3];
  assert.ok(sid & 0x8000, "nouvelle session attribuée par l'ATEM");
  const names = dump.flatMap((p) => { const out = []; for (let i = 12; i + 8 <= p.length;) { const l = (p[i] << 8) | p[i + 1]; out.push(String.fromCharCode(...p.slice(i + 4, i + 8))); i += l; } return out; });
  assert.deepEqual(names, ["_ver", "_pin", "PrgI", "PrvI", "PrgI", "PrvI", "TlIn", "InCm"]);
  assert.equal(inst.rt.clients, 1);
  // Le client acquitte les 2 premiers seulement : les 2 autres sont renvoyés avec le drapeau 0x20.
  inbox.push(atemHeader(0x80, 12, sid, 2, 0)); now = 300; sent.length = 0; srv.tick();
  assert.equal(sent.filter((p) => p[0] & 0x20).length, 2);
  // Plus rien du client : il est oublié après 2,5 s.
  for (now = 300; now < 3000; now += 100) srv.tick();
  assert.equal(inst.rt.clients, 0);
});
