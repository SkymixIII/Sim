// Moteur de simulation : analyse nodale modifiée (MNA) + Newton-Raphson.
// Point de fonctionnement DC, même méthode que SPICE (.op).
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

/**
 * Prépare un système : alloue les noeuds internes, les branches et la matrice.
 * elements: [{ def, inst, nodes: [n0, n1, ...], state? }]  (noeuds externes, 0 = masse)
 * nodeCount: nombre de noeuds externes, masse comprise.
 */
export function prepare(nodeCount, elements) {
  let nextNode = nodeCount;
  let nBranches = 0;
  const els = elements.map((el) => {
    const nInt = el.def.internalNodes ? el.def.internalNodes(el.inst) : 0;
    const nodes = el.nodes.slice();
    for (let i = 0; i < nInt; i++) nodes.push(nextNode++);
    const nb = el.def.branches ? el.def.branches(el.inst) : 0;
    const branches = [];
    for (let i = 0; i < nb; i++) branches.push(nBranches++);
    return { ...el, nodes, branches, state: el.state ?? {} };
  });
  const nV = nextNode - 1;
  const N = nV + nBranches;
  return { els, nV, N, A: Array.from({ length: N }, () => new Float64Array(N)), b: new Float64Array(N) };
}

/**
 * Résout un système préparé. opts : { tempC, initial, t, dt, trap, trace }.
 *  - sans `dt` : point de fonctionnement continu (condensateurs ouverts, bobines = leur résistance) ;
 *  - avec `dt` : un pas d'analyse transitoire jusqu'à l'instant `t` (Euler implicite, ou trapèzes si `trap`).
 * Retourne { ok, error, v(node), solution, results }.
 */
export function solvePrepared(prep, opts = {}) {
  const tempC = opts.tempC ?? 25; // fiches techniques données à 25 °C
  const { els: prepared, nV, N, A, b } = prep;
  const { t, dt, trap } = opts;

  let x = new Float64Array(N);
  if (opts.initial && opts.initial.length === N) x = Float64Array.from(opts.initial);

  const attempt = (srcFactor, maxIter, x0) => {
    let xs = Float64Array.from(x0);
    let limited = false;
    const idx = (node) => node - 1; // -1 pour la masse
    const ctx = {
      tempC, srcFactor, t, dt, trap,
      v: (node) => (node === 0 ? 0 : xs[node - 1]),
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
      // Source de courant commandée : g·(V(p) − V(n)) traverse le composant de a vers c.
      vccs(a, c, p, n, g) {
        const ia = idx(a), ic = idx(c), ip = idx(p), in_ = idx(n);
        if (ia >= 0) { if (ip >= 0) A[ia][ip] += g; if (in_ >= 0) A[ia][in_] -= g; }
        if (ic >= 0) { if (ip >= 0) A[ic][ip] -= g; if (in_ >= 0) A[ic][in_] += g; }
      },
      // V(a) - V(c) = V ; le courant de branche entre par a (sort du +).
      voltageSource(a, c, V, k) {
        const ia = idx(a), ic = idx(c), r = nV + k;
        if (ia >= 0) { A[ia][r] += 1; A[r][ia] += 1; }
        if (ic >= 0) { A[ic][r] -= 1; A[r][ic] -= 1; }
        b[r] += V;
      },
      // Accès direct à la matrice pour les équations de branche sur mesure (ampli-op, régulateur).
      // Lignes/colonnes : nodeRow(noeud) (−1 = masse, ignorée) ou branchRow(k).
      nodeRow: idx,
      branchRow: (k) => nV + k,
      addA(i, j, val) { if (i >= 0 && j >= 0) A[i][j] += val; },
      addB(i, val) { if (i >= 0) b[i] += val; },
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
      opts.trace?.(iter, xn, xs, limited);
      xs = xn;
      if (converged && iter > 0) return xs;
    }
    return null;
  };

  let sol = attempt(1, 150, x);
  if (!sol && opts.initial) {
    for (const el of prepared) el.state = {};
    sol = attempt(1, 150, new Float64Array(N));
  }
  if (!sol) {
    // Source stepping : on monte progressivement les sources de 0 à 100 %.
    let xs = new Float64Array(N);
    for (const el of prepared) el.state = {};
    let ok = true;
    for (let s = 1; s <= 20; s++) {
      const r = attempt(s / 20, 200, xs);
      if (!r) { ok = false; break; }
      xs = r;
    }
    sol = ok ? xs : null;
  }
  if (!sol) return { ok: false, error: "La simulation ne converge pas (circuit impossible ou instable)." };

  const v = (node) => (node === 0 ? 0 : sol[node - 1]);
  const ctx = { v, branchI: (k) => sol[nV + k], tempC, t, dt, trap };
  const results = prepared.map((el) => (el.def.evaluate ? el.def.evaluate(ctx, el.inst, el.nodes, el.branches) : {}));
  return { ok: true, v, solution: sol, results, ctx };
}

/**
 * Résout puis laisse les composants à état discret (portes logiques, bascules, 555, relais…)
 * mettre à jour leur état via `def.update(ctx, inst, nodes, branches)`. Tant qu'un état change,
 * on résout à nouveau au même instant : les sorties se propagent sans retard.
 */
export function solveSettled(prep, opts = {}) {
  let r;
  for (let pass = 0; pass < 24; pass++) {
    r = solvePrepared(prep, r ? { ...opts, initial: r.solution } : opts);
    if (!r.ok) return r;
    let changed = false;
    for (const el of prep.els) {
      if (el.def.update && el.def.update(r.ctx, el.inst, el.nodes, el.branches)) changed = true;
    }
    if (!changed) break;
  }
  return r;
}

/** Point de fonctionnement continu d'une liste d'éléments (voir `prepare`). */
export function solveDC(nodeCount, elements, opts = {}) {
  return solveSettled(prepare(nodeCount, elements), opts);
}
