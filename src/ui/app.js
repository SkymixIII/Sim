// Interface : plan de travail SVG, palette, panneau de mesures, oscilloscope, code ESP32.
import { COMPONENTS, REGISTRY, defaultParams } from "../components/index.js";
import { ESP32_GPIO } from "../components/esp32.js";
import { SCOPE_COLORS } from "../components/instruments.js";
import { pinPositions, rotatePoint } from "../engine/circuit.js";
import { Simulation } from "../engine/transient.js";
import { fmt, parseSI } from "../engine/units.js";
import { SketchRunner } from "../runtime/arduino.js";
import { EXAMPLES, EXAMPLE_SKETCH } from "./examples.js";
import { Scope, TIME_DIVS, VOLT_DIVS } from "./scope.js";

const G = 20;          // pixels par pas de grille
const COLS = 80, ROWS = 48;
const STORE = "etabli.circuit.v1", STORE_CODE = "etabli.code.v1", STORE_UI = "etabli.ui.v1";

const $ = (id) => document.getElementById(id);
const svg = $("canvas");
const wrap = $("canvas-wrap");
svg.setAttribute("width", COLS * G);
svg.setAttribute("height", ROWS * G);

const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

let circuit = (() => {
  try { const c = JSON.parse(load(STORE)); if (c?.components?.every((x) => REGISTRY[x.type])) return c; } catch { /* exemple */ }
  return null;
})();
const firstVisit = !circuit;
if (!circuit) circuit = EXAMPLES[0].circuit();

let view = null;           // dernier bilan de simulation : { ok, net, nodeV, comps }
let selection = null;      // { kind: "comp" | "wire", id }
let tool = "select";       // "select" | "wire" | { place: type }
let wireFrom = null;       // point de départ d'un fil
let hover = null;          // point de grille sous la souris
let drag = null;
let uid = Date.now() % 1e6;
const newId = (p) => `${p}${(uid++).toString(36)}`;

// ---------- Simulation dans le temps ----------
let sim = new Simulation(circuit);
let running = true;
let speed = 1;
let rate = 1;              // vitesse réellement atteinte / vitesse demandée
let needRender = true;
const timers = [];         // réveils du sketch, en temps simulé
const clock = {
  now: () => sim.t * 1000,
  schedule(ms, fn) {
    const tm = { at: sim.t + Math.max(ms, 0.005) / 1000, fn };
    timers.push(tm);
    return () => { const i = timers.indexOf(tm); if (i >= 0) timers.splice(i, 1); };
  },
};
const macrotask = (() => {
  const ch = new MessageChannel();
  let resolve = null;
  ch.port1.onmessage = () => { const r = resolve; resolve = null; r?.(); };
  return () => new Promise((r) => { resolve = r; ch.port2.postMessage(0); });
})();

const scope = new Scope($("scope-canvas"));
let scopeOpen = false;
let scopeMap = [null, null, null, null];

function persist() {
  const clean = { components: circuit.components.map(({ rt, ...c }) => c), wires: circuit.wires };
  save(STORE, JSON.stringify(clean));
}

function syncScope() {
  scopeMap = [null, null, null, null];
  for (const c of circuit.components) {
    const def = REGISTRY[c.type];
    const ch = c.params?.ch;
    if (!def.instrument || !ch || scopeMap[ch - 1]) continue;
    const key = def.scopeKey?.(c) ?? def.instrument;
    scopeMap[ch - 1] = { id: c.id, key, unit: key === "I" ? "A" : "V", name: def.name };
  }
  scopeMap.forEach((m, i) => { const ch = scope.ch[i]; ch.active = !!m; ch.unit = m?.unit ?? "V"; ch.name = m?.name ?? ""; });
  renderScopeSide();
}

const vals = new Float64Array(4);
function onStep(t) {
  if (!scopeOpen) return;
  const res = sim.last.results, els = sim.prep.els;
  for (let c = 0; c < 4; c++) {
    const m = scopeMap[c];
    if (!m) { vals[c] = NaN; continue; }
    if (m.prep !== sim.prep) { m.prep = sim.prep; m.j = els.findIndex((el) => el.inst.id === m.id); }
    vals[c] = m.j >= 0 ? res[m.j][m.key] ?? NaN : NaN;
  }
  scope.record(t, vals);
}
sim.onStep = onStep;

/** À appeler après toute modification. structural : le schéma a changé (sinon : une entrée a bougé). */
function touch({ structural = true, persistNow = true } = {}) {
  if (structural) { sim.invalidate(); syncScope(); } else sim.poke();
  if (persistNow) persist();
  needRender = true;
  if (!running) { sim.frame(); sim.sync(); sim.snapStats(); view = sim.frame(); renderInspectorLive(); renderStatus(); }
}

async function runUntil(target, deadline) {
  while (sim.t < target - 1e-15 && !sim.error && performance.now() < deadline) {
    let next = Infinity;
    for (const tm of timers) if (tm.at < next) next = tm.at;
    sim.advance(Math.min(target, next), deadline);
    const due = timers.filter((tm) => tm.at <= sim.t + 1e-12);
    if (!due.length) continue;
    for (const tm of due) { const i = timers.indexOf(tm); if (i >= 0) timers.splice(i, 1); tm.fn(); }
    await macrotask(); // laisse le sketch s'exécuter jusqu'à son prochain delay()
  }
}

