// Exécution d'un sketch Arduino (sous-ensemble) sur l'ESP32 simulé.
// Le C++ est converti en JavaScript asynchrone : delay() rend la main au navigateur.

const TYPES = "(?:unsigned\\s+(?:int|long|char)|int|long|float|double|bool|boolean|byte|char|String|size_t|u?int(?:8|16|32|64)_t)";
const STOP = Symbol("stop");

export function transpile(src) {
  let s = src.replace(/^\s*#.*$/gm, "");
  const fnNames = [];
  s = s.replace(new RegExp(`\\b(?:static\\s+)?(?:void|${TYPES})\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{`, "g"), (m, name, args) => {
    fnNames.push(name);
    const params = args.split(",").map((a) => a.trim().split(/[\s*&]+/).pop().replace(/\[\s*\w*\s*\]/g, "")).filter((a) => a && a !== "void");
    return `async function ${name}(${params.join(", ")}) {`;
  });
  s = s.replace(new RegExp(`\\b(const\\s+)?(?:static\\s+)?(?:volatile\\s+)?${TYPES}\\s+(?=[A-Za-z_])`, "g"), (m, c) => (c ? "const " : "let "));
  s = s.replace(/\b(let|const)\s+(\w+)\s*\[\s*\w*\s*\]\s*=\s*\{([^}]*)\}/g, "$1 $2 = [$3]");
  // Tableau sans initialiseur (uint8_t buf[64];) : rempli de zéros, comme une variable globale C.
  s = s.replace(/\b(let|const)\s+(\w+)\s*\[\s*(\w+)\s*\]\s*;/g, "$1 $2 = new Array($3).fill(0);");
  s = s.replace(new RegExp(`\\(\\s*${TYPES}\\s*\\)`, "g"), "");
  s = s.replace(/\bdelay\s*\(/g, "await delay(").replace(/\bdelayMicroseconds\s*\(/g, "await delayMicroseconds(");
  for (const f of fnNames) {
    if (f === "setup" || f === "loop") continue;
    s = s.replace(new RegExp(`(?<!function\\s)\\b${f}\\s*\\(`, "g"), `await ${f}(`);
  }
  return s;
}

/**
 * board : { pins: liste des GPIO disponibles, inputOnly: Set, adc: Set,
 *           setPin(gpio, state), read(gpio) -> 0|1, analog(gpio) -> 0..4095,
 *           net?: port du réseau virtuel (voir engine/network.js) }
 */
export class SketchRunner {
  constructor(board, { log, onState }) {
    this.board = board; this.log = log; this.onState = onState;
    this.token = null; this.timers = new Set();
  }

  stop() {
    this.token = null;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.onState("stopped");
  }

  async start(source) {
    this.stop();
    const token = (this.token = {});
    const t0 = performance.now();
    const alive = () => this.token === token;
    const b = this.board;
    const wait = (ms) => new Promise((resolve, reject) => {
      if (!alive()) return reject(STOP);
      const id = setTimeout(() => { this.timers.delete(cancel); alive() ? resolve() : reject(STOP); }, ms);
      const cancel = () => { clearTimeout(id); reject(STOP); };
      this.timers.add(cancel);
    });
    const checkPin = (pin) => {
      if (!b.pins.includes(pin)) throw new Error(`GPIO${pin} n'est pas disponible sur cette carte (broches : ${b.pins.join(", ")}).`);
    };
    const modes = {};
    const bytesOf = (buf, len) => Array.from(buf.slice(0, len ?? buf.length), (x) => Number(x) & 0xff);
    const copyInto = (buf, msg) => {
      if (!msg) return 0;
      const n = Math.min(msg.length, buf.length);
      for (let i = 0; i < n; i++) buf[i] = msg[i];
      return n;
    };
    const api = {
      HIGH: 1, LOW: 0, OUTPUT: "OUTPUT", INPUT: "INPUT", INPUT_PULLUP: "INPUT_PULLUP", INPUT_PULLDOWN: "INPUT_PULLDOWN",
      true: true, false: false, PI: Math.PI, HEX: 16, DEC: 10, BIN: 2,
      String: (v = "", base) => (base && typeof v === "number" ? Math.trunc(v).toString(base).toUpperCase() : String(v)),
      pinMode(pin, mode) {
        checkPin(pin);
        if (mode === "OUTPUT" && b.inputOnly.has(pin)) { api.Serial.println(`E (gpio) : GPIO${pin} ne peut être utilisée qu'en entrée`); return; }
        if (b.inputOnly.has(pin) && mode !== "INPUT") { api.Serial.println(`W (gpio) : GPIO${pin} n'a pas de résistance de pull interne, mode ignoré`); mode = "INPUT"; }
        modes[pin] = mode;
        b.setPin(pin, { mode, level: 0 });
      },
      digitalWrite(pin, val) {
        checkPin(pin);
        const mode = modes[pin] === "OUTPUT" ? "OUTPUT" : modes[pin];
        if (mode !== "OUTPUT") return; // comme sur ESP32 : sans effet si la broche n'est pas en sortie
        b.setPin(pin, { mode: "OUTPUT", level: val ? 1 : 0 });
      },
      digitalRead(pin) { checkPin(pin); return b.read(pin); },
      analogRead(pin) {
        checkPin(pin);
        if (!b.adc.has(pin)) { api.Serial.println(`E (adc) : GPIO${pin} n'est pas une entrée analogique`); return 0; }
        return b.analog(pin);
      },
      analogWrite(pin, val) {
        checkPin(pin);
        if (b.inputOnly.has(pin)) { api.Serial.println(`E (ledc) : GPIO${pin} ne peut pas générer de PWM`); return; }
        modes[pin] = "PWM";
        b.setPin(pin, { mode: "PWM", duty: Math.min(255, Math.max(0, val)) / 255 });
      },
      delay: (ms) => wait(Math.max(0, ms)),
      delayMicroseconds: (us) => wait(us / 1000),
      millis: () => Math.floor(performance.now() - t0),
      micros: () => Math.floor((performance.now() - t0) * 1000),
      random: (a, c) => (c === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (c - a))),
      map: (x, inMin, inMax, outMin, outMax) => Math.trunc(((x - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin),
      constrain: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
      abs: Math.abs, min: Math.min, max: Math.max, sqrt: Math.sqrt, pow: Math.pow, sin: Math.sin, cos: Math.cos,
      // Liens virtuels (non électriques). Les tableaux sont passés par référence, comme un uint8_t* en C.
      Rj45: {
        begin() { return true; },
        linkUp() { return !!b.net?.rj45Linked(); },
        send(buf, len) { return !!b.net?.rj45Send(bytesOf(buf, len)); },
        receive(buf) { return copyInto(buf, b.net?.rj45Receive()); },
      },
      EspNow: {
        begin(canal = 1) { return !!b.net?.espnowBegin(canal); },
        broadcast(buf, len) { return !!b.net?.espnowSend(bytesOf(buf, len)); },
        receive(buf) { return copyInto(buf, b.net?.espnowReceive()); },
      },
      Serial: {
        line: "",
        begin() {},
        print(v, d) { this.line += typeof v === "number" && d !== undefined ? v.toFixed(d) : String(v); },
        println(v = "", d) { this.print(v, d); log(this.line); this.line = ""; },
      },
    };
    const log = this.log;
    let prog;
    try {
      const js = transpile(source);
      prog = new Function("api", `with (api) {\n${js}\nreturn { setup: typeof setup === "function" ? setup : null, loop: typeof loop === "function" ? loop : null };\n}`)(api);
    } catch (e) {
      this.onState("error", `Erreur de compilation : ${e.message}`);
      this.token = null;
      return;
    }
    if (!prog.loop) { this.onState("error", "Il manque la fonction loop()."); this.token = null; return; }
    this.onState("running");
    try {
      if (prog.setup) await prog.setup();
      while (alive()) {
        await prog.loop();
        await wait(this.loopPause ?? 0);
      }
    } catch (e) {
      if (e === STOP) return;
      this.token = null;
      this.onState("error", `Erreur à l'exécution : ${e.message}`);
    }
  }
}
