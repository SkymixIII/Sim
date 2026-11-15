// Montages de démonstration. Chaque exemple : un circuit, éventuellement un sketch et des réglages d'oscilloscope.
import { REGISTRY, defaultParams } from "../components/index.js";
import { pinPositions } from "../engine/circuit.js";

export const EXAMPLE_SKETCH = `// LED rouge qui clignote (GPIO2), plus vite quand on appuie sur le bouton (GPIO4).
// LED bleue qui "respire" en PWM (GPIO19) : regardez le signal sur l'oscilloscope.
const int LED_ROUGE = 2;
const int LED_BLEUE = 19;
const int BOUTON = 4;

int luminosite = 0;
int pas = 15;
unsigned long dernierChangement = 0;
bool allumee = false;

void setup() {
  Serial.begin(115200);
  pinMode(LED_ROUGE, OUTPUT);
  pinMode(BOUTON, INPUT_PULLUP);
  Serial.println("ESP32 prêt");
}

void loop() {
  analogWrite(LED_BLEUE, luminosite);
  luminosite = luminosite + pas;
  if (luminosite <= 0 || luminosite >= 255) pas = -pas;

  unsigned long periode = digitalRead(BOUTON) == LOW ? 100 : 500;
  if (millis() - dernierChangement >= periode) {
    dernierChangement = millis();
    allumee = !allumee;
    digitalWrite(LED_ROUGE, allumee ? HIGH : LOW);
    if (allumee) Serial.println("Bouton : " + String(digitalRead(BOUTON) == LOW ? "appuyé" : "relâché"));
  }
  delay(30);
}
`;

// Petit outil de dessin : composants posés sur la grille, fils orthogonaux entre broches ("id.BROCHE")
// ou points [x, y]. Entre deux points non alignés, le fil part à l'horizontale puis tourne.
function sheet() {
  const components = [], wires = [];
  const pins = new Map();
  const api = {
    add(id, type, x, y, rot = 0, params = {}) {
      const c = { id, type, x, y, rot, params: { ...defaultParams(REGISTRY[type]), ...params } };
      components.push(c);
      for (const p of pinPositions(c)) for (const n of [p.id, p.name, p.name?.replace("~", "")]) if (n) pins.set(`${id}.${n}`, [p.x, p.y]);
      return api;
    },
    gnd(...at) { for (const a of at) api.add(`gnd${components.length}`, "ground", ...api.pt(a)); return api; },
    probe(ch, at) { return api.add(`ch${ch}`, "probe", ...api.pt(at), 0, { ch }); },
    pt(ref) {
      if (typeof ref !== "string") return ref;
      if (!pins.has(ref)) throw new Error(`Broche inconnue : ${ref}`);
      return pins.get(ref);
    },
    wire(...refs) {
      const pts = refs.map(api.pt);
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        const seg = (a, b, c, d) => { if (a !== c || b !== d) wires.push({ id: `w${wires.length}`, x1: a, y1: b, x2: c, y2: d }); };
        if (x1 === x2 || y1 === y2) seg(x1, y1, x2, y2); else { seg(x1, y1, x2, y1); seg(x2, y1, x2, y2); }
      }
      return api;
    },
    done: () => ({ components, wires }),
  };
  return api;
}

function esp32Demo() {
  return sheet()
    .add("esp", "esp32", 8, 2).add("r1", "resistor", 20, 3, 0, { R: 220 }).add("d1", "led", 24, 3, 0, { color: "red" })
    .add("r2", "resistor", 20, 8, 0, { R: 100 }).add("d2", "led", 24, 8, 0, { color: "blue" })
    .add("bp", "button", 2, 10).add("bat", "battery", 2, 15, 1, { kind: "9v" }).add("r3", "resistor", 6, 15, 0, { R: 470 })
    .add("d3", "led", 10, 15, 0, { color: "green" }).add("sw", "switch", 14, 15, 1, { closed: true })
    .wire("esp.IO2", [19, 6], [19, 3], "r1.1").wire("d1.K", [30, 3], [30, 13])
    .wire("esp.IO19", [19, 8]).wire([19, 8], "r2.1").wire([19, 8], [19, 11]).wire("d2.K", [30, 8])
    .wire("esp.GND2", [18, 13], [30, 13]).gnd([30, 13])
    .wire("bp.2", "esp.IO4").wire("bp.1", [2, 7], "esp.GND")
    .wire("bat.+", "r3.1").wire("sw.2", [2, 19], "bat.-")
    .probe(1, [19, 11])
    .done();
}

