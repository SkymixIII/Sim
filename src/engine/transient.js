// Analyse transitoire : fait évoluer le circuit dans le temps.
//
//  - pas adaptatif : on compare chaque solution à son extrapolation linéaire (erreur de
//    troncature locale) ; trop d'écart = pas refusé et réduit, peu d'écart = pas agrandi ;
//  - intégration par trapèzes (ordre 2), Euler implicite juste après une discontinuité
//    pour éviter les oscillations numériques ;
//  - les fronts connus à l'avance (PWM, générateur carré, réveil d'un sketch) sont des
//    « points d'arrêt » sur lesquels un pas se termine exactement ;
//  - un basculement imprévu (comparateur, 555, bascule) fait refuser le pas, qui est réduit
//    jusqu'à H_MIN : l'instant du basculement est localisé à la nanoseconde.
import { buildNetlist, describeAll } from "./circuit.js";
import { prepare, solveSettled } from "./solver.js";

export const H_MIN = 1e-9;     // plus petit pas
const H_FRESH = 1e-8;          // premier pas après une discontinuité
const H_MAX = 1e-3;            // plus grand pas (résolution des mesures affichées)
const EPS_T = 1e-12;           // les sources sont évaluées juste avant la fin du pas
const RELTOL = 0.005, ABSTOL = 5e-4;

const copyState = (s) => (s ? { ...s } : s);

export class Simulation {
  constructor(circuit, opts = {}) {
    this.circuit = circuit;
    this.tempC = opts.tempC ?? 25;
    this.t = 0;
    this.tau = 0.05;          // constante de temps des moyennes affichées (s simulées)
    this.hMaxUser = H_MAX;
    this.onStep = null;       // (t, sim) après chaque pas accepté
    this.elState = new Map(); // état de linéarisation (jonctions) par composant
    this.stats = new Map();   // moyennes / extrêmes glissants par composant
    this.steps = 0;
    this.invalidate();
  }

  /** Le schéma a changé (composants, fils, paramètres). */
  invalidate() {
    this.net = null; this.prep = null; this.x = null; this.xp = null; this.last = null;
    this.error = null;
    this.markFresh();
  }

  /** Une entrée discrète a changé (broche de microcontrôleur, bouton…). */
  poke() { this.error = null; this.markFresh(); }

  markFresh() { this.h = H_FRESH; this.be = 2; this.skipLte = true; this.dirty = true; }

  /** Retour à t = 0 : condensateurs déchargés, bascules remises à zéro. */
  reset() {
    this.t = 0;
    for (const c of this.circuit.components) if (c.rt) delete c.rt.s;
    this.stats.clear(); this.elState.clear();
    this.invalidate();
  }

  build() {
    const net = buildNetlist(this.circuit);
    const old = this.elState;
    this.elState = new Map();
    for (const el of net.elements) {
      el.state = old.get(el.inst.id) ?? {};
      this.elState.set(el.inst.id, el.state);
    }
    this.net = net;
    this.prep = prepare(net.nodeCount, net.elements);
    this.reactive = this.prep.els.some((el) => el.def.reactive);
    this.stateful = this.prep.els.filter((el) => el.def.update || el.def.commit);
    this.vAvg = null;
    for (const id of this.stats.keys()) if (!this.elState.has(id)) this.stats.delete(id);
  }

  /** Avance jusqu'à tTarget, ou jusqu'à l'échéance `deadline` (performance.now()). */
  advance(tTarget, deadline = Infinity) {
    let n = 0;
    while (this.t < tTarget - 1e-15 && !this.error) {
      if ((++n & 7) === 0 && performance.now() > deadline) break;
      this.step(tTarget);
    }
    return this.t >= tTarget - 1e-15;
  }

  /** Si une entrée vient de changer, calcule tout de suite son effet (un pas de 10 ns). */
  sync() { if (this.dirty && !this.error) this.step(this.t + H_FRESH); }