let lastReal = performance.now(), frameNo = 0;
async function tick() {
  const now = performance.now();
  const dtReal = Math.min(0.1, Math.max(1e-3, (now - lastReal) / 1000));
  lastReal = now;
  try {
    if (running) {
      const t0 = sim.t;
      sim.tau = Math.max(1e-7, 0.05 * speed);
      sim.hMaxUser = scopeOpen ? Math.min(1e-3, scope.tdiv / 25) : 1e-3;
      await runUntil(sim.t + dtReal * speed, now + 11);
      rate += 0.15 * ((sim.t - t0) / (dtReal * speed) - rate);
    }
    view = sim.frame();
    frameNo++;
    if (needRender || frameNo % 3 === 0) { needRender = false; render(); }
    if (frameNo % 10 === 0) { renderInspectorLive(); renderStatus(); updateScopeMeasures(); }
    if (scopeOpen) scope.draw();
  } catch (e) {
    console.error(e);
    $("status").innerHTML = `<span class="bad">Erreur interne : ${esc(e.message)}</span>`;
  }
  requestAnimationFrame(tick);
}

function setRunning(on) {
  running = on;
  $("sim-run").textContent = on ? "Pause" : "Reprendre";
  $("sim-run").classList.toggle("active", !on);
  lastReal = performance.now();
  renderStatus();
}

function resetTime() {
  const wasRunning = runner?.token;
  runner?.stop();
  timers.length = 0;
  for (const c of circuit.components) if (c.type === "esp32") c.rt = { pins: {} };
  sim.reset();
  scope.clear();
  needRender = true;
  if (wasRunning) startSketch();
  if (!running) touch({ persistNow: false });
}

function loadCircuit(next, { sketch, scopeSettings } = {}) {
  runner?.stop();
  timers.length = 0;
  circuit = next;
  sim = new Simulation(circuit);
  sim.onStep = onStep;
  selection = null;
  scope.clear();
  scope.running = true;
  if (scopeSettings) {
    scope.tdiv = scopeSettings.tdiv ?? scope.tdiv;
    scope.stacked = !!scopeSettings.stacked;
    scope.trig.src = 0;
    for (const ch of scope.ch) ch.vdiv = 0;
  }
  if (sketch !== undefined) { codeEl.value = sketch; save(STORE_CODE, sketch); }
  syncScope();
  syncScopeControls();
  setScopeOpen(scopeMap.some(Boolean));
  persist();
  attachRunner();
  if (runner) startSketch();
  if (!running) setRunning(true);
  needRender = true;
  renderInspector();
  wrap.scrollTo(0, 0);
}

// ---------- Rendu du plan de travail ----------
const nodeVoltage = (x, y) => (view?.ok ? view.nodeV.get(`${x},${y}`) : undefined);

function wireColor(v, vmax) {
  if (v === undefined || !Number.isFinite(v)) return "var(--trace-lo)";
  const t = Math.max(0, Math.min(1, v / vmax));
  return `color-mix(in oklab, var(--trace-hi) ${Math.round(t * 100)}%, var(--trace-lo))`;
}

function compLabelPos(comp, def) {
  const b = def.bounds;
  const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => rotatePoint(x, y, comp.rot || 0));
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const vertical = (comp.rot || 0) % 2 === 1;
  if (vertical) return { x: (comp.x + Math.max(...xs)) * G + 8, y: (comp.y + (Math.min(...ys) + Math.max(...ys)) / 2) * G - 4, anchor: "start" };
  return { x: (comp.x + (Math.min(...xs) + Math.max(...xs)) / 2) * G, y: (comp.y + Math.min(...ys)) * G - 19, anchor: "middle" };
}

function readingText(comp, def, res) {
  if (!res || comp.damaged) return comp.damaged ? "détruit" : "";
  const a = res.avg;
  if (def.reading) return def.reading(comp, a);
  switch (comp.type) {
    case "resistor": case "led": case "diode": return fmt(Math.abs(a.I), "A");
    case "switch": case "button": return a.closed > 0.5 ? fmt(Math.abs(a.I), "A") : "ouvert";
    case "battery": case "dc": return fmt(a.I, "A");
    case "potentiometer": return `W ${fmt(a.Vw, "V")}`;
    default: return "";
  }
}

