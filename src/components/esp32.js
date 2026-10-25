// Carte ESP32-DevKitC (module ESP32-WROOM-32), alimentée par USB.
// Valeurs : Espressif « ESP32 Series Datasheet », tableau DC Characteristics (3,3 V, 25 °C),
// et documentation ESP-IDF (GPIO drive capability).
import { fmt } from "../engine/units.js";
import { stampThevenin, stampJunctionToRail, junctionIG } from "../engine/devices.js";

const VDD = 3.3;
const R_PULL = 45e3;          // RPU / RPD typiques
const G_LEAK = 50e-9 / VDD;    // IIH/IIL = 50 nA
const CLAMP = { Is: 1e-14, n: 1 }; // diodes de protection ESD vers VDD et GND
// Courant de sortie à VOH = 0,8·VDD (et VOL = 0,1·VDD... 0,495 V pour IOL) selon la "drive capability".
const DRIVE = {
  0: { label: "0 (~5 mA)", ioh: 0.005, iol: 0.0035 },
  1: { label: "1 (~10 mA)", ioh: 0.010, iol: 0.007 },
  2: { label: "2 (~20 mA, défaut)", ioh: 0.020, iol: 0.014 },
  3: { label: "3 (~40 mA)", ioh: 0.040, iol: 0.028 },
};
const rHigh = (d) => (VDD - 0.8 * VDD) / DRIVE[d].ioh;
const rLow = (d) => 0.495 / DRIVE[d].iol;

// GPIO exposés sur ce bloc. inputOnly : GPIO34-39 (pas de sortie, pas de pull-up/down interne).
// reset : état après reset (broches de strapping), d'après le tableau "Strapping Pins".
export const ESP32_GPIO = [
  { gpio: 34, side: "L", y: 6, inputOnly: true, adc: "ADC1_CH6" },
  { gpio: 32, side: "L", y: 7, adc: "ADC1_CH4" },
  { gpio: 4, side: "L", y: 8, adc: "ADC2_CH0" },
  { gpio: 5, side: "L", y: 9, reset: "INPUT_PULLUP" },
  { gpio: 2, side: "R", y: 4, reset: "INPUT_PULLDOWN", adc: "ADC2_CH2", note: "LED bleue intégrée sur certaines cartes" },
  { gpio: 18, side: "R", y: 5 },
  { gpio: 19, side: "R", y: 6 },
  { gpio: 21, side: "R", y: 7, note: "SDA I²C par défaut" },
  { gpio: 22, side: "R", y: 8, note: "SCL I²C par défaut" },
];

const PINS = [
  { id: "3V3", label: "3V3", x: 0, y: 4 },
  { id: "GND", label: "GND", x: 0, y: 5 },
  ...ESP32_GPIO.map((g) => ({ id: `IO${g.gpio}`, label: `GPIO${g.gpio}`, x: g.side === "L" ? 0 : 10, y: g.y })),
  { id: "GND2", label: "GND", x: 10, y: 9 },
];

export function pinState(inst, gpio) {
  const g = ESP32_GPIO.find((p) => p.gpio === gpio);
  return inst.rt?.pins?.[gpio] ?? { mode: g?.reset ?? "INPUT", level: 0 };
}

function outputLevel(inst, gpio, st) {
  if (st.mode === "PWM") return inst.rt?.pwmPhase?.[gpio] ?? (st.duty >= 0.5 ? 1 : 0);
  return st.level;
}

// Courant entrant dans la puce par la broche, pour une tension de broche v (référencée à GND).
function chipCurrent(inst, g, v, tempC) {
  const st = pinState(inst, g.gpio);
  const d = inst.params.drive;
  let I = v * G_LEAK;
  if (st.mode === "OUTPUT" || st.mode === "PWM") {
    I += outputLevel(inst, g.gpio, st) ? (v - VDD) / rHigh(d) : v / rLow(d);
  } else if (st.mode === "INPUT_PULLUP") I += (v - VDD) / R_PULL;
  else if (st.mode === "INPUT_PULLDOWN") I += v / R_PULL;
  I += junctionIG(v - VDD, CLAMP, tempC).I - junctionIG(-v, CLAMP, tempC).I;
  return I;
}

