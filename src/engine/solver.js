// Moteur de simulation : analyse nodale modifiée (MNA) + Newton-Raphson.
// Point de fonctionnement DC (comme le .op de SPICE) et analyse transitoire
// (comme le .tran de SPICE : intégration trapézoïdale à pas fixe).
//
// Conventions :
//  - le noeud 0 est la masse (0 V) ;
//  - un composant reçoit un `ctx` et "estampille" (stamp) sa contribution
//    linéarisée autour de la solution courante ;
//  - ctx.current(a, b, I) : courant I qui traverse le composant de a vers b.

export const BOLTZMANN = 1.380649e-23;
export const Q_ELECTRON = 1.602176634e-19;
export const thermalVoltage = (tempC = 25) => BOLTZMANN * (tempC + 273.15) / Q_ELECTRON;

const GMIN = 1e-12; // conductance minimale vers la masse sur chaque noeud (comme SPICE)

// Élimination de Gauss avec pivot partiel. Modifie A et b.
export function solveLinear(A, b) {
  const n = b.length;
  for (let k = 0; k < n; k++) {
    let p = k, max = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i][k]);
      if (v > max) { max = v; p = i; }
    }
    if (max < 1e-300) return null;
    if (p !== k) { [A[k], A[p]] = [A[p], A[k]]; [b[k], b[p]] = [b[p], b[k]]; }
    const akk = A[k][k];
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / akk;
      if (f === 0) continue;
      const Ai = A[i], Ak = A[k];
      for (let j = k; j < n; j++) Ai[j] -= f * Ak[j];
      b[i] -= f * b[k];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    const Ai = A[i];
    for (let j = i + 1; j < n; j++) s -= Ai[j] * x[j];
    x[i] = s / Ai[i];
  }
  return x;
}

// Limitation de tension de jonction (SPICE pnjlim) : évite que exp() explose
// pendant les itérations de Newton.
export function pnjlim(vnew, vold, vt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
  }
  return vnew;
}

// Alloue les noeuds internes et les branches (sources de tension) des éléments.
function prepare(nodeCount, elements) {
  let nextNode = nodeCount;
  let nBranches = 0;
  const prepared = elements.map((el) => {
    const nInt = el.def.internalNodes ? el.def.internalNodes(el.inst) : 0;
    const nodes = el.nodes.slice();
    for (let i = 0; i < nInt; i++) nodes.push(nextNode++);
    const nb = el.def.branches ? el.def.branches(el.inst) : 0;
    const branches = [];
    for (let i = 0; i < nb; i++) branches.push(nBranches++);
    return { ...el, nodes, branches, state: {} };
  });
  const nV = nextNode - 1;
  const N = nV + nBranches;
  // Matrice et second membre alloués une fois, réutilisés à chaque itération.
  return { prepared, nV, N, A: Array.from({ length: N }, () => new Float64Array(N)), b: new Float64Array(N) };
}

/**
 * Newton-Raphson sur le système linéarisé. `tran` vaut null en DC, sinon
 * { t, dt, prev, method } : instant, pas, solution acceptée au pas précédent,
 * "trap" (trapèzes) ou "be" (Euler implicite, utilisé au premier pas et
 * après un pas refusé, pour amortir les discontinuités).
 */
