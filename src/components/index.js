// Registre des composants. Ajouter un composant = un fichier dans ce dossier
// + une ligne ici + ses tests dans tests/ (voir docs/AJOUTER-UN-COMPOSANT.md).
import { ground, resistor, potentiometer, toggleSwitch, pushButton } from "./passives.js";
import { capacitor, inductor } from "./reactive.js";
import { dcSupply, battery, currentSource } from "./sources.js";
import { diode, led } from "./semiconductors.js";
import { bjt, mosfet } from "./transistors.js";
import { opamp, comparator } from "./opamps.js";
import { ne555, vreg } from "./analog-ics.js";
import { LOGIC_CHIPS } from "./logic.js";
import { sevenSeg } from "./display.js";
import { ntc, ldr, tempSensor } from "./sensors.js";
import { relay } from "./electromech.js";
import { voltmeter, ammeter, multimeter, probe, funcgen } from "./instruments.js";
import { esp32 } from "./esp32.js";

export const COMPONENTS = [
  ground, dcSupply, battery, currentSource,
  probe, voltmeter, ammeter, multimeter, funcgen,
  resistor, potentiometer, capacitor, inductor,
  toggleSwitch, pushButton, relay,
  diode, bjt, mosfet,
  led, sevenSeg,
  opamp, comparator, ne555, vreg,
  ...LOGIC_CHIPS,
  ntc, ldr, tempSensor,
  esp32,
];

export const REGISTRY = Object.fromEntries(COMPONENTS.map((c) => [c.type, c]));

export function defaultParams(def) {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}
