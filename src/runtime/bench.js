// Banc d'essai : fait tourner un sketch par carte programmable, simule le circuit électrique
// commun et relie les cartes par le réseau virtuel. Aucune dépendance au navigateur :
// l'interface et les tests l'utilisent de la même façon.
import { REGISTRY } from "../components/index.js";
import { ESP32_GPIO } from "../components/esp32.js";
import { simulate } from "../engine/circuit.js";
import { VirtualNetwork } from "../engine/network.js";
import { SketchRunner } from "./arduino.js";

const GPIOS = ESP32_GPIO.map((g) => g.gpio);
const INPUT_ONLY = new Set(ESP32_GPIO.filter((g) => g.inputOnly).map((g) => g.gpio));
const ADC = new Set(ESP32_GPIO.filter((g) => g.adc).map((g) => g.gpio));

export class Bench {
  /**
   * getCircuit : () => circuit courant ({ components, wires, links })
   * onChange   : () => l'état électrique a changé (à redessiner)
   * onSerial   : (compId, line) => ligne écrite sur le moniteur série d'une carte
   * onState    : (compId, state, msg) => "running" | "stopped" | "error"
   */
  constructor({ getCircuit, onChange = () => {}, onSerial = () => {}, onState = () => {}, onTraffic, loopPause = 1 }) {
    this.getCircuit = getCircuit;
    this.onChange = onChange; this.onSerial = onSerial; this.onState = onState;
    this.loopPause = loopPause;
    this.runners = new Map();
    this.devices = new Map();   // appareils réseau (ex. ATEM) : id -> { dev, timer }
    this.states = new Map();
    this.sim = null;
    this.net = new VirtualNetwork({
      getLinks: () => this.getCircuit().links ?? [],
      isOnline: (id) => this.states.get(id) === "running",
      onTraffic,
    });
  }

  comp(id) { return this.getCircuit().components.find((c) => c.id === id); }
  boards() { return this.getCircuit().components.filter((c) => REGISTRY[c.type]?.programmable); }
  appliances() { return this.getCircuit().components.filter((c) => REGISTRY[c.type]?.device); }

  // Un appareil réseau tourne en tâche de fond (tick toutes les 5 ms), sans sketch.
  startDevice(id) {
    this.stopDevice(id);
    const c = this.comp(id);
    const Dev = REGISTRY[c.type].device;
    this.net.reset(id);
    const dev = new Dev(c, this.net.port(id), { onChange: () => this.onChange(id), log: (t) => this.onSerial(id, t) });
    const timer = setInterval(() => { try { dev.tick(); } catch (e) { this.onSerial(id, `Erreur : ${e.message}`); } }, 5);
    this.devices.set(id, { dev, timer });
    this.states.set(id, "running");
    this.onState(id, "running");
    this.onChange(id);
  }

  stopDevice(id) {
    const d = this.devices.get(id);
    if (!d) return;
    clearInterval(d.timer);
    this.devices.delete(id);
    this.net.reset(id);
    this.states.set(id, "stopped");
    this.onState(id, "stopped");
  }

  resimulate() {
    const circuit = this.getCircuit();
    this.sim = simulate(circuit);
    if (!this.sim.ok) return this.sim;
    for (const c of circuit.components) {
      if (!REGISTRY[c.type]?.programmable) continue;
      const avg = this.sim.comps.get(c.id)?.avg ?? {};
      c.rt = c.rt ?? {};
      c.rt.lastRead = Object.fromEntries(GPIOS.map((g) => [g, REGISTRY[c.type].digitalRead(c, avg, g)]));
    }
    return this.sim;
  }

  runner(id) {
    if (this.runners.has(id)) return this.runners.get(id);
    const bench = this;
    const r = new SketchRunner({
      pins: GPIOS, inputOnly: INPUT_ONLY, adc: ADC,
      setPin(gpio, state) {
        const b = bench.comp(id);
        if (!b) return;
        b.rt = b.rt ?? {};
        const old = b.rt.pins?.[gpio];
        if (old && old.mode === state.mode && old.level === state.level && old.duty === state.duty) return; // rien ne change
        b.rt.pins = { ...b.rt.pins, [gpio]: state };
        bench.resimulate();
        bench.onChange(id);
      },
      read(gpio) { return bench.comp(id)?.rt?.lastRead?.[gpio] ?? 0; },
      analog(gpio) {
        const b = bench.comp(id);
        return REGISTRY[b.type].analogRead(b, bench.sim?.comps?.get(b.id)?.avg ?? {}, gpio);
      },
      net: this.net.port(id),
    }, {
      log: (t) => this.onSerial(id, t),
      onState: (s, msg) => { this.states.set(id, s); this.onState(id, s, msg); },
    });
    r.loopPause = this.loopPause;
    this.runners.set(id, r);
    return r;
  }

  /** Reset (bouton EN) puis exécution du code de la carte. */
  start(id) {
    const b = this.comp(id);
    if (!b) return;
    if (REGISTRY[b.type].device) return this.startDevice(id);
    const r = this.runner(id);
    r.stop();
    this.net.reset(id);
    b.rt = { pins: {} };
    this.resimulate();
    this.onChange(id);
    this.onSerial(id, "--- reset (EN) ---");
    r.start(b.code ?? "");
  }

  stop(id) {
    if (this.devices.has(id)) return this.stopDevice(id);
    this.runners.get(id)?.stop();
    this.net.reset(id);
    const b = this.comp(id);
    if (b) b.rt = { pins: {} };
    this.resimulate();
    this.onChange(id);
  }

  startAll() {
    for (const a of this.appliances()) this.startDevice(a.id);
    for (const b of this.boards()) this.start(b.id);
  }

  stopAll() {
    for (const id of [...this.devices.keys()]) this.stopDevice(id);
    for (const [id, r] of this.runners) { r.stop(); this.net.reset(id); }
    this.runners.clear();
  }

  /** Oublie les cartes qui ne sont plus sur le plan. */
  prune() {
    const ids = new Set(this.boards().map((b) => b.id));
    const devs = new Set(this.appliances().map((a) => a.id));
    for (const id of [...this.devices.keys()]) if (!devs.has(id)) this.stopDevice(id);
    for (const [id, r] of this.runners) if (!ids.has(id)) { r.stop(); this.runners.delete(id); this.states.delete(id); this.net.reset(id); }
  }

  state(id) { return this.states.get(id) ?? "stopped"; }
}