function newton(sys, x0, { srcFactor = 1, maxIter = 150, tempC = 25, tran = null, trace } = {}) {
  const { prepared, nV, N, A, b } = sys;
  let xs = Float64Array.from(x0);
  const idx = (node) => node - 1; // -1 pour la masse
  let limited = false;
  const prev = tran?.prev;
  const ctx = {
    tempC, srcFactor,
    mode: tran ? "tran" : "dc",
    t: tran ? tran.t : 0,
    dt: tran ? tran.dt : 0,
    v: (node) => (node === 0 ? 0 : xs[node - 1]),
    vPrev: (node) => (node === 0 ? 0 : prev ? prev[node - 1] : xs[node - 1]),
    branchI: (k) => xs[nV + k],
    markLimited: () => { limited = true; },
    conductance(a, c, g) {
      const ia = idx(a), ic = idx(c);
      if (ia >= 0) A[ia][ia] += g;
      if (ic >= 0) A[ic][ic] += g;
      if (ia >= 0 && ic >= 0) { A[ia][ic] -= g; A[ic][ia] -= g; }
    },
    current(a, c, I) {
      const ia = idx(a), ic = idx(c);
      if (ia >= 0) b[ia] -= I;
      if (ic >= 0) b[ic] += I;
    },
    // Transconductance : courant g·(V(cp) − V(cn)) qui traverse de a vers c.
    transconductance(a, c, cp, cn, g) {
      const ia = idx(a), ic = idx(c), jp = idx(cp), jn = idx(cn);
      if (ia >= 0) { if (jp >= 0) A[ia][jp] += g; if (jn >= 0) A[ia][jn] -= g; }
      if (ic >= 0) { if (jp >= 0) A[ic][jp] -= g; if (jn >= 0) A[ic][jn] += g; }
    },
    // V(a) - V(c) = V ; le courant de branche entre par a (sort du +).
    voltageSource(a, c, V, k) {
      const ia = idx(a), ic = idx(c), r = nV + k;
      if (ia >= 0) { A[ia][r] += 1; A[r][ia] += 1; }
      if (ic >= 0) { A[ic][r] -= 1; A[r][ic] -= 1; }
      b[r] += V;
    },
    /**
     * Condensateur C entre a et b. En DC : circuit ouvert. En transitoire :
     * modèle compagnon (conductance + source de courant) de la méthode choisie.
     * L'historique (tension, courant) est gardé dans state.caps[key] et mis à
     * jour par le moteur quand le pas est accepté.
     */
    capacitor(state, key, a, c, C) {
      const caps = (state.caps ??= {});
      const h = (caps[key] ??= { a, c, C, v: 0, i: 0 });
      h.a = a; h.c = c; h.C = C;
      if (!tran) return;
      if (tran.method === "trap") {
        const g = 2 * C / tran.dt;
        ctx.conductance(a, c, g);
        ctx.current(a, c, -g * h.v - h.i);
      } else {
        const g = C / tran.dt;
        ctx.conductance(a, c, g);
        ctx.current(a, c, -g * h.v);
      }
    },
  };
  for (let iter = 0; iter < maxIter; iter++) {
    for (let i = 0; i < N; i++) A[i].fill(0);
    b.fill(0);
    limited = false;
    for (const el of prepared) el.def.stamp(ctx, el.inst, el.nodes, el.branches, el.state);
    for (let i = 0; i < nV; i++) A[i][i] += GMIN;
    const xn = solveLinear(A, b);
    if (!xn || xn.some((v) => !Number.isFinite(v))) return null;
    let converged = !limited;
    for (let i = 0; i < N; i++) {
      if (Math.abs(xn[i] - xs[i]) > 1e-9 + 1e-6 * Math.abs(xn[i])) { converged = false; break; }
    }
    trace?.(iter, xn, xs, limited);
    xs = xn;
    if (converged && iter > 0) return xs;
  }
  return null;
}

function evaluateAll(prepared, nV, sol, tempC, tran) {
  const v = (node) => (node === 0 ? 0 : sol[node - 1]);
  const ctx = {
    v, branchI: (k) => sol[nV + k], tempC,
    mode: tran ? "tran" : "dc", t: tran?.t ?? 0, dt: tran?.dt ?? 0,
    vPrev: (node) => (node === 0 ? 0 : tran?.prev ? tran.prev[node - 1] : sol[node - 1]),
  };
  return prepared.map((el) => (el.def.evaluate ? el.def.evaluate(ctx, el.inst, el.nodes, el.branches, el.state) : {}));
}

/** Point de fonctionnement : Newton direct, puis à froid, puis source stepping. */
function operatingPoint(sys, opts) {
  const { prepared, N } = sys;
  const tempC = opts.tempC ?? 25;
  let x = new Float64Array(N);
  if (opts.initial && opts.initial.length === N) x = Float64Array.from(opts.initial);
  let sol = newton(sys, x, { tempC, trace: opts.trace });
  if (!sol && opts.initial) {
    for (const el of prepared) el.state = {};
    sol = newton(sys, new Float64Array(N), { tempC });
  }
  if (!sol) {
    // Source stepping : on monte progressivement les sources de 0 à 100 %.
    let xs = new Float64Array(N);
    for (const el of prepared) el.state = {};
    for (let s = 1; s <= 20; s++) {
      const r = newton(sys, xs, { srcFactor: s / 20, maxIter: 200, tempC });
      if (!r) { xs = null; break; }
      xs = r;
    }
    sol = xs;
  }
  return sol;
}

/**
 * elements: [{ def, inst, nodes: [n0, n1, ...] }]  (noeuds externes, 0 = masse)
 * nodeCount: nombre de noeuds externes, masse comprise.
 * Retourne { ok, error, v(node), elements: [{ ...résultats }] }.
 */
