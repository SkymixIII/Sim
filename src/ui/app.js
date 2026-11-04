// Interface : plan de travail SVG, palette, panneau de mesures, code des cartes, liens virtuels.
import { COMPONENTS, REGISTRY, defaultParams } from "../components/index.js";
import { pinPositions, rotatePoint } from "../engine/circuit.js";
import { LINK_KINDS } from "../engine/network.js";
import { fmt, parseSI } from "../engine/units.js";
import { Bench } from "../runtime/bench.js";
import { exampleCircuit, EXAMPLE_SKETCH } from "./example.js";
import { tallyCircuit } from "./montages/tally.js";

const G = 20;          // pixels par pas de grille
let COLS = 64, ROWS = 40;
const STORE = "etabli.circuit.v1", STORE_CODE = "etabli.code.v1";
const MONTAGES = {
  tally: { label: "Tally ATEM 4 lampes", build: tallyCircuit },
  demo: { label: "LED + bouton (démo)", build: exampleCircuit },
};

const $ = (id) => document.getElementById(id);
const svg = $("canvas");
const wrap = $("canvas-wrap");
// Le plan s'agrandit pour contenir le montage.
function fitCanvas() {
  let maxX = 0, maxY = 0;
  for (const c of circuit.components) {
    const b = REGISTRY[c.type].bounds;
    maxX = Math.max(maxX, c.x + b.x + b.w); maxY = Math.max(maxY, c.y + b.y + b.h);
  }
  for (const w of circuit.wires) { maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2); }
  COLS = Math.max(64, Math.ceil(maxX) + 6); ROWS = Math.max(40, Math.ceil(maxY) + 4);
  applyZoom();
}
// Zoom : le viewBox reste en unités du plan, seule la taille affichée change.
let zoom = 1;
function applyZoom() {
  svg.setAttribute("viewBox", `0 0 ${COLS * G} ${ROWS * G}`);
  svg.setAttribute("width", Math.round(COLS * G * zoom));
  svg.setAttribute("height", Math.round(ROWS * G * zoom));
  const z = document.getElementById("zoom-level");
  if (z) z.textContent = `${Math.round(zoom * 100)} %`;
}
function zoomToFit() {
  let maxX = 0, maxY = 0;
  for (const c of circuit.components) {
    const b = REGISTRY[c.type].bounds;
    maxX = Math.max(maxX, c.x + b.x + b.w); maxY = Math.max(maxY, c.y + b.y + b.h);
  }
  zoom = Math.max(0.4, Math.min(1, (wrap.clientWidth - 10) / ((maxX + 2) * G), (wrap.clientHeight - 10) / ((maxY + 2) * G)));
  applyZoom();
}
const setZoom = (z) => { zoom = Math.max(0.4, Math.min(2, z)); applyZoom(); };

const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };

// Montage demandé dans l'adresse (#tally, #demo), sinon le dernier enregistré, sinon le tally.
function normalize(c) {
  c.links = (c.links ?? []).filter((l) => LINK_KINDS[l.kind]);
  for (const b of c.components) if (REGISTRY[b.type].programmable && b.code === undefined) b.code = load(STORE_CODE) ?? EXAMPLE_SKETCH;
  return c;
}
let circuit = normalize((() => {
  const wanted = MONTAGES[location.hash.slice(1)];
  if (wanted) return wanted.build();
  try { const c = JSON.parse(load(STORE)); if (c?.components?.every((x) => REGISTRY[x.type])) return c; } catch { /* montage par défaut */ }
  return tallyCircuit();
})());
let sim = null;
let selection = null;      // { kind: "comp" | "wire" | "link", id }
let tool = "select";       // "select" | "wire" | { place: type }
let wireFrom = null;       // point de départ d'un fil
let hover = null;          // point de grille sous la souris
let drag = null;
let uid = Date.now() % 1e6;
const newId = (p) => `${p}${(uid++).toString(36)}`;

// ---------- Simulation ----------
function persist() {
  const clean = { components: circuit.components.map(({ rt, ...c }) => c), wires: circuit.wires, links: circuit.links };
  save(STORE, JSON.stringify(clean));
}

