// Interface : plan de travail SVG, palette, panneau de mesures, code ESP32.
import { COMPONENTS, REGISTRY, defaultParams } from "../components/index.js";
import { ESP32_GPIO } from "../components/esp32.js";
import { simulate, pinPositions, rotatePoint } from "../engine/circuit.js";
import { fmt, parseSI } from "../engine/units.js";
import { SketchRunner } from "../runtime/arduino.js";
import { exampleCircuit, EXAMPLE_SKETCH } from "./example.js";

const G = 20;          // pixels par pas de grille
const COLS = 64, ROWS = 40;
const STORE = "etabli.circuit.v1", STORE_CODE = "etabli.code.v1";

const $ = (id) => document.getElementById(id);
const svg = $("canvas");
const wrap = $("canvas-wrap");
svg.setAttribute("width", COLS * G);
svg.setAttribute("height", ROWS * G);

const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };

let circuit = (() => {
  try { const c = JSON.parse(load(STORE)); if (c?.components?.every((x) => REGISTRY[x.type])) return c; } catch { /* exemple */ }
  return exampleCircuit();
})();
let sim = null;
let selection = null;      // { kind: "comp" | "wire", id }
let tool = "select";       // "select" | "wire" | { place: type }
let wireFrom = null;       // point de départ d'un fil
let hover = null;          // point de grille sous la souris
let drag = null;
let uid = Date.now() % 1e6;
const newId = (p) => `${p}${(uid++).toString(36)}`;

// ---------- Simulation ----------
function persist() {
  const clean = { components: circuit.components.map(({ rt, ...c }) => c), wires: circuit.wires };
  save(STORE, JSON.stringify(clean));
}

function resimulate() {
  sim = simulate(circuit);
  for (const c of circuit.components) {
    if (c.type === "esp32" && sim.ok) {
      const avg = sim.comps.get(c.id)?.avg ?? {};
      c.rt = c.rt ?? {};
      c.rt.lastRead = Object.fromEntries(ESP32_GPIO.map((g) => [g.gpio, REGISTRY.esp32.digitalRead(c, avg, g.gpio)]));
    }
  }
}

let frame = 0;
function refresh({ persistNow = true } = {}) {
  resimulate();
  if (persistNow) persist();
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); renderInspector(); renderStatus(); });
}

// ---------- Rendu du plan de travail ----------
const nodeVoltage = (x, y) => sim?.ok ? sim.nodeV.get(`${x},${y}`) : undefined;

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

function readingText(comp, res) {
  if (!res || comp.damaged) return comp.damaged ? "détruit" : "";
  const a = res.avg;
  switch (comp.type) {
    case "resistor": case "led": case "diode": return fmt(Math.abs(a.I), "A");
    case "switch": case "button": return a.closed ? fmt(Math.abs(a.I), "A") : "ouvert";
    case "battery": case "dc": return fmt(a.I, "A");
    case "potentiometer": return `W ${fmt(a.Vw, "V")}`;
    default: return "";
  }
}