  /** Un pas d'intégration (ou une tentative refusée). */
  step(tLimit) {
    if (!this.prep) this.build();
    const { prep } = this;
    let tBreak = Infinity, hmax = this.hMaxUser;
    for (const el of prep.els) {
      const d = el.def;
      if (d.nextBreak) tBreak = Math.min(tBreak, d.nextBreak(el.inst, this.t));
      if (d.maxStep) hmax = Math.min(hmax, d.maxStep(el.inst));
    }
    const tEnd = Math.min(tLimit, tBreak);
    const room = tEnd - this.t;
    if (room <= 1e-13) { this.t = tEnd; if (tEnd === tBreak) this.markFresh(); return; }
    const want = this.reactive || this.dirty ? this.h : Infinity;
    let h = Math.min(want, hmax, room);
    const landing = h >= room * (1 - 1e-9);
    if (landing) h = room;

    // Rien ne bouge (ni réactif, ni source variable, ni entrée modifiée) : la solution reste valable.
    if (!this.reactive && !this.dirty && this.last && hmax >= this.hMaxUser) {
      this.finish(h, landing, tEnd, tBreak);
      return;
    }

    const saved = this.stateful.map((el) => copyState(el.inst.rt?.s));
    const restore = () => this.stateful.forEach((el, i) => { if (el.inst.rt) el.inst.rt.s = saved[i]; });
    const trap = this.reactive && this.be <= 0;
    const r = solveSettled(prep, { t: this.t + h - EPS_T, dt: h, trap, initial: this.x, tempC: this.tempC });
    if (!r.ok) {
      restore();
      if (h > H_MIN * 1.5) { this.h = Math.max(H_MIN, h / 8); this.be = 2; return; }
      this.error = r.error;
      return;
    }
    const xn = r.solution;
    let ratio = 0, jump = false;
    if (this.reactive && this.x && this.xp && !this.skipLte) {
      const k = h / this.hp;
      for (let i = 0; i < prep.nV; i++) {
        const pred = this.x[i] + (this.x[i] - this.xp[i]) * k;
        const e = Math.abs(xn[i] - pred) / (RELTOL * Math.max(Math.abs(xn[i]), Math.abs(pred)) + ABSTOL);
        if (e > ratio) ratio = e;
      }
      if (ratio > 1) {
        if (h > H_MIN * 1.01) {
          restore();
          this.h = Math.max(H_MIN, h * Math.max(0.125, 0.8 / Math.sqrt(ratio)));
          return;
        }
        jump = true; // discontinuité localisée : on l'accepte
      }
    }
    // Pas accepté.
    for (const el of prep.els) el.def.commit?.(r.ctx, el.inst, el.nodes, el.branches);
    this.xp = jump ? null : this.x; this.hp = h;
    this.x = xn; this.last = r;
    this.steps++;
    if (this.be > 0) this.be--;
    this.skipLte = false;
    this.dirty = false;
    if (jump) { this.be = 2; this.skipLte = true; this.h = H_FRESH; }
    else if (this.reactive) this.h = Math.min(H_MAX, h * (ratio < 0.1 ? 2 : ratio < 0.4 ? 1.3 : 1));
    this.finish(h, landing, tEnd, tBreak);
  }

  finish(h, landing, tEnd, tBreak) {
    this.t = landing ? tEnd : this.t + h;
    this.accumulate(h);
    if (landing && tEnd === tBreak) this.markFresh();
    this.onStep?.(this.t, this);
  }

  accumulate(h) {
    const { prep, last } = this;
    const a = 1 - Math.exp(-h / this.tau), ap = 1 - Math.exp(-h / (4 * this.tau));
    for (let j = 0; j < prep.els.length; j++) {
      const res = last.results[j], id = prep.els[j].inst.id;
      let st = this.stats.get(id);
      if (!st) { this.stats.set(id, { avg: { ...res }, peak: { ...res } }); continue; }
      const { avg, peak } = st;
      for (const k in res) {
        const v = res[k];
        if (avg[k] === undefined) { avg[k] = v; peak[k] = v; continue; }
        avg[k] += a * (v - avg[k]);
        const p = peak[k];
        if (k.startsWith("Vmin") ? v < p : Math.abs(v) > Math.abs(p)) peak[k] = v;
        else peak[k] = p + ap * (v - p);
      }
    }
    const nV = this.net.nodeCount;
    if (!this.vAvg) { this.vAvg = new Float64Array(nV); for (let n = 1; n < nV; n++) this.vAvg[n] = last.v(n); }
    else for (let n = 1; n < nV; n++) this.vAvg[n] += a * (last.v(n) - this.vAvg[n]);
  }

  /** Les moyennes affichées prennent immédiatement les valeurs instantanées. */
  snapStats() {
    if (!this.last) return;
    this.stats.clear(); this.vAvg = null;
    this.accumulate(0);
  }

  /** Grandeurs instantanées d'un composant (dernier pas calculé). */
  instant(id) {
    if (!this.last || !this.prep) return undefined;
    const j = this.prep.els.findIndex((el) => el.inst.id === id);
    return j < 0 ? undefined : this.last.results[j];
  }

  /**
   * Bilan pour l'affichage, au même format que simulate() : { ok, net, nodeV, comps }.
   * Détecte les composants détruits (ils deviennent des circuits ouverts au pas suivant).
   */
  frame() {
    if (this.error) return { ok: false, error: this.error, net: this.net };
    if (!this.prep) this.build();
    if (!this.last) { this.step(this.t + H_FRESH); if (this.error || !this.last) return { ok: false, error: this.error ?? "Simulation indisponible.", net: this.net }; }
    const { net } = this;
    const avgOf = [], peakOf = [];
    for (const el of net.elements) {
      const st = this.stats.get(el.inst.id) ?? { avg: {}, peak: {} };
      avgOf.push(st.avg); peakOf.push(st.peak);
    }
    const { comps, newlyDamaged } = describeAll(net, avgOf, peakOf);
    const nodeV = new Map();
    for (const [k, n] of net.nodeByKey) nodeV.set(k, n === 0 ? 0 : this.vAvg[n]);
    if (newlyDamaged) this.invalidate();
    return { ok: true, net, nodeV, comps };
  }
}