function render() {
  const vmax = Math.max(3.3, ...[...(view?.nodeV?.values() ?? [])].map(Math.abs).filter(Number.isFinite));
  let out = "";
  // Grille
  out += `<defs><pattern id="dots" width="${G}" height="${G}" patternUnits="userSpaceOnUse"><circle class="gridpt" cx="${G / 2}" cy="${G / 2}" r="1.1"/></pattern></defs>`;
  out += `<rect x="${-G / 2}" y="${-G / 2}" width="${COLS * G}" height="${ROWS * G}" fill="url(#dots)" transform="translate(${G / 2},${G / 2})"/>`;

  // Comptage des connexions par point (pour les points de jonction)
  const degree = new Map();
  const bump = (x, y) => degree.set(`${x},${y}`, (degree.get(`${x},${y}`) ?? 0) + 1);
  for (const w of circuit.wires) { bump(w.x1, w.y1); bump(w.x2, w.y2); }
  for (const c of circuit.components) for (const p of pinPositions(c)) bump(p.x, p.y);

  // Fils
  for (const w of circuit.wires) {
    const v = nodeVoltage(w.x1, w.y1);
    const isSel = selection?.kind === "wire" && selection.id === w.id;
    out += `<g data-wire="${w.id}"><line class="wire${isSel ? " sel" : ""}" x1="${w.x1 * G}" y1="${w.y1 * G}" x2="${w.x2 * G}" y2="${w.y2 * G}" style="stroke:${wireColor(v, vmax)}"/>`
      + `<line class="wire-hit" x1="${w.x1 * G}" y1="${w.y1 * G}" x2="${w.x2 * G}" y2="${w.y2 * G}"/></g>`;
  }

  // Composants
  let labels = "";
  for (const c of circuit.components) {
    const def = REGISTRY[c.type];
    const res = view?.ok ? view.comps.get(c.id) : undefined;
    const b = def.bounds;
    const cls = ["comp", selection?.kind === "comp" && selection.id === c.id ? "sel" : "", c.damaged ? "dead" : "", res?.info.warnings.length ? "alert" : "", def.interactive ? "interactive" : ""].join(" ");
    out += `<g class="${cls}" data-comp="${c.id}" transform="translate(${c.x * G},${c.y * G}) rotate(${(c.rot || 0) * 90})">`
      + `<rect class="hit" x="${b.x * G - 4}" y="${b.y * G - 4}" width="${b.w * G + 8}" height="${b.h * G + 8}" rx="6"/>`
      + def.symbol.call(def, c, res?.avg) + `</g>`;
    const lbl = def.label?.(c);
    if (lbl || res) {
      const p = compLabelPos(c, def);
      const reading = readingText(c, def, res);
      const bad = c.damaged || res?.info.warnings.some((w) => w.level === "danger");
      if (lbl) labels += `<text class="label" x="${p.x}" y="${p.y}" text-anchor="${p.anchor}">${esc(lbl)}</text>`;
      if (reading) labels += `<text class="reading${bad ? " bad" : ""}" x="${p.x}" y="${p.y + (lbl ? 13 : 0)}" text-anchor="${p.anchor}">${esc(reading)}</text>`;
    }
  }
  out += labels;

  // Broches et jonctions
  for (const c of circuit.components) {
    for (const p of pinPositions(c)) {
      const linked = (degree.get(`${p.x},${p.y}`) ?? 0) > 1 || nodeOnWire(p);
      out += `<circle class="pinpt${linked ? " linked" : ""}" data-pin="${p.x},${p.y}" cx="${p.x * G}" cy="${p.y * G}" r="${linked ? 2.6 : 4}"/>`;
    }
  }
  for (const [k, d] of degree) {
    if (d < 3) continue;
    const [x, y] = k.split(",").map(Number);
    out += `<circle class="junction" cx="${x * G}" cy="${y * G}" r="4"/>`;
  }

  // Aperçus : fil en cours, composant à poser
  if (wireFrom && hover) {
    out += `<polyline class="preview" points="${lPath(wireFrom, hover).map(([x, y]) => `${x * G},${y * G}`).join(" ")}"/>`;
  }
  if (tool.place && hover) {
    const def = REGISTRY[tool.place];
    out += `<g class="ghost" transform="translate(${hover.x * G},${hover.y * G})">${def.symbol.call(def, { params: defaultParams(def), rt: {} }, undefined)}</g>`;
  }
  svg.innerHTML = out;
}

// Le point est-il au milieu d'un fil (donc connecté à lui) ?
function nodeOnWire(p) {
  for (const w of circuit.wires) {
    if (w.x1 === w.x2 ? p.x === w.x1 && p.y > Math.min(w.y1, w.y2) && p.y < Math.max(w.y1, w.y2) : w.y1 === w.y2 && p.y === w.y1 && p.x > Math.min(w.x1, w.x2) && p.x < Math.max(w.x1, w.x2)) return true;
  }
  return false;
}

// Chemin en L : horizontal puis vertical.
function lPath(a, b) {
  if (a.x === b.x || a.y === b.y) return [[a.x, a.y], [b.x, b.y]];
  return [[a.x, a.y], [b.x, a.y], [b.x, b.y]];
}

// ---------- Palette ----------
function partIcon(def) {
  // Cadre du symbole (boîte + broches), ramené dans une vignette de 44 × 24.
  const b = def.bounds;
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  for (const p of def.pins) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const w = (x1 - x0) * G, h = (y1 - y0) * G;
  const scale = Math.min(40 / w, 21 / h, 0.5);
  const tx = 22 - (x0 * G + w / 2) * scale, ty = 12 - (y0 * G + h / 2) * scale;
  const body = def.symbol.call(def, { params: defaultParams(def), rt: {} }, undefined)
    .replace(/<text[\s\S]*?<\/text>/g, "").replace(/class="(fill|ic|usb|board|module|dmm|dial|jack[^"]*)"/g, 'style="fill:var(--ink);stroke:none"').replace(/<circle class="pin[^>]*>/g, "");
  return `<svg viewBox="0 0 44 24" aria-hidden="true"><g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(3)})" style="stroke:var(--ink);stroke-width:${(1.3 / scale).toFixed(1)};fill:none;stroke-linecap:round;stroke-linejoin:round">${body}</g></svg>`;
}
const iconCache = new Map();
const iconOf = (def) => { if (!iconCache.has(def.type)) iconCache.set(def.type, partIcon(def)); return iconCache.get(def.type); };
const closedCats = new Set(firstVisit || !load(STORE_UI) ? ["Logique 74HC"] : JSON.parse(load(STORE_UI)).closed ?? []);