function astable555() {
  return sheet()
    .add("bat", "battery", 12, 10, 1, { kind: "9v" }).add("u", "ne555", 24, 10)
    .add("ra", "resistor", 38, 7, 1, { R: 10e3 }).add("rb", "resistor", 38, 11, 1, { R: 47e3 }).add("c", "capacitor", 38, 15, 1, { C: 10e-6, Vmax: 16, polar: true })
    .add("r", "resistor", 16, 12, 1, { R: 470 }).add("d", "led", 16, 16, 1, { color: "red" })
    .wire("bat.+", [12, 5], [38, 5], "ra.1").gnd("bat.-", "d.K", "c.2")
    .wire("u.GND", [22, 10]).gnd([22, 10])
    .wire("u.OUT", "r.1")
    .wire("u.RESET", [19, 13], [19, 5])
    .wire("u.VCC", [32, 10], [32, 5])
    .wire("u.DISCH", "ra.2")
    .wire("u.THR", [36, 12], [36, 15]).wire([36, 15], "rb.2").wire("u.TRIG", [23, 11], [23, 16], [36, 16], [36, 15])
    .probe(1, "r.1").probe(2, [30, 16])
    .done();
}

function nonInverting() {
  return sheet()
    .add("g", "funcgen", 10, 14, 1, { wave: "sine", f: 1000, A: 0.5 }).add("u", "opamp", 20, 15, 0, { model: "TL072" })
    .add("rf", "resistor", 20, 22, 0, { R: 10e3 }).add("rg", "resistor", 18, 22, 1, { R: 1e3 })
    .add("vp", "dc", 36, 8, 1, { V: 12 }).add("vn", "dc", 36, 12, 1, { V: 12 })
    .wire("g.+", "u.IN+").gnd("g.-", "rg.2")
    .wire("u.IN-", [18, 16], "rg.1").wire("rg.1", "rf.1").wire("rf.2", [28, 22], [28, 15]).wire("u.OUT", [28, 15]).wire([28, 15], [31, 15])
    .wire("u.V+", [23, 8], "vp.+").wire("u.V-", [23, 20], [36, 20], "vn.-").wire("vp.-", [38, 12]).gnd([38, 12])
    .probe(1, [14, 14]).probe(2, [31, 15])
    .done();
}

function rcFilter() {
  return sheet()
    .add("g", "funcgen", 12, 12, 1, { wave: "square", f: 500, A: 2 }).add("r", "resistor", 18, 12, 0, { R: 1e3 }).add("c", "capacitor", 26, 12, 1, { C: 220e-9 })
    .wire("g.+", "r.1").wire("r.2", "c.1").gnd("g.-", "c.2")
    .probe(1, [15, 12]).probe(2, "c.1")
    .done();
}

