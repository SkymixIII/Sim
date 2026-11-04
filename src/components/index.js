// Registre des composants. Ajouter un composant = un fichier dans ce dossier
// + une ligne ici + ses tests dans tests/ (voir docs/AJOUTER-UN-COMPOSANT.md).
import { ground, resistor, potentiometer, toggleSwitch, pushButton, capacitor } from "./passives.js";
import { dcSupply, battery, currentSource, signalGenerator } from "./sources.js";
import { tlv3201, tlv9061 } from "./analog.js";
import { oscilloscope } from "./instruments.js";
import { diode, led } from "./semiconductors.js";
import { esp32 } from "./esp32.js";

export const COMPONENTS = [ground, dcSupply, battery, currentSource, signalGenerator, resistor, potentiometer, capacitor, toggleSwitch, pushButton, diode, led, tlv3201, tlv9061, esp32, oscilloscope];

export const REGISTRY = Object.fromEntries(COMPONENTS.map((c) => [c.type, c]));

export function defaultParams(def) {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}