function renderPalette() {
  const q = $("palette-search").value.trim().toLowerCase();
  const cats = new Map();
  for (const d of COMPONENTS) {
    if (q && !`${d.name} ${d.type} ${d.category} ${d.summary} ${d.params.flatMap((p) => p.options?.map((o) => o.label) ?? []).join(" ")}`.toLowerCase().includes(q)) continue;
    if (!cats.has(d.category)) cats.set(d.category, []);
    cats.get(d.category).push(d);
  }
  $("palette-list").innerHTML = cats.size ? [...cats].map(([cat, defs]) => `<details class="cat" data-cat="${esc(cat)}"${q || !closedCats.has(cat) ? " open" : ""}><summary><h2>${esc(cat)}</h2><span class="count">${defs.length}</span></summary><div class="parts">${defs.map((d) =>
    `<button class="part${tool.place === d.type ? " armed" : ""}" data-type="${d.type}" title="${esc(d.summary)}">${iconOf(d)}<span>${esc(d.name)}</span></button>`).join("")}</div></details>`).join("")
    : `<p class="none">Aucun composant ne correspond. Demandez-le dans le chat du projet.</p>`;
}
$("palette-search").addEventListener("input", renderPalette);
$("palette-list").addEventListener("toggle", (e) => {
  const cat = e.target.dataset?.cat;
  if (!cat || $("palette-search").value.trim()) return;
  if (e.target.open) closedCats.delete(cat); else closedCats.add(cat);
  save(STORE_UI, JSON.stringify({ closed: [...closedCats] }));
}, true);
$("palette-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".part");
  if (!btn) return;
  setTool(tool.place === btn.dataset.type ? "select" : { place: btn.dataset.type });
});

function setTool(t) {
  tool = t;
  wireFrom = null;
  $("tool-select").classList.toggle("active", t === "select");
  $("tool-wire").classList.toggle("active", t === "wire");
  for (const el of document.querySelectorAll(".part")) el.classList.toggle("armed", el.dataset.type === t.place);
  render();
}

// ---------- Interaction sur le plan ----------
function gridPoint(e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Math.round(p.x / G), y: Math.round(p.y / G), px: p.x, py: p.y };
}

function isConnectionPoint(p) {
  for (const c of circuit.components) for (const q of pinPositions(c)) if (q.x === p.x && q.y === p.y) return true;
  return circuit.wires.some((w) => (w.x1 === p.x && w.y1 === p.y) || (w.x2 === p.x && w.y2 === p.y)) || nodeOnWire(p);
}

function addWire(a, b) {
  const pts = lPath(a, b);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    if (x1 !== x2 || y1 !== y2) circuit.wires.push({ id: newId("w"), x1, y1, x2, y2 });
  }
}

function placeComponent(type, p) {
  const def = REGISTRY[type];
  const comp = { id: newId(type.slice(0, 3)), type, x: p.x, y: p.y, rot: 0, params: defaultParams(def) };
  if (type === "probe") {
    // Première voie libre de l'oscilloscope.
    const used = new Set(circuit.components.map((c) => c.params?.ch).filter(Boolean));
    comp.params.ch = [1, 2, 3, 4].find((n) => !used.has(n)) ?? 0;
    setScopeOpen(true);
  }
  circuit.components.push(comp);
  selection = { kind: "comp", id: comp.id };
  showTab("inspect");
  if (def.programmable) attachRunner();
}

svg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const p = gridPoint(e);
  if (tool.place) { placeComponent(tool.place, p); setTool("select"); touch(); renderInspector(); return; }

  const pinEl = e.target.closest("[data-pin]");
  const onEnd = Math.hypot(p.px - p.x * G, p.py - p.y * G) < 7 && isConnectionPoint(p) && !e.target.closest("[data-comp]");
  if (tool === "wire" || (tool === "select" && (pinEl || onEnd))) {
    if (!wireFrom) {
      if (tool !== "wire") setTool("wire");
      wireFrom = { x: p.x, y: p.y };
      render();
      return;
    }
    if (p.x === wireFrom.x && p.y === wireFrom.y) { wireFrom = null; render(); return; }
    const end = { x: p.x, y: p.y };
    const finishes = isConnectionPoint(end);
    addWire(wireFrom, end);
    wireFrom = finishes ? null : end;
    if (finishes) setTool("select");
    touch();
    return;
  }

  const compEl = e.target.closest("[data-comp]");
  const wireEl = e.target.closest("[data-wire]");
  if (compEl) {
    const comp = circuit.components.find((c) => c.id === compEl.dataset.comp);
    selection = { kind: "comp", id: comp.id };
    drag = { comp, start: p, origin: { x: comp.x, y: comp.y }, moved: false };
    svg.setPointerCapture(e.pointerId);
    const def = REGISTRY[comp.type];
    if (def.interactive && def.press(comp, true)) touch({ structural: false });
    render(); renderInspector();
  } else if (wireEl) {
    selection = { kind: "wire", id: wireEl.dataset.wire };
    render(); renderInspector();
  } else {
    selection = null;
    render(); renderInspector();
  }
});