// Activité récente sur chaque lien (pour l'animation) : link.id -> horodatage.
const activity = new Map();
const serialLogs = new Map(); // carte -> lignes du moniteur série

const bench = new Bench({
  getCircuit: () => circuit,
  onChange: () => scheduleLive(),
  onSerial: (id, t) => serialLog(id, t),
  onState: (id, state, msg) => { if (msg) serialLog(id, msg, state === "error" ? "err" : ""); renderRunState(); },
  onTraffic: (link) => activity.set(link.id, performance.now()),
});

function resimulate() { sim = bench.resimulate(); }

// Les sketches changent les broches en continu : on redessine au plus une fois par image.
let livePending = false;
function scheduleLive() {
  sim = bench.sim;
  if (livePending) return;
  livePending = true;
  requestAnimationFrame(() => { livePending = false; render(); renderStatus(); if (selection) renderInspectorLive(); });
}

let frame = 0;
function refresh({ persistNow = true } = {}) {
  fitCanvas();
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

const compById = (id) => circuit.components.find((c) => c.id === id);
const displayLabel = (c, def) => c.name ?? def.label?.(c);

// Tracé d'un lien virtuel entre deux cartes : arc par-dessus si elles sont côte à côte,
// courbe du bas de l'une vers le haut de l'autre sinon.
function linkGeometry(l) {
  const a = compById(l.a), b = compById(l.b);
  if (!a || !b) return null;
  const ba = REGISTRY[a.type].bounds, bb = REGISTRY[b.type].bounds;
  // Ancrage côté antenne (à droite du nom de la carte, qui est centré au-dessus).
  const top = (c, bd) => ({ x: (c.x + bd.x + bd.w * 0.88) * G, y: (c.y + bd.y) * G });
  const bottom = (c, bd) => ({ x: (c.x + bd.x + bd.w / 2) * G, y: (c.y + bd.y + bd.h) * G });
  if (Math.abs(a.y - b.y) < 6) {
    const p = top(a, ba), q = top(b, bb);
    const cy = Math.max(6, Math.min(p.y, q.y) - 70);
    return { d: `M${p.x},${p.y} C${p.x},${cy} ${q.x},${cy} ${q.x},${q.y}`, mid: { x: (p.x + q.x) / 2, y: (p.y + 6 * cy + q.y) / 8 } };
  }
  const [u, ub, v, vb] = a.y < b.y ? [a, ba, b, bb] : [b, bb, a, ba];
  const p = bottom(u, ub), q = top(v, vb);
  const k = Math.max(40, (q.y - p.y) / 2);
  return { d: `M${p.x},${p.y} C${p.x},${p.y + k} ${q.x},${q.y - k} ${q.x},${q.y}`, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } };
}

function linkCaption(l) {
  const k = LINK_KINDS[l.kind];
  if (l.cut) return `${k.short} · ${l.kind === "rj45" ? "débranché" : "hors de portée"}`;
  return l.loss ? `${k.short} · perte ${l.loss} %` : k.short;
}

function renderLinks() {
  let out = "";
  const now = performance.now();
  for (const l of circuit.links) {
    const g = linkGeometry(l);
    if (!g) continue;
    const isSel = selection?.kind === "link" && selection.id === l.id;
    const active = now - (activity.get(l.id) ?? -1e9) < 300;
    out += `<g class="link ${l.kind}${l.cut ? " cut" : ""}${isSel ? " sel" : ""}${active ? " active" : ""}" data-link="${l.id}">`
      + `<path class="link-line" d="${g.d}"/><path class="link-hit" d="${g.d}"/>`
      + `<text class="link-label" x="${g.mid.x}" y="${g.mid.y - 6}" text-anchor="middle">${linkCaption(l)}</text></g>`;
  }
  return out;
}

