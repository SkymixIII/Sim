// Du schéma (composants placés + fils) à la netlist, puis simulation complète :
// connexions, masse, composants détruits, PWM moyenné, diagnostics.
import { solveDC } from "./solver.js";
import { OPEN_G } from "./devices.js";
import { REGISTRY } from "../components/index.js";

const key = (x, y) => `${x},${y}`;

export function rotatePoint(x, y, rot) {
  for (let i = 0; i < (rot & 3); i++) [x, y] = [-y, x];
  return [x, y];
}

export function pinPositions(comp) {
  const def = REGISTRY[comp.type];
  return def.pins.map((p) => {
    const [x, y] = rotatePoint(p.x, p.y, comp.rot || 0);
    return { ...p, x: comp.x + x, y: comp.y + y };
  });
}

function onSegment(px, py, w) {
  const { x1, y1, x2, y2 } = w;
  if ((px === x1 && py === y1) || (px === x2 && py === y2)) return false;
  const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  if (cross !== 0) return false;
  return px >= Math.min(x1, x2) && px <= Math.max(x1, x2) && py >= Math.min(y1, y2) && py <= Math.max(y1, y2);
}

export function buildNetlist(circuit) {
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = k;
    while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const pins = new Map();
  for (const c of circuit.components) {
    pins.set(c.id, pinPositions(c));
    for (const p of pins.get(c.id)) find(key(p.x, p.y));
  }
  for (const w of circuit.wires) union(key(w.x1, w.y1), key(w.x2, w.y2));
  for (const w of circuit.wires) {
    for (const o of circuit.wires) {
      if (o === w) continue;
      if (onSegment(w.x1, w.y1, o)) union(key(w.x1, w.y1), key(o.x1, o.y1));
      if (onSegment(w.x2, w.y2, o)) union(key(w.x2, w.y2), key(o.x1, o.y1));
    }
  }

  // Choix de la masse : symbole Masse, sinon GND de l'ESP32, sinon borne − d'une source.
  let groundRoots = circuit.components.filter((c) => REGISTRY[c.type].isGround).map((c) => find(key(c.x, c.y)));
  if (!groundRoots.length) {
    const ref = circuit.components.find((c) => c.type === "esp32") || circuit.components.find((c) => c.type === "battery" || c.type === "dc");
    if (ref) {
      const p = pins.get(ref.id).find((q) => q.id === "GND" || q.id === "-");
      groundRoots = [find(key(p.x, p.y))];
    }
  }
  const nodeOfRoot = new Map(groundRoots.map((r) => [r, 0]));
  let next = 1;
  const nodeOf = (k) => {
    const r = find(k);
    if (!nodeOfRoot.has(r)) nodeOfRoot.set(r, next++);
    return nodeOfRoot.get(r);
  };
  const elements = [];
  for (const c of circuit.components) {
    const def = REGISTRY[c.type];
    if (def.isGround) continue;
    const nodes = pins.get(c.id).map((p) => nodeOf(key(p.x, p.y)));
    elements.push({ def: c.damaged ? damagedDef(def) : def, inst: c, nodes });
  }
  // Un îlot sans masse (ex. une pile et une LED seules) reçoit sa propre référence :
  // la borne − de sa source si elle en a une, sinon son premier noeud.
  const island = new Map();
  const findI = (n) => { while (island.has(n) && island.get(n) !== n) n = island.get(n); return n; };
  for (const el of elements) for (const n of el.nodes) { if (!island.has(n)) island.set(n, n); island.set(findI(n), findI(el.nodes[0])); }
  const grounded = new Set([findI(0)]);
  const remap = new Map();
  for (const el of elements) {
    const root = findI(el.nodes[0]);
    if (grounded.has(root)) continue;
    const minus = el.def.pins?.findIndex((p) => p.id === "-");
    if (minus >= 0 || !remap.has(root)) remap.set(root, minus >= 0 ? el.nodes[minus] : el.nodes[0]);
    if (minus >= 0) grounded.add(root);
  }
  const refNodes = new Set(remap.values());
  const fix = (n) => (refNodes.has(n) ? 0 : n);
  for (const el of elements) el.nodes = el.nodes.map(fix);
  const keys = [...parent.keys()];
  const nodeByKey = new Map(keys.map((k) => [k, fix(nodeOf(k))]));
  return { nodeCount: next, elements, nodeByKey, pins };
}

