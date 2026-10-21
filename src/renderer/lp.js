'use strict';
/* Small dense two-phase simplex for the planner and the balancer.
   solveLP(nv, rows, cost): minimise cost·x over x >= 0 (x has nv entries), subject to
   rows = [{ c: [[varIndex, coefficient], ...], op: '>=' | '<=' | '=', rhs }].
   Returns a Float64Array of the nv variable values, or null when infeasible or unbounded. */
function solveLP(nv, rows, cost) {
  const m = rows.length;
  const norm = rows.map((r) => {
    let op = r.op, rhs = r.rhs, sgn = 1;
    if (rhs < 0) { sgn = -1; rhs = -rhs; op = op === '>=' ? '<=' : op === '<=' ? '>=' : '='; }
    return { c: r.c, op, rhs, sgn };
  });
  let nSlack = 0, nArt = 0;
  for (const r of norm) { if (r.op !== '=') nSlack++; if (r.op !== '<=') nArt++; }
  const N = nv + nSlack + nArt, W = N + 1;
  const T = Array.from({ length: m }, () => new Float64Array(W));
  const basis = new Int32Array(m);
  const isArt = new Uint8Array(N);
  let sc = nv, ac = nv + nSlack;
  norm.forEach((r, i) => {
    const row = T[i];
    for (const [j, a] of r.c) row[j] += a * r.sgn;
    row[N] = r.rhs;
    if (r.op === '<=') { row[sc] = 1; basis[i] = sc++; }
    else { if (r.op === '>=') row[sc++] = -1; row[ac] = 1; isArt[ac] = 1; basis[i] = ac++; }
  });

  const pivot = (l, e, z) => {
    const pr = T[l], pv = pr[e];
    for (let j = 0; j < W; j++) pr[j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === l) continue;
      const row = T[i], f = row[e];
      if (f !== 0) for (let j = 0; j < W; j++) row[j] -= f * pr[j];
    }
    if (z) { const f = z[e]; if (f !== 0) for (let j = 0; j < W; j++) z[j] -= f * pr[j]; }
    basis[l] = e;
  };
  // Primal simplex on the current tableau; Dantzig's rule, switching to Bland's rule if it runs long (anti-cycling).
  const run = (c, banned) => {
    const z = new Float64Array(W);
    for (let j = 0; j < N; j++) z[j] = c[j] || 0;
    for (let i = 0; i < m; i++) {
      const cb = c[basis[i]] || 0;
      if (cb) { const row = T[i]; for (let j = 0; j < W; j++) z[j] -= cb * row[j]; }
    }
    for (let iter = 0; iter < 20000; iter++) {
      const bland = iter > 1500;
      let e = -1, best = -1e-9;
      for (let j = 0; j < N; j++) {
        if (banned && banned[j]) continue;
        if (z[j] < best) { e = j; if (bland) break; best = z[j]; }
      }
      if (e < 0) return true;
      let l = -1, ratio = Infinity;
      for (let i = 0; i < m; i++) {
        const a = T[i][e];
        if (a > 1e-11) {
          const q = T[i][N] / a;
          if (q < ratio - 1e-12 || (l >= 0 && Math.abs(q - ratio) <= 1e-12 && basis[i] < basis[l])) { ratio = q; l = i; }
        }
      }
      if (l < 0) return false;
      pivot(l, e, z);
    }
    return false;
  };

  // Phase 1: find a feasible point by driving the artificial variables to zero.
  if (nArt) {
    const c1 = new Float64Array(N);
    for (let j = 0; j < N; j++) c1[j] = isArt[j];
    if (!run(c1)) return null;
    let infeas = 0;
    for (let i = 0; i < m; i++) if (isArt[basis[i]]) infeas += T[i][N];
    if (infeas > 1e-7 * Math.max(1, ...norm.map((r) => r.rhs))) return null;
    for (let i = 0; i < m; i++) {
      if (!isArt[basis[i]]) continue;
      for (let j = 0; j < nv + nSlack; j++) if (Math.abs(T[i][j]) > 1e-9) { pivot(i, j, null); break; }
    }
  }
  // Phase 2: optimise the real objective; artificial columns may not re-enter.
  const c2 = new Float64Array(N);
  for (let j = 0; j < nv; j++) c2[j] = cost[j] || 0;
  if (!run(c2, isArt)) return null;
  const x = new Float64Array(nv);
  for (let i = 0; i < m; i++) if (basis[i] < nv) x[basis[i]] = Math.max(0, T[i][N]);
  return x;
}
if (typeof module !== 'undefined') module.exports = { solveLP };
