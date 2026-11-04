import { pinPositions } from "../engine/circuit.js";
// Circuit et sketch chargés au premier lancement.
export const EXAMPLE_SKETCH = `// LED rouge qui clignote (GPIO2), plus vite quand on appuie sur le bouton (GPIO4).
// LED bleue qui "respire" en PWM (GPIO19).
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

export function exampleCircuit() {
  const c = (id, type, x, y, rot, params) => ({ id, type, x, y, rot, params });
  return {
    components: [
      c("esp", "esp32", 8, 2, 0, { drive: 2 }),
      c("r1", "resistor", 20, 3, 0, { R: 220, Pmax: 0.25 }),
      c("d1", "led", 24, 3, 0, { color: "red" }),
      c("r2", "resistor", 20, 8, 0, { R: 100, Pmax: 0.25 }),
      c("d2", "led", 24, 8, 0, { color: "blue" }),
      c("gnd", "ground", 30, 13, 0, {}),
      c("bp", "button", 2, 10, 0, {}),
      c("bat", "battery", 2, 15, 1, { kind: "9v" }),
      c("r3", "resistor", 6, 15, 0, { R: 470, Pmax: 0.25 }),
      c("d3", "led", 10, 15, 0, { color: "green" }),
      c("sw", "switch", 14, 15, 1, { closed: true }),
    ],
    wires: [
      [18, 6, 19, 6], [19, 6, 19, 3], [19, 3, 20, 3], [28, 3, 30, 3], [30, 3, 30, 13], [18, 8, 20, 8], [28, 8, 30, 8],
      [18, 11, 18, 13], [18, 13, 30, 13],
      [6, 10, 8, 10], [2, 10, 2, 7], [2, 7, 8, 7],
      [2, 15, 6, 15], [14, 19, 2, 19],
    ].map(([x1, y1, x2, y2], i) => ({ id: `w${i}`, x1, y1, x2, y2 })),
  };
}

// ---------- Boîtier timecode LTC (projets/timecode-ltc) ----------
// Valeurs de projets/timecode-ltc/design.py. Les montages s'étudient dans
// l'onglet Oscilloscope (analyse transitoire).
const part = (id, type, x, y, rot, params) => ({ id, type, x, y, rot, params });
const wires = (list) => list.map(([x1, y1, x2, y2], i) => ({ id: `w${i}`, x1, y1, x2, y2 }));

// Le moteur ne relie une broche qu'à une extrémité de fil : on coupe donc chaque
// fil aux broches qui tombent sur son tracé (comme on le ferait à la souris).
function splitAtPins(circuit) {
  const pts = circuit.components.flatMap((c) => pinPositions(c));
  const out = [];
  for (const w of circuit.wires) {
    const inside = pts.filter((p) => {
      if ((p.x === w.x1 && p.y === w.y1) || (p.x === w.x2 && p.y === w.y2)) return false;
      if ((w.x2 - w.x1) * (p.y - w.y1) !== (w.y2 - w.y1) * (p.x - w.x1)) return false;
      return p.x >= Math.min(w.x1, w.x2) && p.x <= Math.max(w.x1, w.x2) && p.y >= Math.min(w.y1, w.y2) && p.y <= Math.max(w.y1, w.y2);
    });
    const cuts = [{ x: w.x1, y: w.y1 }, ...inside.sort((a, b) => Math.hypot(a.x - w.x1, a.y - w.y1) - Math.hypot(b.x - w.x1, b.y - w.y1)), { x: w.x2, y: w.y2 }];
    for (let i = 0; i < cuts.length - 1; i++) {
      if (cuts[i].x === cuts[i + 1].x && cuts[i].y === cuts[i + 1].y) continue;
      out.push({ id: `w${out.length}`, x1: cuts[i].x, y1: cuts[i].y, x2: cuts[i + 1].x, y2: cuts[i + 1].y });
    }
  }
  return { ...circuit, wires: out };
}

const shift = (c, dx, dy) => ({
  components: c.components.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
  wires: c.wires.map((w) => ({ ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy })),
});

export function ltcInputCircuit() {
  return splitAtPins(shift({
    components: [
      part("cam", "siggen", 1, 6, 1, { shape: "ltc", Vpp: 1, offset: 0, Rout: 50, rate: "25", tc: "01:00:00:00", rise: 25e-6, freq: 1000 }),
      part("g1", "ground", 1, 10, 0, {}),
      part("r1", "resistor", 6, 6, 1, { R: 1e6, Pmax: 0.125 }),
      part("g2", "ground", 6, 10, 0, {}),
      part("c1", "capacitor", 6, 6, 0, { C: 100e-9, dielectric: "x5r", Vmax: 100 }),
      part("r2", "resistor", 10, 6, 0, { R: 10e3, Pmax: 0.125 }),
      part("d2a", "diode", 14, 10, 3, { model: "BAT54" }),
      part("g3", "ground", 14, 10, 0, {}),
      part("d2b", "diode", 18, 6, 1, { model: "BAT54" }),
      part("c2", "capacitor", 22, 6, 1, { C: 680e-12, dielectric: "c0g", Vmax: 50 }),
      part("g4", "ground", 22, 10, 0, {}),
      part("r3", "resistor", 26, 6, 1, { R: 100e3, Pmax: 0.125 }),
      part("r4", "resistor", 30, 6, 0, { R: 1e3, Pmax: 0.125 }),
      part("u3", "tlv3201", 36, 7, 0, { VOS: 1e-3 }),
      part("g5", "ground", 38, 9, 0, {}),
      part("r8", "resistor", 41, 13, 2, { R: 470e3, Pmax: 0.125 }),
      part("r7", "resistor", 34, 14, 3, { R: 10e3, Pmax: 0.125 }),
      part("c3", "capacitor", 22, 14, 1, { C: 10e-6, dielectric: "x5r", Vmax: 10 }),
      part("g6", "ground", 22, 18, 0, {}),
      part("r6", "resistor", 26, 14, 1, { R: 47e3, Pmax: 0.125 }),
      part("g7", "ground", 26, 18, 0, {}),
      part("r5", "resistor", 30, 22, 3, { R: 47e3, Pmax: 0.125 }),
      part("r9", "resistor", 41, 7, 0, { R: 100, Pmax: 0.125 }),
      part("vdd", "dc", 10, 22, 1, { V: 3.3 }),
      part("g8", "ground", 10, 26, 0, {}),
      part("osc", "scope", 52, 2, 0, { name1: "BNC (entrée)", name2: "GPIO4 (vers l'ESP32)" }),
    ],
    wires: wires([
      [1, 6, 6, 6], [14, 6, 30, 6], [34, 6, 36, 6], [18, 10, 18, 22], [26, 10, 26, 14], [22, 14, 34, 14],
      [30, 18, 30, 14], [10, 22, 48, 22], [48, 22, 48, 3], [48, 3, 38, 3], [38, 3, 38, 5],
      [36, 8, 36, 13], [37, 13, 36, 13], [41, 7, 41, 13], [34, 10, 36, 10],
      [45, 7, 50, 7], [50, 7, 50, 4], [50, 4, 52, 4], [1, 6, 1, 2], [1, 2, 52, 2],
    ]),
  }, 0, 1));
}

export function ltcOutputCircuit() {
  return splitAtPins(shift({
    components: [
      part("gpio", "siggen", 2, 6, 1, { shape: "ltc", Vpp: 3.3, offset: 1.65, Rout: 16.5, rate: "25", tc: "01:00:00:00", rise: 5e-9, freq: 1000 }),
      part("g1", "ground", 2, 10, 0, {}),
      part("vdd", "dc", 10, 1, 2, { V: 3.3 }),
      part("g0", "ground", 6, 1, 0, {}),
      part("r10", "resistor", 4, 6, 0, { R: 10e3, Pmax: 0.125 }),
      part("r11", "resistor", 12, 2, 1, { R: 30e3, Pmax: 0.125 }),
      part("r12", "resistor", 16, 6, 1, { R: 30e3, Pmax: 0.125 }),
      part("g2", "ground", 16, 10, 0, {}),
      part("c5", "capacitor", 20, 6, 1, { C: 1.8e-9, dielectric: "c0g", Vmax: 50 }),
      part("g3", "ground", 20, 10, 0, {}),
      part("u4", "tlv9061", 24, 5, 0, { VOS: 0.3e-3 }),
      part("g4", "ground", 26, 7, 0, {}),
      part("r13", "resistor", 32, 5, 0, { R: 56, Pmax: 0.125 }),
      part("d4a", "diode", 38, 9, 3, { model: "BAT54" }),
      part("g5", "ground", 38, 9, 0, {}),
      part("d4b", "diode", 40, 5, 3, { model: "BAT54" }),
      part("c7", "capacitor", 44, 5, 0, { C: 47e-6, dielectric: "x5r", Vmax: 10 }),
      part("c8", "capacitor", 44, 8, 0, { C: 47e-6, dielectric: "x5r", Vmax: 10 }),
      part("r14", "resistor", 48, 5, 0, { R: 22, Pmax: 0.125 }),
      part("r15", "resistor", 54, 5, 1, { R: 100e3, Pmax: 0.125 }),
      part("g6", "ground", 54, 9, 0, {}),
      part("load", "resistor", 58, 5, 1, { R: 75, Pmax: 0.125 }),
      part("g7", "ground", 58, 9, 0, {}),
      part("osc", "scope", 54, 13, 0, { name1: "BNC (vers la caméra)", name2: "GPIO5 (ESP32)" }),
    ],
    wires: wires([
      [2, 6, 4, 6], [8, 6, 24, 6], [10, 1, 40, 1], [12, 1, 12, 2], [26, 3, 26, 1],
      [24, 4, 23, 4], [23, 4, 23, 2], [23, 2, 30, 2], [30, 2, 30, 5], [29, 5, 32, 5],
      [36, 5, 44, 5], [44, 5, 44, 8], [48, 5, 48, 8], [52, 5, 58, 5],
      [58, 5, 61, 5], [61, 5, 61, 12], [61, 12, 52, 12], [52, 12, 52, 13], [52, 13, 54, 13],
      [4, 6, 4, 17], [4, 17, 53, 17], [53, 17, 53, 15], [53, 15, 54, 15],
    ]),
  }, 0, 2));
}

export const EXAMPLES = [
  { id: "demo", name: "Démo ESP32 : LED et bouton", circuit: exampleCircuit, sketch: true },
  { id: "ltc-in", name: "Boîtier LTC : entrée (mode TX)", circuit: ltcInputCircuit, tran: { tstop: 0.12, dt: 2e-6, from: 0.04 },
    note: "Une caméra Sony (1 Vcc sous 50 Ω) envoie son LTC sur la BNC. Liaison C1, écrêtage BAT54, filtre C2, comparateur TLV3201 avec hystérésis R7/R8 : la sortie logique va sur GPIO4. L'inverseur TX/RX et la TVS ne sont pas représentés. Changez l'amplitude ou l'impédance du générateur (0,3 à 18 Vcc, 50 Ω à 1 kΩ) et relancez." },
  { id: "ltc-out", name: "Boîtier LTC : sortie (mode RX)", circuit: ltcOutputCircuit, tran: { tstop: 0.12, dt: 2e-6, from: 0.04 },
    note: "GPIO5 sort le LTC en logique 0/3,3 V. R10/R11/R12 le ramènent à 2 Vcc autour de 1,65 V, C5 met les fronts à 24 µs, le TLV9061 en suiveur attaque 75 Ω via R13 + R14, C7/C8 coupent le continu. Changez la charge (75 Ω, 600 Ω, 10 kΩ) et relancez. Les 47 µF X5R valent environ 37 µF sous tension : non modélisé ici." },
];