// Un composant détruit devient un circuit ouvert.
function damagedDef(def) {
  return {
    stamp(ctx, inst, nodes) { for (let i = 1; i < nodes.length; i++) ctx.conductance(nodes[0], nodes[i], OPEN_G); },
    evaluate: (ctx, inst, nodes) => ({ V: ctx.v(nodes[0]) - ctx.v(nodes[nodes.length - 1]), I: 0, P: 0 }),
  };
}

// Phases PWM : toutes les sorties PWM démarrent HIGH en début de période et passent LOW à leur rapport cyclique.
function pwmPhases(circuit) {
  const chans = [];
  for (const c of circuit.components) {
    for (const [gpio, st] of Object.entries(c.rt?.pins ?? {})) {
      if (st.mode === "PWM") chans.push({ comp: c, gpio, duty: Math.min(1, Math.max(0, st.duty)) });
    }
  }
  if (!chans.length) return [{ weight: 1, apply() {} }];
  const cuts = [...new Set([0, 1, ...chans.map((c) => c.duty)])].sort((a, b) => a - b);
  const phases = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const t = (cuts[i] + cuts[i + 1]) / 2;
    phases.push({
      weight: cuts[i + 1] - cuts[i],
      apply() { for (const ch of chans) { ch.comp.rt.pwmPhase = { ...ch.comp.rt.pwmPhase, [ch.gpio]: t < ch.duty ? 1 : 0 }; } },
    });
  }
  return phases;
}

const warmStart = new Map();

/** Simule le circuit. Modifie `damaged` des composants qui viennent d'être détruits. */
export function simulate(circuit, opts = {}) {
  for (let pass = 0; pass < 6; pass++) {
    const net = buildNetlist(circuit);
    const phases = pwmPhases(circuit);
    const runs = [];
    for (let i = 0; i < phases.length; i++) {
      phases[i].apply();
      const r = solveDC(net.nodeCount, net.elements, { tempC: opts.tempC, initial: warmStart.get(i) });
      if (!r.ok) { warmStart.clear(); return { ok: false, error: r.error, net }; }
      warmStart.set(i, r.solution);
      runs.push({ w: phases[i].weight, r });
    }
    // Moyennes (valeurs efficaces pour les LED : courant moyen) et extrêmes.
    const avgOf = [], peakOf = [];
    net.elements.forEach((el, j) => {
      const avg = {}, peak = {};
      for (const { w, r } of runs) {
        for (const [k, v] of Object.entries(r.results[j])) {
          avg[k] = (avg[k] ?? 0) + w * v;
          if (k.startsWith("Vmin")) peak[k] = Math.min(peak[k] ?? Infinity, v);
          else if (peak[k] === undefined || Math.abs(v) > Math.abs(peak[k])) peak[k] = v;
        }
      }
      avgOf.push(avg); peakOf.push(peak);
    });
    const nodeV = new Map();
    for (const [k, n] of net.nodeByKey) nodeV.set(k, runs.reduce((s, { w, r }) => s + w * r.v(n), 0));

    const comps = new Map();
    let newlyDamaged = false;
    net.elements.forEach((el, j) => {
      const c = el.inst;
      const def = REGISTRY[c.type];
      const info = c.damaged ? { readings: [["État", "détruit"]], warnings: [{ level: "danger", text: c.damaged }] } : def.describe(c, avgOf[j], peakOf[j]);
      if (info.damage && !c.damaged) { c.damaged = info.damage; newlyDamaged = true; }
      comps.set(c.id, { avg: avgOf[j], peak: peakOf[j], info });
    });
    if (!newlyDamaged) return { ok: true, net, nodeV, comps };
  }
  return { ok: false, error: "Trop de composants détruits en cascade." };
}