function render() {
  const vmax = Math.max(3.3, ...[...(sim?.nodeV?.values() ?? [])].map(Math.abs).filter(Number.isFinite));
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
  for (const c of circuit.components) {
    const def = REGISTRY[c.type];
    const res = sim?.ok ? sim.comps.get(c.id) : undefined;
    const b = def.bounds;
    const cls = ["comp", selection?.kind === "comp" && selection.id === c.id ? "sel" : "", c.damaged ? "dead" : "", res?.info.warnings.length ? "alert" : "", def.interactive ? "interactive" : ""].join(" ");
    out += `<g class="${cls}" data-comp="${c.id}" transform="translate(${c.x * G},${c.y * G}) rotate(${(c.rot || 0) * 90})">`
      + `<rect class="hit" x="${b.x * G - 4}" y="${b.y * G - 4}" width="${b.w * G + 8}" height="${b.h * G + 8}" rx="6"/>`
      + def.symbol.call(def, c, res?.avg) + `</g>`;
    const lbl = def.label?.(c);
    if (lbl || res) {
      const p = compLabelPos(c, def);
      const reading = readingText(c, res);
      const bad = c.damaged || res?.info.warnings.some((w) => w.level === "danger");
      if (lbl) out += `<text class="label" x="${p.x}" y="${p.y}" text-anchor="${p.anchor}">${lbl}</text>`;
      if (reading) out += `<text class="reading${bad ? " bad" : ""}" x="${p.x}" y="${p.y + 13}" text-anchor="${p.anchor}">${reading}</text>`;
    }
  }

  // Broches et jonctions
  for (const c of circuit.components) {
    for (const p of pinPositions(c)) {
      const linked = (degree.get(`${p.x},${p.y}`) ?? 0) > 1;
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

// Chemin en L : horizontal puis vertical.
function lPath(a, b) {
  if (a.x === b.x || a.y === b.y) return [[a.x, a.y], [b.x, b.y]];
  return [[a.x, a.y], [b.x, a.y], [b.x, b.y]];
}

// ---------- Palette ----------
function partIcon(def) {
  const scale = def.type === "esp32" ? 0.11 : def.type === "ground" ? 0.6 : 0.5;
  const tx = def.type === "ground" ? 22 : def.type === "esp32" ? 11 : 2;
  const ty = def.type === "ground" ? 4 : def.type === "esp32" ? 1 : 12;
  return `<svg viewBox="0 0 44 24" aria-hidden="true"><g transform="translate(${tx},${ty}) scale(${scale})" style="stroke:var(--ink);stroke-width:${2 / scale * 0.6};fill:none">${def.symbol.call(def, { params: defaultParams(def), rt: {} }, undefined).replace(/class="fill"/g, 'style="fill:var(--ink)"').replace(/<text[^>]*>[^<]*<\/text>/g, "")}</g></svg>`;
}

function renderPalette() {
  const cats = new Map();
  for (const d of COMPONENTS) { if (!cats.has(d.category)) cats.set(d.category, []); cats.get(d.category).push(d); }
  $("palette-list").innerHTML = [...cats].map(([cat, defs]) => `<div class="cat"><h2>${cat}</h2><div class="parts">${defs.map((d) =>
    `<button class="part${tool.place === d.type ? " armed" : ""}" data-type="${d.type}" title="${d.summary}">${partIcon(d)}<span>${d.name}</span></button>`).join("")}</div></div>`).join("");
}
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
  renderPalette();
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
  return circuit.wires.some((w) => (w.x1 === p.x && w.y1 === p.y) || (w.x2 === p.x && w.y2 === p.y));
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
  circuit.components.push(comp);
  selection = { kind: "comp", id: comp.id };
  showTab("inspect");
  if (type === "esp32") attachRunner();
}

svg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const p = gridPoint(e);
  if (tool.place) { placeComponent(tool.place, p); setTool("select"); refresh(); return; }

  const pinEl = e.target.closest("[data-pin]");
  const onEnd = Math.hypot(p.px - p.x * G, p.py - p.y * G) < 7 && isConnectionPoint(p);
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
    refresh();
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
    if (def.interactive && def.press(comp, true)) refresh();
    else { render(); renderInspector(); }
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
  if (moved || pressed) refresh();
});
svg.addEventListener("pointerleave", () => { $("tip").hidden = true; });
svg.addEventListener("contextmenu", (e) => { if (wireFrom || tool.place) { e.preventDefault(); setTool("select"); } });

function showTip(e, p) {
  const tip = $("tip");
  const v = nodeVoltage(p.x, p.y);
  const near = Math.hypot(p.px - p.x * G, p.py - p.y * G) < 7;
  if (v === undefined || !near || drag) { tip.hidden = true; return; }
  tip.textContent = `${fmt(v, "V")} / masse`;
  const r = wrap.getBoundingClientRect();
  tip.style.left = `${e.clientX - r.left + wrap.scrollLeft + 12}px`;
  tip.style.top = `${e.clientY - r.top + wrap.scrollTop - 28}px`;
  tip.hidden = false;
}

// ---------- Actions ----------
function rotateSelection() {
  if (selection?.kind !== "comp") return;
  const c = circuit.components.find((x) => x.id === selection.id);
  if (!REGISTRY[c.type].rotatable) return;
  c.rot = ((c.rot || 0) + 1) % 4;
  refresh();
}
function deleteSelection() {
  if (!selection) return;
  if (selection.kind === "comp") circuit.components = circuit.components.filter((c) => c.id !== selection.id);
  else circuit.wires = circuit.wires.filter((w) => w.id !== selection.id);
  selection = null;
  attachRunner();
  refresh();
}
function repairAll() {
  for (const c of circuit.components) delete c.damaged;
  refresh();
}

