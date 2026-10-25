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
