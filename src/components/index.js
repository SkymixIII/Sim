// Registre des composants. Ajouter un composant = un fichier dans ce dossier
// + une ligne ici + ses tests dans tests/ (voir docs/AJOUTER-UN-COMPOSANT.md).
import { ground, resistor, potentiometer, toggleSwitch, pushButton } from "./passives.js";
import { dcSupply, battery, currentSource } from "./sources.js";
import { diode, led } from "./semiconductors.js";
import { esp32 } from "./esp32.js";

export const COMPONENTS = [ground, dcSupply, battery, currentSource, resistor, potentiometer, toggleSwitch, pushButton, diode, led, esp32];

export const REGISTRY = Object.fromEntries(COMPONENTS.map((c) => [c.type, c]));

export function defaultParams(def) {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}
