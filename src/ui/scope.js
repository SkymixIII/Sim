// Oscilloscope 4 voies : acquisition dans un tampon circulaire, déclenchement, mesures automatiques.
import { fmt } from "../engine/units.js";
import { SCOPE_COLORS } from "../components/instruments.js";

const N = 1 << 16;
export const TIME_DIVS = [1e-6, 2e-6, 5e-6, 10e-6, 20e-6, 50e-6, 100e-6, 200e-6, 500e-6, 1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 0.1, 0.2, 0.5, 1, 2, 5];
export const VOLT_DIVS = [1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
const HDIV = 10, VDIV = 8;
const nice = (x) => VOLT_DIVS.find((d) => d >= x) ?? VOLT_DIVS[VOLT_DIVS.length - 1];

export class Scope {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.t = new Float64Array(N);
    this.v = [0, 1, 2, 3].map(() => new Float32Array(N));
    this.ch = [0, 1, 2, 3].map(() => ({ active: false, unit: "V", name: "", vdiv: 0, scale: 1, pos: 0, stats: null }));
    this.tdiv = 1e-3;
    this.trig = { src: 0, edge: "rise", mode: "auto", level: null };
    this.stacked = false;
    this.running = true;
    this.win = null;     // fenêtre affichée [t0, t1]
    this.cursor = null;  // position de la souris (fraction 0..1)
    this.clear();
  }

  clear() { this.head = 0; this.count = 0; this.last = -Infinity; this.win = null; this.single = false; }

  idx(i) { return (this.head - this.count + i + 2 * N) % N; }   // i-ème échantillon, du plus ancien au plus récent
  time(i) { return this.t[this.idx(i)]; }

  /** Ajoute un point (vals : 4 valeurs, NaN si la voie n'est pas branchée). */
  record(t, vals) {
    if (!this.running) return;
    if (t < this.last) this.clear();
    if (this.count) {
      const p = (this.head - 1 + N) % N;
      let moved = false;
      for (let c = 0; c < 4; c++) if (Math.abs(vals[c] - this.v[c][p]) > 0.004 * this.ch[c].scale * VDIV) { moved = true; break; }
      if (!moved && t - this.last < this.tdiv * HDIV / 2500) return;
    }
    this.t[this.head] = t;
    for (let c = 0; c < 4; c++) this.v[c][this.head] = vals[c];
    this.head = (this.head + 1) % N;
    if (this.count < N) this.count++;
    this.last = t;
  }

  // Premier indice dont l'instant est ≥ t.
  lower(t) {
    let lo = 0, hi = this.count;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.time(m) < t) lo = m + 1; else hi = m; }
    return lo;
  }

  /** Choisit la fenêtre de temps à afficher (mode défilement, ou calée sur le déclenchement). */
  pickWindow() {
    if (!this.count) return null;
    const span = this.tdiv * HDIV, now = this.last;
    if (!this.running && this.win) return this.win;
    if (this.tdiv >= 0.05) { const t1 = Math.max(now, span); return (this.win = [t1 - span, t1]); }
    const src = this.ch[this.trig.src].active ? this.trig.src : this.ch.findIndex((c) => c.active);
    let found = null;
    if (src >= 0) {
      const v = this.v[src];
      // Niveau automatique : milieu de l'excursion récente.
      let level = this.trig.level;
      const from = this.lower(now - 2.5 * span);
      if (level === null) {
        let mn = Infinity, mx = -Infinity;
        for (let i = from; i < this.count; i++) { const x = v[this.idx(i)]; if (x < mn) mn = x; if (x > mx) mx = x; }
        level = (mn + mx) / 2;
        this.autoLevel = level;
        if (mx - mn < 1e-6) level = NaN;
      }
      const rise = this.trig.edge === "rise";
      for (let i = Math.min(this.count - 1, this.lower(now - 0.9 * span)); i > Math.max(from, 0); i--) {
        const a = v[this.idx(i - 1)], b = v[this.idx(i)];
        if (rise ? a < level && b >= level : a > level && b <= level) {
          const ta = this.time(i - 1), tb = this.time(i);
          found = ta + (tb - ta) * (level - a) / (b - a);
          break;
        }
      }
    }
    this.triggered = found !== null;
    if (found !== null) {
      this.win = [found - 0.1 * span, found + 0.9 * span];
      if (this.single) { this.running = false; this.single = false; this.onStop?.(); }
    } else if (this.trig.mode === "auto" || !this.win) { const t1 = Math.max(now, span); this.win = [t1 - span, t1]; }
    return this.win;
  }

  /** Mesures automatiques d'une voie sur la fenêtre affichée. */
  measure(c, i0, i1) {
    const v = this.v[c];
    let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0, T = 0;
    for (let i = i0; i < i1; i++) {
      const x = v[this.idx(i)];
      if (x < mn) mn = x; if (x > mx) mx = x;
      if (i > i0) {
        const y = v[this.idx(i - 1)], dt = this.time(i) - this.time(i - 1);
        sum += (x + y) / 2 * dt; sum2 += (x * x + x * y + y * y) / 3 * dt; T += dt;
      }
    }
    if (!(T > 0)) return null;
    const st = { min: mn, max: mx, pp: mx - mn, mean: sum / T, rms: Math.sqrt(sum2 / T), freq: NaN, duty: NaN };
    // Fréquence et rapport cyclique : passages par le milieu, avec hystérésis de 10 % de l'excursion.
    const mid = (mn + mx) / 2, hyst = 0.1 * (mx - mn);
    if (hyst > 1e-9) {
      let state = v[this.idx(i0)] > mid ? 1 : 0, first = NaN, lastUp = NaN, ups = 0, high = 0, prevT = this.time(i0);
      for (let i = i0 + 1; i < i1; i++) {
        const x = v[this.idx(i)], t = this.time(i);
        if (!Number.isNaN(first) && state) high += t - prevT;
        if (!state && x > mid + hyst) { state = 1; if (Number.isNaN(first)) first = t; lastUp = t; ups++; }
        else if (state && x < mid - hyst) state = 0;
        prevT = t;
      }
      if (ups >= 2) {
        st.freq = (ups - 1) / (lastUp - first);
        // Temps haut compté entre le premier et le dernier front montant.
        let h = 0; state = 0; prevT = first;
        for (let i = this.lower(first); i < i1 && this.time(i) <= lastUp; i++) {
          const x = v[this.idx(i)], t = this.time(i);
          if (state) h += t - prevT;
          if (!state && x > mid + hyst) state = 1; else if (state && x < mid - hyst) state = 0;
          prevT = t;
        }
        st.duty = h / (lastUp - first);
      }
    }
    return st;
  }

  draw() {
    const { canvas, g } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0a1210";
    g.fillRect(0, 0, W, H);
    // Graticule.
    g.lineWidth = 1;
    for (let i = 0; i <= HDIV; i++) {
      g.strokeStyle = i === HDIV / 2 ? "#3a4f47" : "#1c2b26";
      const x = Math.round(i * (W - 1) / HDIV) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    for (let j = 0; j <= VDIV; j++) {
      g.strokeStyle = j === VDIV / 2 && !this.stacked ? "#3a4f47" : "#1c2b26";
      const y = Math.round(j * (H - 1) / VDIV) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    const win = this.pickWindow();
    const active = this.ch.map((c, i) => (c.active ? i : -1)).filter((i) => i >= 0);
    g.font = "11px 'IBM Plex Mono', ui-monospace, monospace";
    if (!win || !active.length) {
      for (const c of this.ch) c.stats = null;
      g.fillStyle = "#6f867d"; g.textAlign = "center";
      g.fillText(active.length ? "En attente de signal…" : "Posez une sonde d'oscilloscope sur le montage (palette : Instruments)", W / 2, H / 2 - 6);
      return;
    }
    const [t0, t1] = win;
    const i0 = Math.max(0, this.lower(t0) - 1), i1 = Math.min(this.count, this.lower(t1) + 1);
    const lanes = this.stacked ? active.length : 1;
    active.forEach((c, k) => {
      const ch = this.ch[c];
      ch.stats = this.measure(c, i0, i1);
      // Échelle verticale : automatique (calibre 1-2-5 qui fait tenir le signal) ou choisie.
      const st = ch.stats ?? { min: 0, max: 0 };
      const divs = this.stacked ? VDIV / lanes - 0.6 : 6;
      const lo = Math.min(0, st.min), hi = Math.max(0, st.max);
      if (ch.vdiv) { ch.scale = ch.vdiv; } else {
        const want = nice(Math.max(hi - lo, 1e-3) / divs);
        if (!(want <= ch.scale && want >= ch.scale / 2.5 && ch.auto)) ch.scale = want;
        ch.auto = true;
      }
      const autoPos = ch.vdiv && !this.stacked ? ch.pos : -Math.round(((hi + lo) / 2 / ch.scale) * 2) / 2;
      const laneH = H / lanes, cy = this.stacked ? laneH * (k + 0.5) : H / 2;
      const yOf = (v) => cy - (v / ch.scale + autoPos) * (H / VDIV);
      ch.yOf = yOf;
      g.save();
      if (this.stacked) { g.beginPath(); g.rect(0, laneH * k, W, laneH); g.clip(); }
      g.strokeStyle = SCOPE_COLORS[c]; g.lineWidth = 1.6; g.lineJoin = "round";
      g.beginPath();
      const v = this.v[c];
      for (let i = i0; i < i1; i++) {
        const x = (this.time(i) - t0) / (t1 - t0) * W, y = yOf(v[this.idx(i)]);
        if (i === i0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      // Repère du zéro de la voie.
      const y0 = yOf(0);
      g.fillStyle = SCOPE_COLORS[c];
      g.beginPath(); g.moveTo(0, y0 - 5); g.lineTo(8, y0); g.lineTo(0, y0 + 5); g.fill();
      g.restore();
      g.textAlign = "left"; g.fillStyle = SCOPE_COLORS[c];
      g.fillText(`CH${c + 1}  ${fmt(ch.scale, ch.unit)}/div`, 12 + (this.stacked ? 0 : k * 120), (this.stacked ? laneH * k : 0) + 14);
    });
    g.textAlign = "right"; g.fillStyle = "#c9d6d0";
    const mode = !this.running ? "ARRÊT" : this.tdiv >= 0.05 ? "DÉFILEMENT" : this.triggered ? "DÉCL." : this.trig.mode === "auto" ? "AUTO" : "ATTENTE";
    g.fillText(`${fmt(this.tdiv, "s")}/div   ${mode}`, W - 8, 14);
    // Niveau de déclenchement.
    if (this.tdiv < 0.05 && this.ch[this.trig.src]?.active) {
      const lv = this.trig.level ?? this.autoLevel;
      const y = this.ch[this.trig.src].yOf?.(lv);
      if (Number.isFinite(y)) { g.fillStyle = SCOPE_COLORS[this.trig.src]; g.beginPath(); g.moveTo(W, y - 5); g.lineTo(W - 8, y); g.lineTo(W, y + 5); g.fill(); }
    }
    // Curseur de lecture sous la souris.
    if (this.cursor !== null) {
      const x = this.cursor * W, tc = t0 + this.cursor * (t1 - t0);
      g.strokeStyle = "#8fa69c"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
      const i = Math.min(this.count - 1, Math.max(1, this.lower(tc)));
      const right = this.cursor > 0.6;
      g.textAlign = right ? "right" : "left";
      let y = H - 8 - 14 * active.length;
      g.fillStyle = "#c9d6d0";
      const rel = this.tdiv >= 0.05 ? tc - t1 : tc - (t0 + 0.1 * (t1 - t0));
      g.fillText(`t = ${rel < 0 ? "−" : "+"}${fmt(Math.abs(rel), "s")}`, x + (right ? -6 : 6), y);
      for (const c of active) {
        const ta = this.time(i - 1), tb = this.time(i), a = this.v[c][this.idx(i - 1)], b = this.v[c][this.idx(i)];
        const val = tb > ta ? a + (b - a) * Math.min(1, Math.max(0, (tc - ta) / (tb - ta))) : b;
        y += 14; g.fillStyle = SCOPE_COLORS[c];
        g.fillText(`CH${c + 1} ${fmt(val, this.ch[c].unit)}`, x + (right ? -6 : 6), y);
      }
    }
  }

  /** Fenêtre affichée au format CSV (une ligne par instant d'acquisition). */
  toCSV() {
    const win = this.win;
    if (!win) return "";
    const active = this.ch.map((c, i) => (c.active ? i : -1)).filter((i) => i >= 0);
    const rows = [["t (s)", ...active.map((c) => `CH${c + 1} ${this.ch[c].name} (${this.ch[c].unit})`)].join(";")];
    for (let i = this.lower(win[0]); i < this.count && this.time(i) <= win[1]; i++) {
      rows.push([this.time(i).toExponential(6), ...active.map((c) => this.v[c][this.idx(i)].toPrecision(6))].join(";"));
    }
    return rows.join("\n");
  }
}