svg.addEventListener("pointermove", (e) => {
  const p = gridPoint(e);
  const changed = !hover || hover.x !== p.x || hover.y !== p.y;
  hover = { x: p.x, y: p.y };
  if (drag) {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (dx || dy) drag.moved = true;
    if (drag.moved && changed) {
      drag.comp.x = drag.origin.x + dx; drag.comp.y = drag.origin.y + dy;
      render();
    }
  } else if (changed && (wireFrom || tool.place)) render();
  showTip(e, p);
});

svg.addEventListener("pointerup", () => {
  if (!drag) return;
  const { comp, moved } = drag;
  drag = null;
  const def = REGISTRY[comp.type];
  const pressed = def.interactive && def.press(comp, false);
  if (moved) touch(); else if (pressed) touch({ structural: false });
});
svg.addEventListener("pointerleave", () => { $("tip").hidden = true; });
svg.addEventListener("contextmenu", (e) => { if (wireFrom || tool.place) { e.preventDefault(); setTool("select"); } });

function showTip(e, p) {
  const tip = $("tip");
  const v = nodeVoltage(p.x, p.y);
  const near = Math.hypot(p.px - p.x * G, p.py - p.y * G) < 7;
  if (v === undefined || !near || drag) { tip.hidden = true; return; }
  let name = "";
  for (const c of circuit.components) {
    const pin = pinPositions(c).find((q) => q.x === p.x && q.y === p.y);
    if (pin && (pin.label || pin.id)) { name = `${pin.label ?? pin.id} · `; break; }
  }
  tip.textContent = `${name}${fmt(v, "V")} / masse`;
  const r = wrap.getBoundingClientRect();
  tip.style.left = `${e.clientX - r.left + wrap.scrollLeft + 12}px`;
  tip.style.top = `${e.clientY - r.top + wrap.scrollTop - 28}px`;
  tip.hidden = false;
}

// ---------- Actions ----------
function rotateSelection() {
  if (selection?.kind !== "comp") return;
  const c = circuit.components.find((x) => x.id === selection.id);
  if (!c || !REGISTRY[c.type].rotatable) return;
  c.rot = ((c.rot || 0) + 1) % 4;
  touch();
}
function deleteSelection() {
  if (!selection) return;
  if (selection.kind === "comp") circuit.components = circuit.components.filter((c) => c.id !== selection.id);
  else circuit.wires = circuit.wires.filter((w) => w.id !== selection.id);
  sim.circuit = circuit;
  selection = null;
  attachRunner();
  touch();
  renderInspector();
}
function repairAll() {
  for (const c of circuit.components) delete c.damaged;
  touch();
}

$("tool-select").onclick = () => setTool("select");
$("tool-wire").onclick = () => setTool(tool === "wire" ? "select" : "wire");
$("act-rotate").onclick = rotateSelection;
$("act-delete").onclick = deleteSelection;
$("act-repair").onclick = repairAll;
$("act-clear").onclick = () => loadCircuit({ components: [], wires: [] });
$("sim-run").onclick = () => setRunning(!running);
$("sim-reset").onclick = resetTime;
$("sim-speed").onchange = (e) => { speed = Number(e.target.value); rate = 1; sim.snapStats(); };
$("examples").innerHTML = `<option value="">Exemples…</option>${EXAMPLES.map((ex) => `<option value="${ex.id}">${esc(ex.name)}</option>`).join("")}`;
$("examples").onchange = (e) => {
  const ex = EXAMPLES.find((x) => x.id === e.target.value);
  e.target.value = "";
  if (ex) loadCircuit(ex.circuit(), { sketch: ex.sketch, scopeSettings: ex.scope ?? {} });
};

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, button")) return;
  if (e.key === "Escape") { setTool("select"); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (e.key === "r" || e.key === "R") rotateSelection();
  else if (e.key === "w" || e.key === "W") setTool("wire");
  else if (e.key === "v" || e.key === "V") setTool("select");
  else if (e.key === " ") { e.preventDefault(); setRunning(!running); }
});

// ---------- Panneau de mesures ----------
const rangeText = (p, val) => `${p.label} : ${p.display ? p.display(val) : `${Math.round(val * 100)} %`}`;