$("tool-select").onclick = () => setTool("select");
$("tool-wire").onclick = () => setTool(tool === "wire" ? "select" : "wire");
$("act-rotate").onclick = rotateSelection;
$("act-delete").onclick = deleteSelection;
$("act-repair").onclick = repairAll;
$("act-reset").onclick = () => { circuit = exampleCircuit(); codeEl.value = EXAMPLE_SKETCH; save(STORE_CODE, codeEl.value); selection = null; attachRunner(); refresh(); };
$("act-clear").onclick = () => { circuit = { components: [], wires: [] }; selection = null; attachRunner(); refresh(); };

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  if (e.key === "Escape") { setTool("select"); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (e.key === "r" || e.key === "R") rotateSelection();
  else if (e.key === "w" || e.key === "W") setTool("wire");
  else if (e.key === "v" || e.key === "V") setTool("select");
});

// ---------- Panneau de mesures ----------
function paramField(def, comp, p) {
  const id = `param-${comp.id}-${p.key}`;
  const val = comp.params[p.key];
  if (p.kind === "select") {
    return `<label for="${id}">${p.label}<select id="${id}" data-param="${p.key}">${p.options.map((o) => `<option value="${o.value}"${String(o.value) === String(val) ? " selected" : ""}>${o.label}</option>`).join("")}</select></label>`;
  }
  if (p.kind === "range") return `<label for="${id}">${p.label} : ${Math.round(val * 100)} %<input type="range" id="${id}" data-param="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}"></label>`;
  if (p.kind === "bool") return `<label class="check" for="${id}"><input type="checkbox" id="${id}" data-param="${p.key}"${val ? " checked" : ""}>${p.label}</label>`;
  return `<label for="${id}">${p.label} (${p.unit})<input type="text" id="${id}" data-param="${p.key}" value="${fmt(val, p.unit).replace(` ${p.unit}`, "").replace(" ", "")}" inputmode="decimal"></label>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function renderInspector() {
  const panel = $("panel-inspect");
  if (!selection) {
    panel.innerHTML = `<div class="empty"><h2>Plan de travail</h2><p>Cliquez un composant pour lire ses mesures. Survolez une broche ou un fil pour lire sa tension.</p>
      <p>Pour câbler, glissez depuis une broche ou utilisez l'outil Fil (<kbd>W</kbd>). <kbd>R</kbd> pivote, <kbd>Suppr</kbd> supprime, <kbd>Échap</kbd> annule.</p>
      <p>Les composants maltraités se comportent comme en vrai : une LED sans résistance grille, une résistance trop sollicitée brûle.</p></div>`;
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
  const res = sim?.ok ? sim.comps.get(comp.id) : undefined;
  const info = res?.info ?? { readings: [], warnings: [] };
  const ds = def.datasheet;
  panel.innerHTML = `
    <div><h2>${def.name}${def.label?.(comp) ? ` · ${esc(def.label(comp))}` : ""}</h2><p class="summary">${def.summary}</p></div>
    ${info.warnings.length ? `<div class="alerts">${info.warnings.map((w) => `<div class="alert ${w.level}">${esc(w.text)}</div>`).join("")}</div>` : ""}
    ${def.params.length ? `<div class="params">${def.params.map((p) => paramField(def, comp, p)).join("")}</div>` : ""}
    ${info.readings.length ? `<div><h3>Mesures</h3><table class="readings">${info.readings.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></div>` : ""}
    <div class="row">${def.rotatable ? `<button data-act="rotate">Pivoter</button>` : ""}<button data-act="delete">Supprimer</button>${comp.damaged ? `<button data-act="repair" class="primary">Remplacer le composant</button>` : ""}${def.programmable ? `<button data-act="code">Ouvrir le code</button>` : ""}</div>
    ${ds ? `<details class="datasheet"><summary>Fiche technique et modèle</summary><p>${esc(ds.source)}</p>${ds.notes.length ? `<ul>${ds.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</details>` : ""}`;
}

$("panel-inspect").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "rotate") rotateSelection();
  else if (act === "delete") deleteSelection();
  else if (act === "code") showTab("code");
  else if (act === "repair") {
    const c = circuit.components.find((x) => x.id === selection?.id);
    if (c) { delete c.damaged; refresh(); }
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
    if (!Number.isFinite(value) || (p.min !== undefined && value < p.min)) { e.target.setCustomValidity("Valeur invalide, ex. 220, 4k7, 1M"); e.target.reportValidity(); return; }
    e.target.setCustomValidity("");
  }
  comp.params[key] = value;
  refresh();
});
$("panel-inspect").addEventListener("input", (e) => {
  if (e.target.type !== "range") return;
  const comp = circuit.components.find((c) => c.id === selection?.id);
  comp.params[e.target.dataset.param] = Number(e.target.value);
  resimulate(); render(); renderStatus();
  e.target.previousSibling.textContent = `${REGISTRY[comp.type].params.find((q) => q.key === e.target.dataset.param).label} : ${Math.round(e.target.value * 100)} %`;
});