export const esp32 = {
  type: "esp32",
  name: "ESP32 DevKitC",
  category: "Microcontrôleurs",
  summary: "ESP32-WROOM-32 sur carte DevKitC, programmable en Arduino (sous-ensemble).",
  programmable: true,
  pins: PINS,
  bounds: { x: 1, y: -0.3, w: 8, h: 10.3 },
  rotatable: false,
  params: [
    { key: "drive", label: "Drive strength des sorties", kind: "select", default: 2, options: Object.entries(DRIVE).map(([value, d]) => ({ value: Number(value), label: d.label })) },
  ],
  datasheet: {
    source: "Espressif, ESP32 Series Datasheet, § DC Characteristics (3,3 V, 25 °C) et ESP-IDF GPIO drive capability.",
    notes: [
      "Entrée : VIH ≥ 0,75·VDD (2,48 V), VIL ≤ 0,25·VDD (0,83 V), fuite 50 nA. Entre les deux, le niveau lu est indéterminé.",
      "Sortie : VOH ≥ 0,8·VDD au courant nominal de la drive strength, VOL ≤ 0,495 V. Modèle de Thévenin calé sur ces deux points.",
      "Pull-up / pull-down internes : 45 kΩ typ. GPIO34 à 39 : entrées seules, sans pull.",
      "Tension max sur une broche : VDD + 0,3 V (3,6 V). Au-delà, les diodes de protection conduisent.",
      "ADC (atténuation 11 dB par défaut) : 12 bits, pleine échelle ≈ 3,1 V. La non-linéarité réelle n'est pas encore modélisée.",
      "Broche 3V3 : régulateur AMS1117-3.3 de la carte, prévoir au plus ~500 mA pour l'extérieur.",
    ],
  },
  branches: () => 1,
  stamp(ctx, inst, nodes, [k], state) {
    const [n3v3, gnd] = nodes;
    const gnd2 = nodes[nodes.length - 1];
    ctx.conductance(gnd, gnd2, 1e3);
    ctx.voltageSource(n3v3, gnd, VDD * ctx.srcFactor, k);
    const d = inst.params.drive;
    ESP32_GPIO.forEach((g, i) => {
      const pin = nodes[2 + i];
      const st = pinState(inst, g.gpio);
      if (st.mode === "OUTPUT" || st.mode === "PWM") {
        const lvl = outputLevel(inst, g.gpio, st);
        stampThevenin(ctx, pin, gnd, lvl ? VDD : 0, lvl ? rHigh(d) : rLow(d));
      } else if (st.mode === "INPUT_PULLUP") stampThevenin(ctx, pin, gnd, VDD, R_PULL);
      else if (st.mode === "INPUT_PULLDOWN") ctx.conductance(pin, gnd, 1 / R_PULL);
      ctx.conductance(pin, gnd, G_LEAK);
      stampJunctionToRail(ctx, state, `up${g.gpio}`, pin, gnd, VDD, CLAMP, false);
      stampJunctionToRail(ctx, state, `dn${g.gpio}`, pin, gnd, 0, CLAMP, true);
    });
  },
  evaluate(ctx, inst, nodes, [k]) {
    const gnd = nodes[1];
    const out = { I3v3: -ctx.branchI(k) };
    ESP32_GPIO.forEach((g, i) => {
      const v = ctx.v(nodes[2 + i]) - ctx.v(gnd);
      out[`V${g.gpio}`] = v;
      out[`Vmin${g.gpio}`] = v;
      out[`I${g.gpio}`] = -chipCurrent(inst, g, v, ctx.tempC); // courant sortant vers le circuit
    });
    return out;
  },
  describe(inst, avg, peak) {
    const warnings = [];
    const lim = DRIVE[inst.params.drive].ioh;
    const readings = [];
    for (const g of ESP32_GPIO) {
      const st = pinState(inst, g.gpio);
      const v = avg[`V${g.gpio}`], i = avg[`I${g.gpio}`];
      const ipk = Math.max(Math.abs(peak[`I${g.gpio}`] ?? 0), Math.abs(peak[`Imin${g.gpio}`] ?? 0), Math.abs(i));
      const mode = st.mode === "OUTPUT" ? `OUTPUT ${st.level ? "HIGH" : "LOW"}` : st.mode === "PWM" ? `PWM ${Math.round(st.duty * 100)} %` : st.mode;
      readings.push([`GPIO${g.gpio}`, `${mode} · ${fmt(v, "V")} · ${fmt(i, "A")}`]);
      if (peak[`V${g.gpio}`] > VDD + 0.3) warnings.push({ level: "danger", text: `GPIO${g.gpio} reçoit ${fmt(peak[`V${g.gpio}`], "V")} > 3,6 V max : risque de destruction (l'ESP32 n'est pas tolérant 5 V).` });
      if (peak[`Vmin${g.gpio}`] < -0.3) warnings.push({ level: "danger", text: `GPIO${g.gpio} à ${fmt(peak[`Vmin${g.gpio}`], "V")} < −0,3 V min.` });
      if (ipk > 0.04) warnings.push({ level: "danger", text: `GPIO${g.gpio} débite ${fmt(ipk, "A")} : au-delà des 40 mA max d'une broche.` });
      else if (ipk > lim * 1.05 && (st.mode === "OUTPUT" || st.mode === "PWM")) warnings.push({ level: "warn", text: `GPIO${g.gpio} débite ${fmt(ipk, "A")}, plus que le courant nominal de la drive strength (${fmt(lim, "A")}) : la tension de sortie s'effondre.` });
    }
    readings.unshift(["3V3 (vers l'extérieur)", fmt(avg.I3v3, "A")]);
    if (avg.I3v3 > 0.5) warnings.push({ level: "danger", text: `Le 3V3 fournit ${fmt(avg.I3v3, "A")} : le régulateur de la carte va chauffer ou décrocher.` });
    return { readings, warnings };
  },
  // Niveau logique lu par digitalRead(), avec hystérésis dans la zone indéterminée.
  digitalRead(inst, avg, gpio) {
    const v = avg[`V${gpio}`];
    if (v === undefined) return 0;
    if (v >= 0.75 * VDD) return 1;
    if (v <= 0.25 * VDD) return 0;
    return inst.rt?.lastRead?.[gpio] ?? 0;
  },
  analogRead(inst, avg, gpio) {
    const v = avg[`V${gpio}`] ?? 0;
    if (v <= 0.075) return 0;
    return Math.min(4095, Math.round((v / 3.1) * 4095));
  },
  label: () => "",
  symbol(inst, avg) {
    let s = `<rect class="board" x="20" y="-6" width="160" height="212" rx="5"/>`
      + `<rect class="module" x="48" y="2" width="104" height="58" rx="2"/>`
      + `<polyline class="antenna" points="58,10 58,18 70,18 70,10 82,10 82,18 94,18 94,10 106,10 106,18 118,18 118,10 130,10 130,18 142,18"/>`
      + `<text class="chip" x="100" y="40">ESP32</text><text class="chip small" x="100" y="52">WROOM-32</text>`
      + `<rect class="usb" x="84" y="194" width="32" height="14" rx="2"/><text class="chip small" x="100" y="186">DevKitC</text>`;
    for (const p of PINS) {
      const left = p.x === 0;
      const x = p.x * 20, y = p.y * 20;
      let cls = "pin";
      const g = ESP32_GPIO.find((q) => `IO${q.gpio}` === p.id);
      if (g && avg) {
        const st = pinState(inst, g.gpio);
        const v = avg[`V${g.gpio}`] ?? 0;
        cls += v >= 0.75 * VDD ? " hi" : v <= 0.25 * VDD ? " lo" : " mid";
        if (st.mode === "OUTPUT" || st.mode === "PWM") cls += " out";
      }
      if (p.id === "3V3") cls += " pwr";
      s += `<line x1="${x}" y1="${y}" x2="${left ? 20 : 180}" y2="${y}"/>`
        + `<circle class="${cls}" cx="${left ? 26 : 174}" cy="${y}" r="3.2"/>`
        + `<text class="pinlabel" x="${left ? 32 : 168}" y="${y + 3.5}" text-anchor="${left ? "start" : "end"}">${p.label}</text>`;
    }
    return s;
  },
};