function paramField(def, comp, p) {
  const id = `param-${comp.id}-${p.key}`;
  const val = comp.params[p.key];
  if (p.kind === "select") {
    return `<label for="${id}">${p.label}<select id="${id}" data-param="${p.key}">${p.options.map((o) => `<option value="${o.value}"${String(o.value) === String(val) ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`;
  }
  if (p.kind === "range") return `<label for="${id}"><span>${rangeText(p, val)}</span><input type="range" id="${id}" data-param="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}"></label>`;
  if (p.kind === "bool") return `<label class="check" for="${id}"><input type="checkbox" id="${id}" data-param="${p.key}"${val ? " checked" : ""}>${p.label}</label>`;
  return `<label for="${id}">${p.label} (${p.unit})<input type="text" id="${id}" data-param="${p.key}" value="${fmt(val, p.unit).replace(` ${p.unit}`, "").replace(" ", "")}" inputmode="decimal"></label>`;
}

function renderInspector() {
  const panel = $("panel-inspect");
  if (!selection) {
    panel.innerHTML = `<div class="empty"><h2>Plan de travail</h2><p>Cliquez un composant pour lire ses mesures. Survolez une broche ou un fil pour lire sa tension.</p>
      <p>Pour câbler, glissez depuis une broche ou utilisez l'outil Fil (<kbd>W</kbd>). <kbd>R</kbd> pivote, <kbd>Suppr</kbd> supprime, <kbd>Échap</kbd> annule, <kbd>Espace</kbd> met en pause.</p>
      <p>Pour observer un signal, posez une <b>sonde d'oscilloscope</b> sur un fil. Voltmètre, ampèremètre et multimètre se branchent comme les vrais, et peuvent eux aussi être tracés sur une voie.</p>
      <p>Les composants maltraités se comportent comme en vrai : une LED sans résistance grille, un électrolytique à l'envers éclate, un régulateur surchargé chauffe.</p></div>`;
    return;
  }
  if (selection.kind === "wire") {
    const w = circuit.wires.find((x) => x.id === selection.id);
    const v = w && nodeVoltage(w.x1, w.y1);
    panel.innerHTML = `<div><h2>Fil</h2><p class="summary">Conducteur idéal. Toutes ses extrémités sont au même potentiel.</p></div>
      <table class="readings"><tr><td>Potentiel</td><td>${fmt(v, "V")}</td></tr></table><div class="row"><button data-act="delete">Supprimer le fil</button></div>`;
    return;
  }
  const comp = circuit.components.find((c) => c.id === selection.id);
  if (!comp) { selection = null; return renderInspector(); }
  const def = REGISTRY[comp.type];
  const res = view?.ok ? view.comps.get(comp.id) : undefined;
  const info = res?.info ?? { readings: [], warnings: [] };
  const ds = def.datasheet;
  panel.innerHTML = `
    <div><h2>${esc(def.name)}${def.label?.(comp) && !def.name.includes(def.label(comp)) ? ` · ${esc(def.label(comp))}` : ""}</h2><p class="summary">${esc(def.summary)}</p></div>
    ${info.warnings.length ? `<div class="alerts">${info.warnings.map((w) => `<div class="alert ${w.level}">${esc(w.text)}</div>`).join("")}</div>` : ""}
    ${def.params.length ? `<div class="params">${def.params.map((p) => paramField(def, comp, p)).join("")}</div>` : ""}
    ${info.readings.length ? `<div><h3>Mesures</h3><table class="readings">${info.readings.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></div>` : ""}
    <div class="row">${def.rotatable ? `<button data-act="rotate">Pivoter</button>` : ""}<button data-act="delete">Supprimer</button>${comp.damaged ? `<button data-act="repair" class="primary">Remplacer le composant</button>` : ""}${def.programmable ? `<button data-act="code">Ouvrir le code</button>` : ""}${def.instrument ? `<button data-act="scope">Oscilloscope</button>` : ""}</div>
    ${ds ? `<details class="datasheet"><summary>Fiche technique et modèle</summary><p>${esc(ds.source)}</p>${ds.notes.length ? `<ul>${ds.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</details>` : ""}`;
}

$("panel-inspect").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "rotate") rotateSelection();
  else if (act === "delete") deleteSelection();
  else if (act === "code") showTab("code");
  else if (act === "scope") setScopeOpen(true);
  else if (act === "repair") {
    const c = circuit.components.find((x) => x.id === selection?.id);
    if (c) { delete c.damaged; touch(); renderInspector(); }
  }
});
$("panel-inspect").addEventListener("change", (e) => {
  const key = e.target.dataset.param;
  if (!key || selection?.kind !== "comp") return;
  const comp = circuit.components.find((c) => c.id === selection.id);
  const p = REGISTRY[comp.type].params.find((q) => q.key === key);
  let value;
  if (p.kind === "bool") value = e.target.checked;
  else if (p.kind === "select") value = p.options.find((o) => String(o.value) === e.target.value).value;
  else if (p.kind === "range") value = Number(e.target.value);
  else {
    value = parseSI(e.target.value);
    if (!Number.isFinite(value) || (p.min !== undefined && value < p.min)) { e.target.setCustomValidity("Valeur invalide, ex. 220, 4k7, 100n, 1M"); e.target.reportValidity(); return; }
    e.target.setCustomValidity("");
  }
  comp.params[key] = value;
  if (key === "ch" && value) setScopeOpen(true);
  touch();
  renderInspector();
});
$("panel-inspect").addEventListener("input", (e) => {
  if (e.target.type !== "range") return;
  const comp = circuit.components.find((c) => c.id === selection?.id);
  const p = REGISTRY[comp.type].params.find((q) => q.key === e.target.dataset.param);
  comp.params[p.key] = Number(e.target.value);
  touch({ persistNow: false });
  e.target.previousElementSibling.textContent = rangeText(p, comp.params[p.key]);
});

function renderStatus() {
  const el = $("status");
  if (!view) return;
  const time = `<span>t = <b>${fmt(sim.t, "s", 4)}</b> · ${running ? (speed === 1 ? "temps réel" : `ralenti ÷${Math.round(1 / speed).toLocaleString("fr-FR")}`) : "<b>en pause</b>"}${running && rate < 0.8 ? ` <span class="warn" title="Le calcul ne suit pas la vitesse demandée : choisissez un ralenti.">(calcul à ${Math.max(1, Math.round(rate * 100))} % de cette vitesse)</span>` : ""}</span>`;
  if (!view.ok) { el.innerHTML = `${time}<span class="bad">${esc(view.error)}</span>`; return; }
  const alerts = [];
  for (const c of circuit.components) {
    const r = view.comps.get(c.id);
    if (r?.info.warnings.length) alerts.push([c, r.info.warnings[0]]);
  }
  el.innerHTML = `${time}<span><b>${view.net.nodeCount}</b> nœuds · <b>${circuit.components.length}</b> composants · 25 °C</span>`
    + (alerts.length ? `<span class="bad">${alerts.length} alerte${alerts.length > 1 ? "s" : ""} :</span> ${alerts.slice(0, 3).map(([c, w]) => `<button data-sel="${c.id}" title="${esc(w.text)}">${esc(REGISTRY[c.type].label?.(c) || REGISTRY[c.type].name)}</button>`).join(" ")}` : `<span>Aucune alerte</span>`);
}
$("status").addEventListener("click", (e) => {
  const id = e.target.dataset.sel;
  if (!id) return;
  selection = { kind: "comp", id };
  showTab("inspect"); render(); renderInspector();
});

// ---------- Oscilloscope ----------
function setScopeOpen(on) {
  scopeOpen = on;
  $("scope").hidden = !on;
  $("scope-toggle").classList.toggle("active", on);
  if (on) { scope.draw(); updateScopeMeasures(); }
}
const tdivLabel = (s) => `${fmt(s, "s")}/div`;
$("sc-tdiv").innerHTML = TIME_DIVS.map((d) => `<option value="${d}">${tdivLabel(d)}</option>`).join("");
$("sc-src").innerHTML = [1, 2, 3, 4].map((n) => `<option value="${n - 1}">CH${n}</option>`).join("");

function syncScopeControls() {
  $("sc-tdiv").value = String(scope.tdiv);
  $("sc-src").value = String(scope.trig.src);
  $("sc-edge").value = scope.trig.edge;
  $("sc-mode").value = scope.trig.mode;
  $("sc-stack").checked = scope.stacked;
  $("sc-run").textContent = scope.running ? "Figer" : "Relancer";
  $("sc-run").classList.toggle("active", !scope.running);
}
scope.onStop = syncScopeControls;
$("scope-toggle").onclick = () => setScopeOpen(!scopeOpen);
$("sc-close").onclick = () => setScopeOpen(false);
$("sc-run").onclick = () => { scope.running = !scope.running; scope.single = false; syncScopeControls(); };
$("sc-single").onclick = () => { scope.running = true; scope.single = true; scope.win = null; syncScopeControls(); };
$("sc-tdiv").onchange = (e) => { scope.tdiv = Number(e.target.value); scope.win = null; };
$("sc-src").onchange = (e) => { scope.trig.src = Number(e.target.value); };
$("sc-edge").onchange = (e) => { scope.trig.edge = e.target.value; };
$("sc-mode").onchange = (e) => { scope.trig.mode = e.target.value; };
$("sc-stack").onchange = (e) => { scope.stacked = e.target.checked; };
$("sc-csv").onclick = () => {
  const csv = scope.toCSV();
  if (!csv) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "oscilloscope.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};
const scopeCanvas = $("scope-canvas");
scopeCanvas.addEventListener("pointermove", (e) => { const r = scopeCanvas.getBoundingClientRect(); scope.cursor = (e.clientX - r.left) / r.width; if (!running) scope.draw(); });
scopeCanvas.addEventListener("pointerleave", () => { scope.cursor = null; if (!running) scope.draw(); });
scopeCanvas.addEventListener("wheel", (e) => {
  // Molette : change la base de temps.
  e.preventDefault();
  const i = TIME_DIVS.indexOf(scope.tdiv) + (e.deltaY > 0 ? 1 : -1);
  if (i < 0 || i >= TIME_DIVS.length) return;
  scope.tdiv = TIME_DIVS[i]; scope.win = null;
  syncScopeControls();
}, { passive: false });

function renderScopeSide() {
  $("scope-side").innerHTML = scope.ch.map((ch, i) => `<div class="sc-ch${ch.active ? "" : " off"}" style="--c:${SCOPE_COLORS[i]}">
    <div class="head"><span class="name">CH${i + 1}${ch.active ? ` · ${esc(ch.name)}` : " · libre"}</span>
    <select data-vdiv="${i}" aria-label="Calibre vertical de la voie ${i + 1}"${ch.active ? "" : " disabled"}><option value="0">Auto</option>${VOLT_DIVS.map((d) => `<option value="${d}"${ch.vdiv === d ? " selected" : ""}>${fmt(d, ch.unit)}/div</option>`).join("")}</select></div>
    <div class="meas" data-meas="${i}"></div></div>`).join("");
}
$("scope-side").addEventListener("change", (e) => {
  const i = e.target.dataset.vdiv;
  if (i === undefined) return;
  scope.ch[i].vdiv = Number(e.target.value);
  scope.ch[i].pos = 0;
});
function updateScopeMeasures() {
  if (!scopeOpen) return;
  scope.ch.forEach((ch, i) => {
    const el = document.querySelector(`[data-meas="${i}"]`);
    if (!el) return;
    const st = ch.stats;
    if (!ch.active || !st) { el.textContent = ch.active ? "—" : ""; return; }
    const u = ch.unit;
    const cell = (k, v) => `<span>${k} <b>${v}</b></span>`;
    el.innerHTML = cell("c-à-c", fmt(st.pp, u)) + cell("moy.", fmt(st.mean, u))
      + cell("min", fmt(st.min, u)) + cell("max", fmt(st.max, u))
      + cell("eff.", fmt(st.rms, u))
      + (Number.isFinite(st.freq) ? cell("f", fmt(st.freq, "Hz", 4)) + cell("cycl.", `${Math.round(st.duty * 100)} %`) : "");
  });
}

// ---------- Onglets ----------
function showTab(name) {
  for (const t of ["inspect", "code"]) {
    $(`tab-${t}`).classList.toggle("active", t === name);
    $(`tab-${t}`).setAttribute("aria-selected", t === name);
    $(`panel-${t}`).hidden = t !== name;
  }
}
$("tab-inspect").onclick = () => showTab("inspect");
$("tab-code").onclick = () => showTab("code");

// ---------- Code ESP32 ----------
const codeEl = $("code");
codeEl.value = load(STORE_CODE) ?? EXAMPLE_SKETCH;
codeEl.addEventListener("input", () => save(STORE_CODE, codeEl.value));
codeEl.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const { selectionStart: s, selectionEnd: t } = codeEl;
  codeEl.setRangeText("  ", s, t, "end");
});

const serialEl = $("serial");
function serialLog(text, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  serialEl.append(line);
  while (serialEl.childElementCount > 300) serialEl.firstChild.remove();
  serialEl.scrollTop = serialEl.scrollHeight;
}
$("serial-clear").onclick = () => { serialEl.textContent = ""; };

let runner = null;
const boardComp = () => circuit.components.find((c) => REGISTRY[c.type].programmable);

function attachRunner() {
  if (runner && boardComp()) return; // la carte est toujours là : le sketch continue
  runner?.stop();
  const comp = boardComp();
  if (!comp) { setRunState("stopped", runner ? "Carte retirée du plan de travail." : ""); runner = null; return; }
  const def = REGISTRY[comp.type];
  runner = new SketchRunner({
    pins: ESP32_GPIO.map((g) => g.gpio),
    inputOnly: new Set(ESP32_GPIO.filter((g) => g.inputOnly).map((g) => g.gpio)),
    adc: new Set(ESP32_GPIO.filter((g) => g.adc).map((g) => g.gpio)),
    clock,
    setPin(gpio, state) {
      const b = boardComp();
      if (!b) return;
      b.rt = b.rt ?? {};
      b.rt.pins = { ...b.rt.pins, [gpio]: state };
      sim.poke();
    },
    read(gpio) {
      const b = boardComp();
      if (!b) return 0;
      sim.sync();
      const level = def.digitalRead(b, sim.instant(b.id) ?? {}, gpio);
      b.rt = b.rt ?? {};
      b.rt.lastRead = { ...b.rt.lastRead, [gpio]: level };
      return level;
    },
    analog(gpio) {
      const b = boardComp();
      if (!b) return 0;
      sim.sync();
      return def.analogRead(b, sim.instant(b.id) ?? {}, gpio);
    },
  }, {
    log: (t) => serialLog(t),
    onState: setRunState,
  });
}

// Pendant l'exécution, on met à jour les mesures sans reconstruire les champs en cours d'édition.
function renderInspectorLive() {
  const a = document.activeElement;
  if (a?.closest?.("#panel-inspect") && a.matches("input, select")) return;
  if ($("panel-inspect").querySelector("details[open]") && running) {
    // Fiche technique ouverte : on ne rafraîchit que le tableau de mesures, pour ne pas la refermer.
    const comp = selection?.kind === "comp" && circuit.components.find((c) => c.id === selection.id);
    const info = comp && view?.ok ? view.comps.get(comp.id)?.info : null;
    const table = $("panel-inspect").querySelector("table.readings");
    if (info && table) table.innerHTML = info.readings.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
    return;
  }
  renderInspector();
}

function setRunState(state, msg) {
  const pill = $("run-state");
  pill.className = `pill ${state}`;
  pill.textContent = state === "running" ? "en cours" : state === "error" ? "erreur" : "arrêté";
  if (msg) serialLog(msg, state === "error" ? "err" : "");
}

function resetBoardPins() {
  const b = boardComp();
  if (b) b.rt = { pins: {} };
  sim.poke();
  needRender = true;
}
function startSketch() {
  if (!runner) attachRunner();
  if (!runner) return;
  resetBoardPins();
  serialLog("--- reset (EN) ---");
  runner.start(codeEl.value);
}
$("code-run").onclick = () => { if (!boardComp()) serialLog("Aucune carte programmable sur le plan de travail.", "err"); startSketch(); if (!running) setRunning(true); };
$("code-stop").onclick = () => { runner?.stop(); resetBoardPins(); };

// ---------- Démarrage ----------
if (firstVisit) { scope.tdiv = EXAMPLES[0].scope.tdiv; }
renderPalette();
syncScope();
syncScopeControls();
setScopeOpen(scopeMap.some(Boolean));
renderInspector();
attachRunner();
if (runner) { serialLog("--- démarrage ---"); runner.start(codeEl.value); }
setRunning(true);
wrap.scrollTo(0, 0);
requestAnimationFrame(tick);

// Accès pour le débogage et les tests de bout en bout.
window.etabli = { get sim() { return sim; }, get circuit() { return circuit; }, scope, loadExample: (id) => { const ex = EXAMPLES.find((x) => x.id === id); loadCircuit(ex.circuit(), { sketch: ex.sketch, scopeSettings: ex.scope ?? {} }); } };