function renderStatus() {
  const el = $("status");
  if (!sim) return;
  if (!sim.ok) { el.innerHTML = `<span class="bad">${esc(sim.error)}</span>`; return; }
  const alerts = [];
  for (const c of circuit.components) {
    const r = sim.comps.get(c.id);
    if (r?.info.warnings.length) alerts.push([c, r.info.warnings[0]]);
  }
  const nodes = sim.net.nodeCount;
  el.innerHTML = `<span>Point de fonctionnement DC · <b>${nodes}</b> nœuds · <b>${circuit.components.length}</b> composants · 25 °C</span>`
    + (alerts.length ? `<span class="bad">${alerts.length} alerte${alerts.length > 1 ? "s" : ""} :</span> ${alerts.slice(0, 3).map(([c, w]) => `<button data-sel="${c.id}">${esc(REGISTRY[c.type].name)}${REGISTRY[c.type].label?.(c) ? ` ${esc(REGISTRY[c.type].label(c))}` : ""}</button>`).join(" ")}` : `<span>Aucune alerte</span>`);
}
$("status").addEventListener("click", (e) => {
  const id = e.target.dataset.sel;
  if (!id) return;
  selection = { kind: "comp", id };
  showTab("inspect"); render(); renderInspector();
});

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
const boardComp = () => circuit.components.find((c) => c.type === "esp32");

function attachRunner() {
  runner?.stop();
  const comp = boardComp();
  if (!comp) { setRunState("stopped", "Aucun ESP32 sur le plan de travail."); runner = null; return; }
  let pending = false;
  runner = new SketchRunner({
    pins: ESP32_GPIO.map((g) => g.gpio),
    inputOnly: new Set(ESP32_GPIO.filter((g) => g.inputOnly).map((g) => g.gpio)),
    adc: new Set(ESP32_GPIO.filter((g) => g.adc).map((g) => g.gpio)),
    setPin(gpio, state) {
      const b = boardComp();
      if (!b) return;
      b.rt = b.rt ?? {};
      b.rt.pins = { ...b.rt.pins, [gpio]: state };
      resimulate();
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; render(); renderStatus(); if (selection) renderInspectorLive(); }); }
    },
    read(gpio) {
      const b = boardComp();
      return b?.rt?.lastRead?.[gpio] ?? 0;
    },
    analog(gpio) {
      const b = boardComp();
      return REGISTRY.esp32.analogRead(b, sim?.comps?.get(b.id)?.avg ?? {}, gpio);
    },
  }, {
    log: (t) => serialLog(t),
    onState: setRunState,
  });
}

// Pendant l'exécution, on met à jour les mesures sans reconstruire les champs en cours d'édition.
function renderInspectorLive() {
  if (document.activeElement?.closest?.("#panel-inspect")) return;
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
  refresh({ persistNow: false });
}
$("code-run").onclick = () => {
  if (!runner) attachRunner();
  if (!runner) return;
  resetBoardPins();
  serialLog("--- reset (EN) ---");
  runner.start(codeEl.value);
};
$("code-stop").onclick = () => { runner?.stop(); resetBoardPins(); };

// ---------- Démarrage ----------
renderPalette();
refresh({ persistNow: false });
attachRunner();
if (runner) { serialLog("--- démarrage ---"); runner.start(codeEl.value); }
wrap.scrollTo(0, 0);