function binaryCounter() {
  const s = sheet()
    .add("v", "dc", 10, 8, 1, { V: 5 }).add("g", "funcgen", 16, 11, 1, { wave: "clock", f: 4, A: 5 }).add("u", "74hc161", 24, 10)
    .wire("v.+", [10, 6], [32, 6]).gnd("v.-", "g.-")
    .wire("u.VCC", [32, 10], [32, 6]).wire("u.CLR", [22, 10], [22, 6]).wire("g.+", "u.CLK")
    .wire("u.ENP", [21, 16], [21, 6]).wire("u.ENT", [31, 16], [31, 17]).wire("u.LOAD", [31, 17]).wire([31, 17], [31, 19], [21, 19], [21, 16])
    .wire("u.GND", [22, 17]).gnd([22, 17]);
  const rows = [["QA", 9, [[34, 12], [34, 9]]], ["QB", 12, [[35, 13], [35, 12]]], ["QC", 15, [[35, 14], [35, 15]]], ["QD", 18, [[34, 15], [34, 18]]]];
  for (const [q, y, via] of rows) {
    s.add(`r${q}`, "resistor", 36, y, 0, { R: 330 }).add(`d${q}`, "led", 40, y, 0, { color: q === "QD" ? "red" : "green" });
    s.wire(`u.${q}`, ...via, `r${q}.1`).wire(`d${q}.K`, [46, y]);
  }
  s.wire([46, 9], [46, 12]).wire([46, 12], [46, 15]).wire([46, 15], [46, 18]).gnd([46, 18]);
  return s.probe(1, [18, 11]).probe(2, [34, 11]).probe(3, [34, 16]).done();
}

function relayDriver() {
  return sheet()
    .add("v", "dc", 10, 8, 1, { V: 5 }).add("k", "relay", 26, 8).add("fd", "diode", 22, 12, 3, { model: "1N4007" }).add("q", "bjt", 24, 16, 0, { model: "2N2222A" })
    .add("rb", "resistor", 18, 16, 0, { R: 1e3 }).add("rp", "resistor", 17, 16, 1, { R: 10e3 }).add("bp", "button", 12, 16)
    .add("d", "led", 40, 8, 2, { color: "green" }).add("r", "resistor", 40, 8, 0, { R: 150 })
    .wire("v.+", [10, 6], [44, 6], "r.2").gnd("v.-", "q.E", "rp.2")
    .wire("k.A1", [24, 8]).wire([24, 8], "fd.K").wire([24, 8], [24, 6])
    .wire("k.A2", [26, 12]).wire([26, 12], "q.C").wire("fd.A", [26, 12])
    .wire("bp.1", [12, 6]).wire("bp.2", "rp.1").wire("rp.1", "rb.1").wire("rb.2", "q.B")
    .wire("k.NO", "d.K").wire("k.COM", [34, 9], [34, 13]).gnd([34, 13])
    .done();
}

function regulator() {
  return sheet()
    .add("bat", "battery", 12, 10, 1, { kind: "9v" }).add("sw", "switch", 14, 8, 0, { closed: true }).add("u", "vreg", 20, 8, 0, { model: "L7805" })
    .add("a", "ammeter", 28, 8).add("r", "resistor", 36, 8, 1, { R: 100, Pmax: 0.5 }).add("m", "voltmeter", 41, 8, 1)
    .wire("bat.+", [12, 8], "sw.1").wire("sw.2", "u.IN").wire("u.OUT", "a.A").wire("a.COM", "r.1").wire("r.1", "m.V")
    .gnd("bat.-", "u.REF", "r.2", "m.COM")
    .done();
}

export const EXAMPLES = [
  { id: "esp32", name: "ESP32 : LED, bouton et PWM", circuit: esp32Demo, sketch: EXAMPLE_SKETCH, scope: { tdiv: 200e-6 } },
  { id: "555", name: "NE555 : clignotant astable", circuit: astable555, scope: { tdiv: 0.2 } },
  { id: "aop", name: "Ampli-op : amplificateur de gain 11", circuit: nonInverting, scope: { tdiv: 200e-6 } },
  { id: "rc", name: "Filtre RC et générateur de fonctions", circuit: rcFilter, scope: { tdiv: 500e-6 } },
  { id: "161", name: "Compteur binaire 74HC161", circuit: binaryCounter, scope: { tdiv: 0.2, stacked: true } },
  { id: "relais", name: "Transistor et relais", circuit: relayDriver },
  { id: "7805", name: "Régulateur 7805, voltmètre et ampèremètre", circuit: regulator },
];

export const exampleCircuit = () => EXAMPLES[0].circuit();