// Animation légère : seules les classes des liens changent, sans tout redessiner.
setInterval(() => {
  const now = performance.now();
  for (const el of svg.querySelectorAll("[data-link]")) el.classList.toggle("active", now - (activity.get(el.dataset.link) ?? -1e9) < 300);
}, 100);

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
    const lbl = displayLabel(c, def);
    if (lbl || res) {
      const p = compLabelPos(c, def);
      const reading = readingText(c, res);
      const bad = c.damaged || res?.info.warnings.some((w) => w.level === "danger");
      if (lbl) out += `<text class="label" x="${p.x}" y="${p.y}" text-anchor="${p.anchor}">${lbl}</text>`;
      if (reading) out += `<text class="reading${bad ? " bad" : ""}" x="${p.x}" y="${p.y + 13}" text-anchor="${p.anchor}">${reading}</text>`;
    }
  }

  out += renderLinks();

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
  if (def.programmable) { comp.code = EXAMPLE_SKETCH; comp.name = `ESP32 ${circuit.components.filter((c) => c.type === type).length}`; codeBoardId = comp.id; renderCodePanel(); bench.start(comp.id); }
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
  const linkEl = e.target.closest("[data-link]");
  if (linkEl) {
    selection = { kind: "link", id: linkEl.dataset.link };
    showTab("inspect"); render(); renderInspector();
  } else if (compEl) {
    const comp = circuit.components.find((c) => c.id === compEl.dataset.comp);
    selection = { kind: "comp", id: comp.id };
    if (REGISTRY[comp.type].programmable) { codeBoardId = comp.id; renderCodePanel(); }
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
  if (selection.kind === "comp") {
    circuit.components = circuit.components.filter((c) => c.id !== selection.id);
    circuit.links = circuit.links.filter((l) => l.a !== selection.id && l.b !== selection.id);
  } else if (selection.kind === "link") circuit.links = circuit.links.filter((l) => l.id !== selection.id);
  else circuit.wires = circuit.wires.filter((w) => w.id !== selection.id);
  selection = null;
  bench.prune();
  renderCodePanel();
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
function loadCircuit(c) {
  bench.stopAll();
  circuit = normalize(c);
  selection = null;
  serialLogs.clear();
  codeBoardId = null;
  fitCanvas();
  zoomToFit();
  refresh();
  renderCodePanel();
  bench.startAll();
  wrap.scrollTo(0, 0);
}
$("zoom-out").onclick = () => setZoom(zoom / 1.2);
$("zoom-in").onclick = () => setZoom(zoom * 1.2);
$("zoom-fit").onclick = zoomToFit;
$("act-montage").innerHTML = `<option value="">Charger un montage…</option>` + Object.entries(MONTAGES).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join("");
$("act-montage").onchange = (e) => {
  const m = MONTAGES[e.target.value];
  e.target.value = "";
  if (m) loadCircuit(m.build());
};
$("act-clear").onclick = () => loadCircuit({ components: [], wires: [], links: [] });
window.addEventListener("hashchange", () => { const m = MONTAGES[location.hash.slice(1)]; if (m) loadCircuit(m.build()); });

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
  if (selection.kind === "link") return renderLinkInspector(panel);
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
  const title = comp.name ? esc(comp.name) : `${def.name}${def.label?.(comp) ? ` · ${esc(def.label(comp))}` : ""}`;
  const sub = comp.name ? `${def.name}${comp.realBoard ? ` · réel : ${esc(comp.realBoard)}` : def.label?.(comp) ? ` · ${esc(def.label(comp))}` : ""}` : "";
  panel.innerHTML = `
    <div><h2>${title}</h2>${sub ? `<p class="summary"><b>${sub}</b></p>` : ""}<p class="summary">${def.summary}</p></div>
    ${def.programmable ? boardLinksSection(comp) : ""}
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
  else if (act === "code") { codeBoardId = selection.id; renderCodePanel(); showTab("code"); }
  else if (act === "toggle-link") {
    const id = e.target.closest("[data-id]")?.dataset.id ?? selection.id;
    const l = circuit.links.find((x) => x.id === id);
    if (l) { l.cut = !l.cut; refresh(); }
  } else if (act === "add-link") {
    const kind = $("new-link-kind").value, to = $("new-link-to").value;
    if (!to) return;
    circuit.links.push({ id: newId("l"), kind, a: selection.id, b: to, cut: false, loss: 0 });
    refresh();
  } else if (act === "goto-link") {
    selection = { kind: "link", id: e.target.closest("[data-id]").dataset.id };
    render(); renderInspector();
  }
  else if (act === "repair") {
    const c = circuit.components.find((x) => x.id === selection?.id);
    if (c) { delete c.damaged; refresh(); }
  }
});
$("panel-inspect").addEventListener("change", (e) => {
  if (e.target.id === "board-name") {
    const c = compById(selection?.id);
    if (c) { c.name = e.target.value.trim() || undefined; refresh(); renderCodePanel(); }
    return;
  }
  if (e.target.id === "link-loss") return;
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
  if (e.target.id === "link-loss") {
    const l = circuit.links.find((x) => x.id === selection?.id);
    if (l) { l.loss = Number(e.target.value); e.target.previousSibling.textContent = `Perte de messages : ${l.loss} %`; persist(); render(); }
    return;
  }
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

// ---------- Liens virtuels (inspecteur) ----------
function boardLinksSection(comp) {
  const mine = circuit.links.filter((l) => l.a === comp.id || l.b === comp.id);
  const others = circuit.components.filter((c) => REGISTRY[c.type].programmable && c.id !== comp.id);
  const rows = mine.map((l) => {
    const other = compById(l.a === comp.id ? l.b : l.a);
    return `<tr data-id="${l.id}"><td><button class="linkish" data-act="goto-link">${LINK_KINDS[l.kind].short} → ${esc(other?.name ?? other?.id ?? "?")}</button></td>`
      + `<td><button data-act="toggle-link" class="small">${l.cut ? "Rebrancher" : l.kind === "rj45" ? "Débrancher" : "Couper"}</button></td></tr>`;
  }).join("");
  return `<div class="params"><label for="board-name">Nom de la carte<input type="text" id="board-name" value="${esc(comp.name ?? "")}"></label></div>
    <div><h3>Liens virtuels</h3>${rows ? `<table class="readings links">${rows}</table>` : `<p class="summary">Aucun lien. Reliez cette carte à une autre en RJ45 ou en ESP-NOW.</p>`}
    ${others.length ? `<div class="row add-link"><select id="new-link-kind">${Object.entries(LINK_KINDS).map(([k, d]) => `<option value="${k}">${d.short}</option>`).join("")}</select>`
      + `<select id="new-link-to">${others.map((o) => `<option value="${o.id}">${esc(o.name ?? o.id)}</option>`).join("")}</select><button data-act="add-link">Relier</button></div>` : ""}</div>`;
}

function hex(bytes) { return bytes ? bytes.slice(0, 24).map((x) => x.toString(16).padStart(2, "0")).join(" ") + (bytes.length > 24 ? " …" : "") : "—"; }

function renderLinkInspector(panel) {
  const l = circuit.links.find((x) => x.id === selection.id);
  if (!l) { selection = null; return renderInspector(); }
  const k = LINK_KINDS[l.kind];
  const a = compById(l.a), b = compById(l.b);
  const st = bench.net.stats.get(l.id);
  const up = bench.net.up(l);
  const state = l.cut ? (l.kind === "rj45" ? "débranché" : "hors de portée") : up ? "actif" : "inactif (une carte est arrêtée)";
  panel.innerHTML = `<div><h2>${k.label}</h2><p class="summary"><b>${esc(a?.name ?? l.a)} ↔ ${esc(b?.name ?? l.b)}</b></p><p class="summary">${k.summary}</p>${l.note ? `<p class="summary">${esc(l.note)}</p>` : ""}</div>
    ${l.kind === "espnow" ? `<div class="params"><label for="link-loss">Perte de messages : ${l.loss ?? 0} %<input type="range" id="link-loss" min="0" max="100" step="5" value="${l.loss ?? 0}"></label></div>` : ""}
    <div><h3>Trafic</h3><table class="readings">
      <tr><td>État</td><td>${state}</td></tr>
      <tr><td>Messages transmis</td><td>${st?.count ?? 0}</td></tr>
      ${l.kind === "espnow" ? `<tr><td>Messages perdus</td><td>${st?.lost ?? 0}</td></tr>` : ""}
      <tr><td>Dernier message</td><td>${hex(st?.last)}</td></tr>
    </table></div>
    <div class="row"><button data-act="toggle-link" class="primary">${l.cut ? "Rebrancher" : l.kind === "rj45" ? "Débrancher le câble" : "Mettre hors de portée"}</button><button data-act="delete">Supprimer le lien</button></div>
    <details class="datasheet"><summary>Modèle du lien</summary><ul>${k.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`;
}

// ---------- Code des cartes ----------
const codeEl = $("code");
const boardSel = $("code-board");
const serialEl = $("serial");
let codeBoardId = null;

const boards = () => circuit.components.filter((c) => REGISTRY[c.type].programmable);
function codeBoard() {
  const list = boards();
  return list.find((b) => b.id === codeBoardId) ?? list[0] ?? null;
}

function renderCodePanel() {
  const list = boards();
  const b = codeBoard();
  codeBoardId = b?.id ?? null;
  boardSel.innerHTML = list.map((x) => `<option value="${x.id}"${x.id === codeBoardId ? " selected" : ""}>${esc(x.name ?? x.id)}${x.realBoard ? ` (${esc(x.realBoard)})` : ""}</option>`).join("");
  boardSel.disabled = !list.length;
  if (document.activeElement !== codeEl) codeEl.value = b?.code ?? "";
  codeEl.disabled = !b;
  serialEl.textContent = "";
  for (const { text, cls } of serialLogs.get(codeBoardId) ?? []) appendSerial(text, cls);
  renderRunState();
}
boardSel.onchange = () => { codeBoardId = boardSel.value; codeEl.blur(); renderCodePanel(); };

let saveTimer = 0;
codeEl.addEventListener("input", () => {
  const b = codeBoard();
  if (!b) return;
  b.code = codeEl.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
});
codeEl.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const { selectionStart: s, selectionEnd: t } = codeEl;
  codeEl.setRangeText("  ", s, t, "end");
});

function appendSerial(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  serialEl.append(line);
}
function serialLog(id, text, cls = "") {
  if (!serialLogs.has(id)) serialLogs.set(id, []);
  const log = serialLogs.get(id);
  log.push({ text, cls });
  if (log.length > 300) log.shift();
  if (id !== codeBoardId) return;
  appendSerial(text, cls);
  while (serialEl.childElementCount > 300) serialEl.firstChild.remove();
  serialEl.scrollTop = serialEl.scrollHeight;
}
$("serial-clear").onclick = () => { serialLogs.delete(codeBoardId); serialEl.textContent = ""; };

// Pendant l'exécution, on met à jour les mesures sans reconstruire les champs en cours d'édition.
function renderInspectorLive() {
  if (document.activeElement?.closest?.("#panel-inspect")) return;
  renderInspector();
}

function renderRunState() {
  const pill = $("run-state");
  const st = codeBoardId ? bench.state(codeBoardId) : "stopped";
  pill.className = `pill ${st}`;
  pill.textContent = st === "running" ? "en cours" : st === "error" ? "erreur" : "arrêté";
  const all = boards();
  const running = all.filter((b) => bench.state(b.id) === "running").length;
  $("run-all").textContent = all.length > 1 ? `Tout relancer (${running}/${all.length})` : "Relancer";
  $("run-all").hidden = all.length < 2;
}

$("code-run").onclick = () => { if (codeBoardId) { persist(); bench.start(codeBoardId); } };
$("code-stop").onclick = () => { if (codeBoardId) bench.stop(codeBoardId); };
$("run-all").onclick = () => { persist(); bench.startAll(); };

// ---------- Démarrage ----------
fitCanvas();
zoomToFit();
renderPalette();
refresh({ persistNow: false });
renderCodePanel();
bench.startAll();
wrap.scrollTo(0, 0);