export function solveDC(nodeCount, elements, opts = {}) {
  const tempC = opts.tempC ?? 25; // fiches techniques données à 25 °C
  const sys = prepare(nodeCount, elements);
  const sol = operatingPoint(sys, opts);
  if (!sol) return { ok: false, error: "La simulation ne converge pas (circuit impossible ou instable)." };
  const v = (node) => (node === 0 ? 0 : sol[node - 1]);
  return { ok: true, v, solution: sol, results: evaluateAll(sys.prepared, sys.nV, sol, tempC, null) };
}

// Met à jour l'historique des condensateurs une fois un pas accepté.
function commitCaps(prepared, sol, dt, method) {
  const v = (n) => (n === 0 ? 0 : sol[n - 1]);
  for (const el of prepared) {
    const caps = el.state.caps;
    if (!caps) continue;
    for (const h of Object.values(caps)) {
      const vn = v(h.a) - v(h.c);
      if (dt === 0) h.i = 0;
      else if (method === "trap") h.i = 2 * h.C / dt * (vn - h.v) - h.i;
      else h.i = h.C / dt * (vn - h.v);
      h.v = vn;
    }
  }
}

/**
 * Analyse transitoire, comme le .tran de SPICE.
 * - point de fonctionnement initial (les sources variables donnent leur valeur
 *   en DC, voir leur `stamp` en mode "dc") ;
 * - pas fixe `dt`, intégration trapézoïdale, Euler implicite au premier pas ;
 * - si Newton ne converge pas, le pas est découpé en 4, jusqu'à 3 fois.
 * opts : { tstop, dt, tempC, record: [noeuds], onStep(t, v, results) }
 * Retourne { ok, t: Float64Array, traces: Map(noeud -> Float64Array), avg, peak }
 * où avg/peak sont, pour chaque élément, la moyenne temporelle et l'extrême des
 * grandeurs renvoyées par evaluate (même convention que le PWM moyenné).
 */
export function solveTransient(nodeCount, elements, opts) {
  const tempC = opts.tempC ?? 25;
  const { tstop, dt } = opts;
  const sys = prepare(nodeCount, elements);
  const { prepared, nV } = sys;
  let x = operatingPoint(sys, opts);
  if (!x) return { ok: false, error: "Point de fonctionnement initial introuvable." };
  commitCaps(prepared, x, 0, "be");
  const nSteps = Math.round(tstop / dt);
  const rec = opts.record ?? [];
  const t = new Float64Array(nSteps + 1);
  const traces = new Map(rec.map((n) => [n, new Float64Array(nSteps + 1)]));
  const avg = prepared.map(() => ({}));
  const peak = prepared.map(() => ({}));
  const store = (k, time, sol, tran) => {
    t[k] = time;
    for (const [n, arr] of traces) arr[k] = n === 0 ? 0 : sol[n - 1];
    const res = evaluateAll(prepared, nV, sol, tempC, tran);
    const w = k === 0 || k === nSteps ? 0.5 / nSteps : 1 / nSteps;
    for (let j = 0; j < res.length; j++) {
      const r = res[j], a = avg[j], p = peak[j];
      for (const key in r) {
        const val = r[key];
        a[key] = (a[key] ?? 0) + w * val;
        if (key.startsWith("Vmin")) p[key] = Math.min(p[key] ?? Infinity, val);
        else if (p[key] === undefined || Math.abs(val) > Math.abs(p[key])) p[key] = val;
      }
    }
    opts.onStep?.(time, sol, res);
  };
  store(0, 0, x, null);
  let method = "be";
  let time = 0;
  // Un pas, éventuellement découpé en sous-pas si Newton échoue.
  const advance = (t0, h, depth) => {
    const tran = { t: t0 + h, dt: h, prev: x, method };
    const sol = newton(sys, x, { tempC, tran, maxIter: 60 });
    if (sol) {
      commitCaps(prepared, sol, h, method);
      x = sol;
      method = "trap";
      return true;
    }
    if (depth >= 3) return false;
    method = "be";
    for (let i = 0; i < 4; i++) if (!advance(t0 + i * h / 4, h / 4, depth + 1)) return false;
    return true;
  };
  for (let k = 1; k <= nSteps; k++) {
    const t0 = time;
    const xPrev = x;
    if (!advance(t0, dt, 0)) {
      return { ok: false, error: `Non-convergence à t = ${(t0 * 1e3).toFixed(4)} ms.`, t: t.subarray(0, k), traces };
    }
    time = k * dt;
    store(k, time, x, { t: time, dt, prev: xPrev });
  }
  return { ok: true, t, traces, avg, peak, v: (n) => (n === 0 ? 0 : x[n - 1]) };
}
