'use strict';
/* Factorio Flow Planner — renderer. Game data comes from the user's own Factorio export (see gamedata.js). */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const canvas = $('#canvas'), world = $('#world'), svg = $('#edges'), labelsEl = $('#labels'), nodesEl = $('#nodes');

let G = null;            // game data model
let S = null;            // factory state (saved to file)
let view = { x: 40, y: 40, k: 0.85 };
let selected = new Set(), R = null, drag = null, FX = {};
let settings = readSettings();

function readSettings() {
  try { return { disabled: [], showAux: false, autoBalance: true, showLocked: false, assumeInputs: true, efficient: true, useLeftovers: true, autoArrange: true, recalcMode: 'replan', ...JSON.parse(localStorage.getItem('ffp-settings') || '{}') }; } catch { return { disabled: [], showAux: false, autoBalance: true, showLocked: false, assumeInputs: true, efficient: true, useLeftovers: true, autoArrange: true, recalcMode: 'replan' }; }
}
const saveSettings = () => { try { localStorage.setItem('ffp-settings', JSON.stringify(settings)); } catch {} };
const blankState = () => ({ v: 1, name: 'New factory', unit: 'min', planet: G.planets[0]?.name || 'nauvis', viewPlanet: G.planets[0]?.name || 'nauvis', nodes: [], edges: [], next: 2, prefs: {}, outposts: [{ id: 1, name: 'Main', planet: G.planets[0]?.name || 'nauvis' }], active: 1 });

/* ---------- Outposts ----------
   Named groups ("folders") of nodes on one shared canvas. Each has its own planet; the active outpost is where new
   nodes and plans go, and its planet is the one used for recipe choices. Links between outposts are allowed. */
const outpost = (id) => (S.outposts || []).find((o) => o.id === id);
const activeOutpost = () => outpost(S.active) || (S.outposts || [])[0];
// Each planet has its own canvas: only outposts on the planet being viewed are shown.
const onCanvas = (o) => o && o.planet === S.viewPlanet;
const visible = (n) => { const o = outpost(n.outpost); return onCanvas(o) && !o.hidden && !o.collapsed; };
function ensureOutposts() {
  if (!Array.isArray(S.outposts) || !S.outposts.length) { S.outposts = [{ id: S.next++, name: S.name && S.name !== 'New factory' ? S.name : 'Main', planet: S.planet }]; }
  for (const n of S.nodes) if (!outpost(n.outpost)) n.outpost = (outpost(S.active) || S.outposts[0]).id;
  if (!S.viewPlanet || !G.planets.some((p) => p.name === S.viewPlanet)) S.viewPlanet = outpost(S.active)?.planet || S.planet || G.planets[0].name;
  if (!onCanvas(outpost(S.active))) S.active = S.outposts.find(onCanvas)?.id ?? null;
  S.planet = S.viewPlanet;
  S.views = S.views || {};
}
// The outpost new nodes go into; on a planet without outposts one is created when first needed.
function needActive() {
  if (!onCanvas(outpost(S.active))) {
    const P = G.planets.find((x) => x.name === S.viewPlanet);
    S.active = newOutpost(`${P ? P.label : 'New'} outpost`, S.viewPlanet).id;
    renderOutposts();
  }
  return S.active;
}
// Show another planet's canvas, with the view that canvas had last time.
function switchCanvas(planetName, keepView = false) {
  if (!planetName || planetName === S.viewPlanet) return;
  S.views = S.views || {};
  S.views[S.viewPlanet] = { ...view };
  S.viewPlanet = planetName; S.planet = planetName;
  if (!onCanvas(outpost(S.active))) S.active = S.outposts.find(onCanvas)?.id ?? null;
  localCache = {}; selected.clear();
  syncToolbar(); rebuild();
  if (settings.autoArrange) arrange();
  if (!keepView) { if (S.views[planetName]) { view = { ...S.views[planetName] }; applyView(); drawEdges(); } else fitView(); }
  autosave();
}
const planetOf = (n) => G.planets.find((p) => p.name === (outpost(n.outpost)?.planet || S.planet)) || planet();
function setActive(id, focus = false) {
  if (!outpost(id)) return;
  if (outpost(id).planet !== S.viewPlanet) switchCanvas(outpost(id).planet, true);
  S.active = id;
  S.planet = S.viewPlanet;
  localCache = {};
  syncToolbar(); renderOutposts(); renderSide(); drawFrames();
  if (focus) focusOutpost(id);
}

/* ---------- Formatting & icons ---------- */
const UNITS = { s: 1, min: 60, h: 3600 };
const uf = () => UNITS[S.unit] || 60;
const us = () => '/' + S.unit;
function fmt(v, scale = true) {
  if (scale) v *= uf();
  if (!isFinite(v)) return '∞';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (a >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a >= 1000) return Math.round(v).toLocaleString();
  if (a >= 100) return v.toFixed(1).replace(/\.0$/, '');
  return (+v.toFixed(2)).toString();
}
// Number inputs need plain digits (no thousands separators).
const rateField = (v) => +((+v || 0) * uf()).toFixed(3);
const fmtW = (w) => (w >= 1e9 ? (w / 1e9).toFixed(2) + ' GW' : w >= 1e6 ? (w / 1e6).toFixed(2) + ' MW' : (w / 1e3).toFixed(0) + ' kW');
const abbr = (l) => { const w = String(l).split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : String(l).slice(0, 2)).toUpperCase(); };
function ic(path, label, cls = '') {
  if (path) return `<img class="ic ${cls}" src="ffp://icons/${path}" alt="" title="${esc(label)}" draggable="false" loading="lazy" data-fb="${esc(abbr(label))}">`;
  return `<span class="ic fb ${cls}" title="${esc(label)}">${esc(abbr(label))}</span>`;
}
const item = (n) => G.items[n] || { name: n, label: n, type: 'item', icon: null };
const itemIc = (n, cls) => ic(item(n).icon, item(n).label, cls);
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t.tagName === 'IMG' && t.dataset.fb !== undefined) {
    const s = document.createElement('span');
    s.className = t.className + ' fb'; s.textContent = t.dataset.fb; s.title = t.title;
    t.replaceWith(s);
  }
}, true);
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200); }

/* ---------- Planets, machines, effects ---------- */
const planetRaw = () => G.planets.find((p) => p.name === S.planet) || G.planets[0];
const planet = () => { const p = planetRaw(); return p && !p._withSteam ? Object.assign(p, { _withSteam: true, resources: (p.resources || []).includes('water') ? [...new Set([...p.resources, ...ALWAYS_LOCAL])] : p.resources || [] }) : p; };
function condOK(conds, p = planet()) {
  if (!conds || !conds.length || !p) return true;
  return conds.every((c) => { const v = p.props[c.p] ?? 0; return (c.min == null || v >= c.min) && (c.max == null || v <= c.max); });
}
function machinesFor(r, all = false) {
  return Object.values(G.machines).filter((M) => M.categories.includes(r.category) && (all || (condOK(M.conditions) && !settings.disabled.includes(M.name))));
}
// Fuel-burning buildings (stone/steel furnace, biochamber) rank below electric ones; they stay the choice when nothing else fits.
const machineScore = (M, r) => M.speed * (1 + (r.allowProd ? M.baseProd : 0)) * (M.burner ? 0.3 : 1);
function bestMachine(r) {
  let ms = machinesFor(r);
  if (!ms.length) ms = machinesFor(r, true);
  return ms.sort((a, b) => machineScore(b, r) - machineScore(a, r))[0];
}
const minedHere = (r) => !r.mining || (planet().resources || []).includes(r.main);
const recipeOK = (r) => condOK(r.conditions) && minedHere(r) && machinesFor(r).length > 0;
// Why a recipe can't be used here, for the add-node list.
function unusableReason(r) {
  if (!condOK(r.conditions) || !minedHere(r)) return 'Not on ' + planet().label;
  if (!machinesFor(r).length) return machinesFor(r, true).some((m) => condOK(m.conditions)) ? 'Building locked' : 'Not on ' + planet().label;
  return '';
}
const qLevel = (q) => (G.qualities.find((x) => x.name === q) || { level: 0 }).level;
function modEffect(name, q, count) {
  const e = { speed: 0, productivity: 0, consumption: 0, quality: 0 };
  const m = G.modules[name];
  if (!m || !count) return e;
  const k = 1 + 0.3 * qLevel(q);
  for (const key in e) { const v = m.effect[key] || 0; e[key] = (v > 0 ? v * k : v) * count; }
  return e;
}
function moduleFits(m, allowed, r) {
  for (const [k, v] of Object.entries(m.effect)) {
    if (v > 0 && !allowed.includes(k)) return false;
    if (k === 'productivity' && v > 0 && r && !r.allowProd) return false;
  }
  return true;
}
function fx(n) {
  const r = G.recipes[n.recipe];
  const M = G.machines[n.machine] || bestMachine(r);
  const t = { speed: 0, productivity: 0, consumption: 0, quality: 0 };
  const add = (e, f = 1) => { for (const k in t) t[k] += (e[k] || 0) * f; };
  if (n.mod && M.slots) add(modEffect(n.mod, n.modq, Math.min(n.modN ?? M.slots, M.slots)));
  const B = G.beacon;
  if (B && n.bc > 0 && n.bmod) add(modEffect(n.bmod, n.bmodq, B.slots), B.eff * (B.profile[Math.min(n.bc, B.profile.length) - 1] ?? 1) * n.bc);
  if (!M.allowed.includes('productivity')) t.productivity = 0;
  t.speed += (+n.xspeed || 0) / 100;
  const prod = r.allowProd ? Math.max(0, Math.min(r.maxProd, (M.baseProd || 0) + t.productivity + (+n.xprod || 0) / 100)) : 0;
  const qm = M.kind === 'craft' ? 1 + 0.3 * qLevel(n.mq) : 1;
  return { M, speed: M.speed * qm * Math.max(0.2, 1 + t.speed), prod, power: M.power * Math.max(0.2, 1 + t.consumption), quality: Math.max(0, t.quality), bonus: t };
}
const fxc = (n) => FX[n.id] || (FX[n.id] = fx(n));

function nominal(n) {
  const ins = {}, outs = {};
  if (n.type === 'recipe') {
    const r = G.recipes[n.recipe];
    if (!r) return { ins, outs };
    const f = fxc(n), cps = (+n.count || 0) * f.speed / r.time;
    for (const i of r.in) ins[i.n] = (ins[i.n] || 0) + i.a * cps;
    for (const o of r.out) outs[o.n] = (outs[o.n] || 0) + (o.a + Math.max(0, o.a - o.ig) * f.prod) * cps;
    // Loops inside one recipe (coal liquefaction, Kovarex): while the machine's own output of an item it also uses isn't
    // routed both out and back in (e.g. through a priority splitter), it feeds itself and only the difference moves.
    for (const k in ins) if (k in outs && !(S.edges.some((e) => e.to === n.id && e.item === k) && S.edges.some((e) => e.from === n.id && e.item === k))) { const d = outs[k] - ins[k]; ins[k] = Math.max(0, -d); outs[k] = Math.max(0, d); }
  } else if (n.type === 'source') outs[n.item] = +n.rate || 0;
  else if (n.type === 'sink') ins[n.item] = Infinity;
  return { ins, outs };
}
const perMachine = (n) => { const x = nominal({ ...n, count: 1 }); return { i: x.ins, o: x.outs }; };

// What one unit/s of an outside supply "costs" when optimising: pumped fluids are nearly free, other fluids cheap, items dear.
// Steam comes from boilers (not modelled), so on planets with pumpable water it counts as a cheap local resource.
const ALWAYS_LOCAL = ['steam'];
function supplyCost(it) {
  if (ALWAYS_LOCAL.includes(it) && (planet().resources || []).includes(it)) return 0.01;
  if (G.recipes['pump:' + it] && minedHere(G.recipes['pump:' + it])) return 0.001;
  return item(it).type === 'fluid' ? 0.1 : 1;
}

/* ---------- Flow solver ---------- */
// Consumers split their demand across incoming links; producers share stock proportionally;
// a machine's utilisation is its scarcest input, which feeds back into what it can supply. Iterated to a fixed point.
// Outgoing links of a splitter, highest priority first.
function splitterOuts(n) {
  const outs = S.edges.filter((e) => e.from === n.id);
  const order = n.prio || [];
  const rank = (e) => { const i = order.indexOf(e.id); return i < 0 ? 1e6 + e.id : i; };
  return outs.sort((a, b) => rank(a) - rank(b));
}
function solve() {
  FX = {};
  const byId = new Map(S.nodes.map((n) => [n.id, n]));
  const nom = {};
  S.nodes.forEach((n) => (nom[n.id] = nominal(n)));
  let eff = {};
  S.nodes.forEach((n) => (eff[n.id] = 1));
  const edges = S.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const fin = edges.filter((e) => byId.get(e.to).type !== 'sink');
  // Priority splitters pass on what they receive; they ask upstream for whatever their outputs ask of them.
  const splitters = S.nodes.filter((n) => n.type === 'splitter');
  const sDemand = {};
  const demandOf = (sid, seen = new Set()) => {
    if (sDemand[sid] != null) return sDemand[sid];
    if (seen.has(sid)) return 0;
    seen.add(sid);
    let d = 0;
    for (const e of fin) {
      if (e.from !== sid) continue;
      const c = byId.get(e.to);
      if (c.type === 'splitter') d += demandOf(c.id, seen);
      else d += nom[c.id].ins[e.item] || 0;
    }
    return (sDemand[sid] = d);
  };
  const outlet = new Set(edges.filter((e) => byId.get(e.from).type === 'splitter' && byId.get(e.to).type === 'sink').map((e) => e.from));
  for (const sp of splitters) { const d = demandOf(sp.id); nom[sp.id] = { ins: { [sp.item]: d }, outs: { [sp.item]: d } }; }
  const sRank = new Map();
  for (const sp of splitters) splitterOuts(sp).forEach((e, i) => sRank.set(e.id, i));
  let recv = {};
  splitters.forEach((sp) => (recv[sp.id] = sDemand[sp.id])); // start optimistic so loops can start up
  // Inputs nobody is connected to are assumed to arrive from outside (setting), so the rest of the chain still runs.
  const fed = new Set(fin.map((e) => e.to + '|' + e.item));
  const assumed = {};
  if (settings.assumeInputs) for (const n of S.nodes) if (n.type === 'recipe') for (const k in nom[n.id].ins) if (nom[n.id].ins[k] > 1e-12 && !fed.has(n.id + '|' + k)) (assumed[n.id] = assumed[n.id] || {})[k] = nom[n.id].ins[k];
  const snk = edges.filter((e) => byId.get(e.to).type === 'sink');
  const groups = new Map();
  fin.forEach((e) => { const k = e.to + '|' + e.item; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
  const sinkGroups = new Map();
  snk.forEach((e) => { const k = e.from + '|' + e.item; if (!sinkGroups.has(k)) sinkGroups.set(k, []); sinkGroups.get(k).push(e); });
  let res;
  for (let it = 0; it < 150; it++) {
    const left = {}, got = {}, flow = {};
    S.nodes.forEach((n) => {
      left[n.id] = {}; got[n.id] = {};
      if (n.type === 'splitter') { left[n.id][n.item] = recv[n.id] || 0; got[n.id][n.item] = 0; return; }
      for (const k in nom[n.id].outs) left[n.id][k] = nom[n.id].outs[k] * eff[n.id];
      for (const k in nom[n.id].ins) got[n.id][k] = assumed[n.id]?.[k] || 0;
    });
    edges.forEach((e) => (flow[e.id] = 0));
    for (let round = 0; round < 8; round++) {
      const req = new Map();
      for (const es of groups.values()) {
        const e0 = es[0];
        const un = (nom[e0.to].ins[e0.item] || 0) - (got[e0.to][e0.item] || 0);
        if (un <= 1e-12) continue;
        const live = es.filter((e) => (left[e.from][e.item] || 0) > 1e-12);
        for (const e of live) req.set(e, un / live.length);
      }
      if (!req.size) break;
      const byProd = new Map();
      for (const [e, q] of req) { const k = e.from + '|' + e.item; if (!byProd.has(k)) byProd.set(k, []); byProd.get(k).push([e, q]); }
      const take = [];
      for (const list of byProd.values()) {
        const e0 = list[0][0], L = left[e0.from][e0.item] || 0;
        if (byId.get(e0.from).type === 'splitter') {
          // Priority: serve outputs in order until the splitter runs dry.
          let rest = L;
          list.sort((a, b) => sRank.get(a[0].id) - sRank.get(b[0].id));
          for (const [e, q] of list) { const g = Math.min(q, rest); rest -= g; take.push([e, g]); }
        } else {
          const T = list.reduce((a, x) => a + x[1], 0);
          for (const [e, q] of list) take.push([e, T > L ? (q * L) / T : q]);
        }
      }
      for (const [e, q] of take) { flow[e.id] += q; got[e.to][e.item] = (got[e.to][e.item] || 0) + q; left[e.from][e.item] -= q; }
    }
    reallocate(fin.filter((e) => byId.get(e.from).type !== 'splitter' && byId.get(e.to).type !== 'splitter'), nom, eff, left, got, flow);
    // Leftovers: first into splitters that end in an Output, then on to the Outputs themselves.
    for (const e of fin) {
      if (!outlet.has(e.to) || byId.get(e.from).type === 'splitter') continue;
      const L = Math.max(0, left[e.from][e.item] || 0);
      if (L <= 1e-12) continue;
      // Counted as received now; the splitter passes it on next pass (its stock is what it received last pass).
      flow[e.id] += L; got[e.to][e.item] += L; left[e.from][e.item] = 0;
    }
    for (const es of sinkGroups.values()) {
      const L = Math.max(0, left[es[0].from][es[0].item] || 0);
      for (const e of es) { flow[e.id] = L / es.length; got[e.to][e.item] = (got[e.to][e.item] || 0) + L / es.length; }
      left[es[0].from][es[0].item] = 0;
    }
    const ne = {}, nr = {};
    let diff = 0;
    S.nodes.forEach((n) => {
      let f = 1;
      if (n.type === 'recipe') for (const k in nom[n.id].ins) { const need = nom[n.id].ins[k]; if (need > 1e-12) f = Math.min(f, (got[n.id][k] || 0) / need); }
      ne[n.id] = Math.max(0, Math.min(1, f));
      diff = Math.max(diff, Math.abs(ne[n.id] - eff[n.id]));
    });
    for (const sp of splitters) { nr[sp.id] = got[sp.id][sp.item] || 0; diff = Math.max(diff, Math.abs(nr[sp.id] - (recv[sp.id] || 0)) / Math.max(1e-9, sDemand[sp.id] || 1)); }
    const nomOut = { ...nom };
    for (const sp of splitters) nomOut[sp.id] = { ins: nom[sp.id].ins, outs: { [sp.item]: nr[sp.id] } };
    res = { nom: nomOut, eff: ne, left, got, flow, assumed };
    eff = ne; recv = nr;
    if (diff < 1e-9) break;
  }
  return res || { nom, eff, left: {}, got: {}, flow: {}, assumed };
}
// Per item, if a consumer is still short while a producer it is linked to has stock left, route the flow optimally (max flow).
function reallocate(fin, nom, eff, left, got, flow) {
  const byItem = new Map();
  for (const e of fin) { if (!byItem.has(e.item)) byItem.set(e.item, []); byItem.get(e.item).push(e); }
  for (const [it, es] of byItem) {
    const fixable = es.some((e) => (nom[e.to].ins[it] || 0) - (got[e.to][it] || 0) > 1e-9 && es.some((f) => f.to === e.to && (left[f.from][it] || 0) > 1e-9));
    if (!fixable) continue;
    const prods = [...new Set(es.map((e) => e.from))], cons = [...new Set(es.map((e) => e.to))];
    const rows = [
      ...prods.map((pid) => ({ c: es.map((e, k) => [k, e.from === pid ? 1 : 0]).filter((x) => x[1]), op: '<=', rhs: (nom[pid].outs[it] || 0) * eff[pid] })),
      ...cons.map((cid) => ({ c: es.map((e, k) => [k, e.to === cid ? 1 : 0]).filter((x) => x[1]), op: '<=', rhs: nom[cid].ins[it] || 0 })),
    ];
    const x = solveLP(es.length, rows, es.map(() => -1));
    if (!x) continue;
    for (const pid of prods) left[pid][it] = (nom[pid].outs[it] || 0) * eff[pid];
    for (const cid of cons) got[cid][it] = 0;
    es.forEach((e, k) => { flow[e.id] = x[k]; got[e.to][it] += x[k]; left[e.from][it] -= x[k]; });
  }
}
function portDemand(nid, it) {
  let d = 0;
  for (const e of S.edges) {
    if (e.from !== nid || e.item !== it) continue;
    const c = node(e.to);
    if (!c || c.type === 'sink') continue;
    const k = S.edges.filter((x) => x.to === c.id && x.item === it).length;
    d += (nominal(c).ins[it] || 0) / k;
  }
  return d;
}
function fitNode(n) {
  if (n.type === 'source') { const d = portDemand(n.id, n.item); if (d > 0) n.rate = d; return; }
  if (n.type !== 'recipe') return;
  const pm = perMachine(n);
  let c = 0, feedsOutput = false;
  for (const k in pm.o) {
    const d = portDemand(n.id, k);
    if (d > 0 && pm.o[k] > 0) c = Math.max(c, d / pm.o[k]);
    if (S.edges.some((e) => e.from === n.id && e.item === k && node(e.to)?.type === 'sink')) feedsOutput = true;
  }
  // Something that feeds an Output node is a goal: it can grow to cover other consumers but never shrinks.
  if (feedsOutput) c = Math.max(c, +n.count || 0);
  if (c > 0) n.count = c;
}
// Size every machine and supply to what its consumers need, as one optimisation over the actual connections,
// so byproducts and loops balance too. Pinned nodes, and nodes nothing consumes from (goals), keep their size.
// How much an Output node must keep receiving over one link: its planned rate if it has one, otherwise what it got.
function sinkNeed(e) {
  const sk = node(e.to);
  if (sk && sk.target != null) return +sk.target / Math.max(1, S.edges.filter((x) => x.to === sk.id).length);
  return (R && R.flow[e.id]) || 0;
}
function balanceAll() {
  FX = {};
  const nodesV = S.nodes.filter((n) => n.type !== 'sink' && (n.type !== 'recipe' || G.recipes[n.recipe]));
  const idx = new Map(nodesV.map((n, j) => [n.id, j]));
  const live = S.edges.filter((e) => idx.has(e.from) && idx.has(e.to));
  const eIdx = new Map(live.map((e, k) => [e.id, nodesV.length + k]));
  let nv = nodesV.length + live.length;
  const per = new Map(nodesV.map((n) => [n.id, n.type === 'recipe' ? perMachine(n) : n.type === 'splitter' ? { i: {}, o: {} } : { i: {}, o: { [n.item]: 1 } }]));
  const rows = [], cost = [];
  for (const c of nodesV) {
    const pc = per.get(c.id);
    for (const it in pc.i) {
      if (!(pc.i[it] > 1e-12)) continue;
      const inc = live.filter((e) => e.to === c.id && e.item === it);
      if (!inc.length && settings.assumeInputs) continue;
      const short = nv++;
      // A shortage belongs where supply really runs out: an unconnected input or fixed (pinned) suppliers.
      // Inputs fed by a producer that can still grow are kept satisfied, so the chain is never shrunk to hide it.
      cost[short] = inc.some((e) => !node(e.from).pin) ? 1e9 : 1e6;
      // A consumer takes exactly what it uses (inflow plus any shortage equals its need), so links can't hide leftovers.
      rows.push({ c: [...inc.map((e) => [eIdx.get(e.id), 1]), [short, 1], [idx.get(c.id), -pc.i[it]]], op: '=', rhs: 0 });
    }
  }
  for (const p of nodesV) {
    const pp = per.get(p.id);
    for (const it in pp.o) {
      const outs = live.filter((e) => e.from === p.id && e.item === it);
      if (!outs.length) continue;
      // What already reaches Output nodes from here must keep arriving (e.g. when another outpost starts drawing on it).
      const toOutputs = S.edges.filter((e) => e.from === p.id && e.item === it && node(e.to)?.type === 'sink').reduce((a, e) => a + sinkNeed(e), 0);
      rows.push({ c: [...outs.map((e) => [eIdx.get(e.id), 1]), [idx.get(p.id), -pp.o[it]]], op: '<=', rhs: -toOutputs });
      // Use up leftovers: output that is connected onward but not taken is penalised.
      if (settings.useLeftovers && p.type === 'recipe') {
        const w = nv++;
        cost[w] = item(it).type === 'fluid' ? 50 : 500;
        rows.push({ c: [...outs.map((e) => [eIdx.get(e.id), 1]), [w, 1], [idx.get(p.id), -pp.o[it]]], op: '>=', rhs: -toOutputs });
      }
    }
  }
  for (const sp of nodesV.filter((n) => n.type === 'splitter')) {
    const toOutputs = S.edges.filter((e) => e.from === sp.id && node(e.to)?.type === 'sink').reduce((a, e) => a + sinkNeed(e), 0);
    const c = [...live.filter((e) => e.from === sp.id).map((e) => [eIdx.get(e.id), 1]), ...live.filter((e) => e.to === sp.id).map((e) => [eIdx.get(e.id), -1])];
    rows.push({ c, op: '<=', rhs: -toOutputs });
  }
  for (const n of nodesV) {
    if (n.type === 'splitter') continue;
    const j = idx.get(n.id), cur = n.type === 'recipe' ? +n.count || 0 : +n.rate || 0;
    const consumed = live.some((e) => e.from === n.id);
    const feedsOutput = S.edges.some((e) => e.from === n.id && node(e.to)?.type === 'sink');
    const absorbs = n.absorb && n.type === 'recipe' && !n.pin;
    if (absorbs) { /* sized freely below: a tiny reward makes it use whatever leftover reaches it */ }
    else if (n.pin || !consumed) rows.push({ c: [[j, 1]], op: '=', rhs: cur });
    else if (feedsOutput) rows.push({ c: [[j, 1]], op: '>=', rhs: cur });
    cost[j] = absorbs ? -1e-7 : n.type === 'source' ? supplyCost(n.item) : 1e-3;
  }
  const x = solveLP(nv, rows, cost);
  if (!x) { legacyBalance(); return; }
  for (const n of nodesV) {
    if (n.type === 'splitter' || n.pin || (!(n.absorb && n.type === 'recipe') && !live.some((e) => e.from === n.id))) continue;
    const v = x[idx.get(n.id)] < 1e-9 ? 0 : x[idx.get(n.id)];
    if (n.type === 'recipe') n.count = v; else n.rate = v;
  }
  FX = {};
}
// Fallback: size each node to its consumers, repeated until stable.
function legacyBalance() {
  for (let pass = 0; pass < 40; pass++) {
    const before = JSON.stringify(S.nodes.map((n) => [n.count, n.rate]));
    FX = {};
    S.nodes.forEach((n) => { if (!n.pin) fitNode(n); });
    if (JSON.stringify(S.nodes.map((n) => [n.count, n.rate])) === before) break;
  }
  FX = {};
}
function autoBalance() { if (settings.autoBalance) balanceAll(); }

/* ---------- State helpers ---------- */
const node = (id) => S.nodes.find((n) => n.id === id);
function addNode(o) {
  const n = { id: S.next++, x: 0, y: 0, ...o };
  if (n.outpost == null) n.outpost = outpost(S.active) ? S.active : needActive();
  if (n.type === 'recipe') {
    const r = G.recipes[n.recipe];
    if (!n.machine || !G.machines[n.machine] || !G.machines[n.machine].categories.includes(r.category)) n.machine = bestMachine(r).name;
    n.count = n.count ?? 1;
    n.mq = n.mq || 'normal';
  }
  if (n.type === 'source') n.rate = n.rate ?? (item(n.item).type === 'fluid' ? 100 : 1);
  S.nodes.push(n);
  return n;
}
function connect(from, to, it) {
  if (from === to || S.edges.some((e) => e.from === from && e.to === to && e.item === it)) return null;
  const e = { id: S.next++, from, to, item: it };
  S.edges.push(e);
  const f = node(from);
  if (f && f.type === 'splitter') (f.prio = f.prio || []).push(e.id);
  return e;
}
function delNodes(ids) {
  const gone = new Set(ids);
  // Deleting a final product or an Output keeps its supply chain; deleting anything else also removes what only supplied it.
  const goal = ids.some((id) => { const n = node(id); return n && (n.type === 'sink' || S.edges.some((e) => e.from === id && node(e.to)?.type === 'sink')); });
  const suppliers = S.edges.filter((e) => gone.has(e.to) && !gone.has(e.from)).map((e) => e.from);
  S.nodes = S.nodes.filter((n) => !gone.has(n.id));
  S.edges = S.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  ids.forEach((id) => selected.delete(id));
  if (settings.autoBalance && !goal) {
    const before = S.nodes.length;
    pruneOrphans(suppliers);
    const k = before - S.nodes.length;
    if (k) toast(`Also removed ${k} node${k > 1 ? 's' : ''} that only supplied it. Ctrl+Z to undo.`);
  }
  autoBalance();
  rebuild(); maybeArrange(); commit();
}
const delNode = (id) => delNodes([id]);

/* ---------- History, autosave, dirty ---------- */
let hist = [], hi = -1, histT = null;
function snapshot() { histT = null; const s = JSON.stringify(S); if (hist[hi] === s) return; hist = hist.slice(0, hi + 1); hist.push(s); if (hist.length > 200) hist.shift(); hi = hist.length - 1; }
function commit() { clearTimeout(histT); histT = setTimeout(snapshot, 250); window.ffp.setDirty(true); autosave(); }
function resetHistory() { hist = [JSON.stringify(S)]; hi = 0; }
function undo(dir) {
  if (histT) { clearTimeout(histT); snapshot(); }
  const j = hi + dir;
  if (j < 0 || j >= hist.length) return;
  hi = j; S = JSON.parse(hist[hi]); selected.clear();
  syncToolbar(); rebuild(); window.ffp.setDirty(true); autosave();
}
let saveT;
function autosave() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('ffp-autosave', JSON.stringify({ S, view })); } catch {} }, 400); }

/* ---------- Rendering ---------- */
function portRow(n, it, dir) {
  const I = item(it);
  const port = `<span class="port ${I.type === 'fluid' ? 'fluid' : ''}" data-node="${n.id}" data-item="${esc(it)}" data-dir="${dir}"></span>`;
  const val = `<span class="val" data-v="${dir}:${esc(it)}"></span>`;
  return `<div class="row ${dir}" title="${esc(I.label)}">${port}${dir === 'in' ? ic(I.icon, I.label, 'sm') + val : val + ic(I.icon, I.label, 'sm')}</div>`;
}
const ioHTML = (n, ins, outs) => `<div class="io ${ins.length && outs.length ? '' : 'one'}">${ins.length ? `<div class="col">${ins.map((i) => portRow(n, i, 'in')).join('')}</div>` : ''}${outs.length ? `<div class="col out">${outs.map((o) => portRow(n, o, 'out')).join('')}</div>` : ''}</div>`;
const headHTML = (n, icon, label, sub, canOpen) => `<div class="nh">${icon}<div class="tt"><div class="title" title="${esc(label)}">${esc(label)}</div><div class="kind">${sub}</div></div>${n.pin && n.type === 'recipe' ? `<button class="x pin" data-act="unpin" title="You set this count yourself, so Auto-balance leaves it alone. Click to size it automatically again.">📌</button>` : ''}${canOpen ? `<button class="x chev" data-act="open" aria-expanded="${!!n.open}" title="${n.open ? 'Hide' : 'Show'} details">${n.open ? '▴' : '▾'}</button>` : ''}<button class="x" data-act="del" aria-label="Delete node" title="Delete node">×</button></div>`;
const qualityOpts = (cur) => G.qualities.map((q) => `<option value="${q.name}" ${q.name === (cur || 'normal') ? 'selected' : ''}>${esc(q.label)}</option>`).join('');
const bySort = (a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0);

function recipeNodeHTML(n) {
  const r = G.recipes[n.recipe], f = fxc(n), M = f.M;
  let ms = machinesFor(r);
  if (!ms.length) ms = machinesFor(r, true);
  if (!ms.some((m) => m.name === M.name)) ms.push(M);
  let mopts = ms.map((m) => `<option value="${m.name}" ${m.name === M.name ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  const alts = r.mining ? [] : (byOut[r.main] || []).filter((x) => x.name !== r.name && !x.aux && !x.hidden && !x.mining && recipeOK(x));
  if (alts.length) mopts += `<optgroup label="Other recipes for ${esc(item(r.main).label)}">${alts.flatMap((x) => machinesFor(x).map((m) => `<option value="recipe:${x.name}|${m.name}">${esc(m.label)}: ${esc(x.label)}</option>`)).join('')}</optgroup>`;
  const mods = Object.values(G.modules).filter((m) => moduleFits(m, M.allowed, r)).sort(bySort);
  const bmods = G.beacon ? Object.values(G.modules).filter((m) => moduleFits(m, G.beacon.allowed, r)).sort(bySort) : [];
  const modOpts = (list, cur) => '<option value="">None</option>' + list.map((m) => `<option value="${m.name}" ${m.name === cur ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  const bad = [];
  if (!condOK(r.conditions)) bad.push(`${esc(r.label)} can't be made on ${esc(planet().label)}.`);
  else if (!condOK(M.conditions)) bad.push(`${esc(M.label)} can't be built on ${esc(planet().label)}.`);
  const mid = 'n' + n.id;
  const sub = `<span class="hcount"></span>${ic(M.icon, M.label, 'xs')}${n.absorb && !n.pin ? `<span class="absorb" title="Sized to use all leftover ${esc(item(n.absorb).label)}">♻</span>` : ''}${bad.length ? `<span class="hwarn" title="${bad.join(' ')}">⚠</span>` : ''}<span class="heff"></span>`;
  const adv = !n.open ? '' : `<div class="adv">
    ${bad.map((b) => `<div class="warnline">${b}</div>`).join('')}
    ${n.absorb && !n.pin ? `<div class="note">♻ Uses all leftover ${esc(item(n.absorb).label)}. <button class="linkbtn" data-act="noabsorb">Size normally</button></div>` : ''}
    <div class="ctl">${ic(M.icon, M.label, 'sm')}<select id="${mid}-m" data-f="machine" aria-label="Machine">${mopts}</select><span class="lbl">×</span><input id="${mid}-c" class="num" type="number" min="0" step="1" data-f="count" value="${+(+n.count).toFixed(3)}" aria-label="Machine count"><button class="mini" data-act="fit" title="Match downstream demand">Fit</button></div>
    <div class="stat"><div class="meter"><i></i></div><span class="eff"></span></div>
    <div class="stat"><span class="ceil"></span><span class="fxs"></span></div>
    ${M.kind === 'craft' ? `<div class="ctl"><span class="lbl w">Quality</span><select id="${mid}-mq" data-f="mq" aria-label="Machine quality">${qualityOpts(n.mq)}</select></div>` : ''}
    ${M.slots ? `<div class="ctl"><span class="lbl w">Modules</span><select id="${mid}-mod" data-f="mod" aria-label="Module">${modOpts(mods, n.mod)}</select></div>
    <div class="ctl"><span class="lbl w"></span><select id="${mid}-modq" class="q" data-f="modq" aria-label="Module quality">${qualityOpts(n.modq)}</select><span class="lbl">×</span><input id="${mid}-modn" class="num sm" type="number" min="0" max="${M.slots}" data-f="modN" value="${n.modN ?? M.slots}" aria-label="Module count"><span class="note">/ ${M.slots}</span></div>` : ''}
    ${G.beacon ? `<div class="ctl"><span class="lbl w">Beacons</span><select id="${mid}-bmod" data-f="bmod" aria-label="Beacon module">${modOpts(bmods, n.bmod)}</select></div>
    <div class="ctl"><span class="lbl w"></span><select id="${mid}-bmodq" class="q" data-f="bmodq" aria-label="Beacon module quality">${qualityOpts(n.bmodq)}</select><span class="lbl">×</span><input id="${mid}-bc" class="num sm" type="number" min="0" max="16" data-f="bc" value="${n.bc || 0}" aria-label="Beacon count" title="Beacons in range"></div>` : ''}
    <div class="ctl"><span class="lbl w">Bonus %</span><span class="lbl">Prod</span><input id="${mid}-xp" class="num sm" type="number" step="10" data-f="xprod" value="${n.xprod || 0}" title="Extra productivity from research, in %" aria-label="Extra productivity percent"><span class="lbl">Speed</span><input id="${mid}-xs" class="num sm" type="number" step="10" data-f="xspeed" value="${n.xspeed || 0}" title="Extra speed, in %" aria-label="Extra speed percent"></div>
  </div>`;
  return headHTML(n, ic(r.icon, r.label, 'lg'), r.label, sub, true) + `<div class="nb">${ioHTML(n, r.in.map((i) => i.n), r.out.map((o) => o.n))}${adv}</div>`;
}
function nodeHTML(n) {
  if (n.type === 'recipe') return recipeNodeHTML(n);
  const I = item(n.item);
  if (n.type === 'splitter') {
    const outs = splitterOuts(n);
    const rows = outs.map((e, i) => {
      const c = node(e.to);
      const lbl = !c ? '?' : c.type === 'recipe' ? G.recipes[c.recipe].label : c.type === 'sink' ? 'Output' : c.type === 'splitter' ? 'Priority splitter' : item(c.item).label;
      const icon = c && c.type === 'recipe' ? G.recipes[c.recipe].icon : I.icon;
      return `<div class="prow"><span class="pn">${i + 1}</span>${ic(icon, lbl, 'xs')}<span class="nm" title="${esc(lbl)}">${esc(lbl)}</span><span class="pv" data-e="${e.id}"></span><button class="pbtn" data-act="up" data-e="${e.id}" ${i === 0 ? 'disabled' : ''} aria-label="Higher priority">▲</button><button class="pbtn" data-act="down" data-e="${e.id}" ${i === outs.length - 1 ? 'disabled' : ''} aria-label="Lower priority">▼</button></div>`;
    }).join('');
    return headHTML(n, ic(I.icon, I.label, 'lg'), 'Priority splitter', esc(I.label), false)
      + `<div class="nb">${ioHTML(n, [n.item], [n.item])}<div class="plist2">${rows || '<div class="note">Drag from the output to add consumers. Number 1 is served first, the rest get what is left.</div>'}</div></div>`;
  }
  if (n.type === 'source') {
    const here = (planet().resources || []).includes(n.item);
    const row = `<div class="row out src" title="${esc(I.label)}"><input id="n${n.id}-r" class="num" type="number" min="0" data-f="rate" value="${rateField(n.rate)}" aria-label="Amount supplied"><span class="lbl">${us()}</span>${ic(I.icon, I.label, 'sm')}<span class="port ${I.type === 'fluid' ? 'fluid' : ''}" data-node="${n.id}" data-item="${esc(n.item)}" data-dir="out"></span></div>`;
    const foot = `<div class="srcfoot"><button class="mini tog" data-act="auto" aria-pressed="${!n.pin}" title="Auto supplies exactly what is needed. Type an amount to fix it.">Auto</button><span class="note">${n.pin ? 'Fixed amount' : 'Matches what is needed'}</span></div>`;
    return headHTML(n, ic(I.icon, I.label, 'lg'), I.label, here ? 'Resource' : 'Import', false) + `<div class="nb">${row}${foot}</div>`;
  }
  return headHTML(n, ic(I.icon, I.label, 'lg'), I.label, 'Output', false) + `<div class="nb">${ioHTML(n, [n.item], [])}</div>`;
}
function buildNode(n) {
  const keep = S.planet;
  S.planet = planetOf(n).name;
  try { return buildNodeHere(n); } finally { S.planet = keep; }
}
function buildNodeHere(n) {
  const el = document.createElement('div');
  el.className = 'node' + (selected.has(n.id) ? ' sel' : '') + (n.open ? ' open' : '');
  el.dataset.id = n.id;
  el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
  el.innerHTML = nodeHTML(n);
  return el;
}
function rebuild() {
  S.nodes = S.nodes.filter((n) => (n.type === 'recipe' ? G.recipes[n.recipe] : true));
  FX = {};
  ensureOutposts();
  nodesEl.replaceChildren(...S.nodes.filter(visible).map(buildNode));
  // The start card is only for a completely empty factory (collapsed or hidden outposts still count as content).
  $('#emptyCanvas').hidden = S.outposts.some(onCanvas);
  $('#emptyCanvas h2').textContent = S.outposts.length && !S.outposts.some(onCanvas) ? `Nothing on ${G.planets.find((p) => p.name === S.viewPlanet)?.label || 'this planet'} yet` : 'Start a factory';
  $('.hint').hidden = S.nodes.length > 0;
  refresh();
}
function rebuildNode(n) { FX = {}; const old = nodesEl.querySelector(`.node[data-id="${n.id}"]`); if (old) old.replaceWith(buildNode(n)); refresh(); }
function refresh() {
  R = solve();
  for (const n of S.nodes) {
    const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`);
    if (!el) continue;
    const nom = R.nom[n.id], eff = R.eff[n.id];
    el.classList.toggle('starved', n.type === 'recipe' && eff < 0.5);
    el.classList.toggle('partial', n.type === 'recipe' && eff >= 0.5 && eff < 0.999);
    if (n.type === 'recipe') {
      const f = fxc(n), r = G.recipes[n.recipe];
      el.classList.toggle('invalid', !condOK(r.conditions, planetOf(n)) || !condOK(f.M.conditions, planetOf(n)));
      el.querySelector('.hcount').textContent = `${+(+n.count || 0).toFixed(2)} ×`;
      const he = el.querySelector('.heff');
      he.textContent = eff < 0.999 ? ` · ${(eff * 100).toFixed(0)}%` : '';
      he.className = 'heff ' + (eff < 0.5 ? 'bad' : 'warn');
      const m = el.querySelector('.meter i');
      if (m) {
        m.style.width = eff * 100 + '%';
        m.style.background = eff >= 0.999 ? 'var(--ok)' : eff >= 0.5 ? 'var(--warn)' : 'var(--bad)';
        el.querySelector('.eff').textContent = (eff * 100).toFixed(eff >= 0.999 ? 0 : 1) + '% busy';
        el.querySelector('.ceil').textContent = `${Math.ceil((+n.count || 0) - 1e-6)} bldg · ${f.M.burner ? 'fuel ' : ''}${fmtW(f.power * (+n.count || 0) * eff)}`;
        const parts = [`×${+f.speed.toFixed(2)} speed`];
        if (f.prod > 0) parts.push(`+${+(f.prod * 100).toFixed(1)}% prod`);
        if (f.quality > 0) parts.push(`${+(f.quality * 100).toFixed(1)}% qual`);
        el.querySelector('.fxs').textContent = parts.join(' · ');
      }
    }
    if (n.type === 'splitter') {
      el.querySelectorAll('[data-e]').forEach((v) => {
        if (!v.classList.contains('pv')) return;
        const e = S.edges.find((x) => x.id === +v.dataset.e), c = e && node(e.to);
        const f = (e && R.flow[e.id]) || 0;
        const want = c && c.type === 'recipe' ? (R.nom[c.id].ins[e.item] || 0) / Math.max(1, S.edges.filter((x) => x.to === c.id && x.item === e.item).length) : null;
        v.textContent = fmt(f) + (want != null && f < want * 0.999 - 1e-9 ? ` / ${fmt(want)}` : '');
        v.className = 'pv' + (want != null && f < want * 0.999 - 1e-9 ? ' bad' : '');
      });
    }
    el.querySelectorAll('.row.in .port').forEach((pt) => pt.classList.toggle('assumed', !!R.assumed?.[n.id]?.[pt.dataset.item]));
    el.querySelectorAll('[data-v]').forEach((v) => {
      const i = v.dataset.v.indexOf(':'), dir = v.dataset.v.slice(0, i), it = v.dataset.v.slice(i + 1);
      if (dir === 'in') {
        const g = R.got[n.id][it] || 0, need = nom.ins[it];
        if (n.type === 'sink') { v.textContent = fmt(g); v.className = 'val'; }
        else if (n.type === 'recipe' && !(need > 1e-12) && G.recipes[n.recipe].out.some((o) => o.n === it) && !S.edges.some((e) => e.to === n.id && e.item === it)) { v.textContent = '↻ own'; v.className = 'val assumed'; v.title = 'Fed from its own output inside the machine group. Connect a priority splitter to wire the loop explicitly.'; }
        else if (R.assumed?.[n.id]?.[it]) { v.textContent = fmt(need); v.className = 'val assumed'; v.title = `Not connected: assumed to arrive from outside (${fmt(need)}${us()})`; }
        else if (g < need * 0.999 - 1e-9) { v.textContent = `${fmt(g)}/${fmt(need)}`; v.className = 'val bad'; v.title = `Receiving ${fmt(g)} of ${fmt(need)}${us()}`; }
        else { v.textContent = fmt(need); v.className = 'val'; v.title = ''; }
      } else {
        const prod = (nom.outs[it] || 0) * eff, sp = Math.max(0, R.left[n.id][it] || 0);
        v.innerHTML = fmt(prod) + (sp > Math.max(1e-6, prod * 0.001) ? `<small title="Not used by anything">+${fmt(sp)} spare</small>` : '');
        v.className = 'val';
      }
    });
  }
  syncInputs();
  requestAnimationFrame(drawEdges);
  renderSide();
  renderOutposts();
}

function toWorld(cx, cy) { const r = canvas.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; }
function portPos(nid, it, dir) {
  const p = nodesEl.querySelector(`.port[data-node="${nid}"][data-item="${CSS.escape(it)}"][data-dir="${dir}"]`);
  if (!p) {
    const n = node(nid), o = n && outpost(n.outpost);
    if (o && o.collapsed && !o.hidden && onCanvas(o)) { const r = frameRect(o); return r && { x: dir === 'out' ? r.x + r.w : r.x, y: r.y + r.h / 2 }; }
    return null;
  }
  const b = p.getBoundingClientRect();
  return toWorld(b.left + b.width / 2, b.top + b.height / 2);
}
const curve = (a, b) => { const dx = Math.max(50, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
function beltFor(rate) {
  const belts = G.belts;
  if (!belts.length) return null;
  for (const b of belts) if (rate <= b.rate + 1e-9) return { n: 1, b };
  const top = belts[belts.length - 1];
  return { n: Math.ceil(rate / top.rate - 1e-9), b: top };
}
// Point on the same curve the link is drawn with, t from 0 (start) to 1 (end).
function curveAt(a, b, t) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2), u = 1 - t;
  const c1 = { x: a.x + dx, y: a.y }, c2 = { x: b.x - dx, y: b.y };
  return { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
}
// Slide each rate label along its own link to the first spot that covers neither a node nor another label.
function placeLabels(geo) {
  const pad = 4, boxes = [];
  for (const n of S.nodes) {
    const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`);
    if (el) boxes.push({ x0: n.x - pad, y0: n.y - pad, x1: n.x + el.offsetWidth + pad, y1: n.y + el.offsetHeight + pad });
  }
  const hit = (r) => boxes.some((o) => r.x0 < o.x1 && o.x0 < r.x1 && r.y0 < o.y1 && o.y0 < r.y1);
  const ts = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86];
  const labels = labelsEl.children;
  geo.forEach((g, i) => {
    const el = labels[i];
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w) return;
    let best = null;
    // Along the link first; if it is crowded everywhere, also just above or below it.
    for (const dy of [0, -(h + 3), h + 3, -2 * (h + 3), 2 * (h + 3)]) {
      for (const t of ts) {
        const c = curveAt(g.a, g.b, t), p = { x: c.x, y: c.y + dy };
        const r = { x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2 };
        if (!hit(r)) { best = { p, r }; break; }
      }
      if (best) break;
    }
    if (!best) { const p = curveAt(g.a, g.b, 0.5); best = { p, r: { x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2 } }; }
    el.style.left = best.p.x + 'px'; el.style.top = best.p.y + 'px';
    boxes.push(best.r);
  });
}
function drawEdges() {
  let paths = '', labs = '';
  const geo = [];
  for (const e of S.edges) {
    const fo = node(e.from)?.outpost;
    if (fo != null && fo === node(e.to)?.outpost && outpost(fo)?.collapsed) continue;
    const a = portPos(e.from, e.item, 'out'), b = portPos(e.to, e.item, 'in');
    if (!a || !b) continue;
    const I = item(e.item), f = (R && R.flow[e.id]) || 0, c = node(e.to);
    let short = false;
    if (c && c.type === 'recipe' && R) { const need = R.nom[c.id].ins[e.item] || 0; short = (R.got[c.id][e.item] || 0) < need * 0.999 - 1e-9; }
    const col = I.type === 'fluid' ? '#5aa9e6' : '#c9a66b';
    const link = isLinkEdge(e);
    paths += `<path d="${curve(a, b)}" stroke="${short ? '#e2583e' : link ? '#b58cf0' : col}" class="${short ? 'short' : ''} ${link ? 'olink' : ''}" opacity="${link ? 0.95 : 0.8}"/>`;
    let belt = '';
    if (I.type !== 'fluid' && f > 1e-9) { const bf = beltFor(f); if (bf) belt = (bf.n > 1 ? bf.n + '×' : '') + ic(bf.b.icon, (bf.n > 1 ? bf.n + '× ' : '') + bf.b.label, 'xs'); }
    geo.push({ a, b });
    labs += `<div class="el ${short ? 'bad' : ''}" style="left:${(a.x + b.x) / 2}px;top:${(a.y + b.y) / 2}px" title="${esc(I.label)}">${belt}${fmt(f)}<button data-split="${e.id}" title="Insert a priority splitter here" aria-label="Insert priority splitter">⑂</button><button data-edge="${e.id}" aria-label="Remove connection" title="Remove connection">×</button></div>`;
  }
  if (drag && drag.kind === 'wire') paths += `<path d="${drag.dir === 'out' ? curve(drag.a, drag.b) : curve(drag.b, drag.a)}" stroke="#f2a22c" stroke-dasharray="4 4"/>`;
  svg.innerHTML = paths;
  labelsEl.innerHTML = labs;
  placeLabels(geo);
  drawFrames();
}
// A frame around each outpost's nodes, with its name, planet and outputs in the header.
const FRAME_PAD = 34, FRAME_HEAD = 58;
const TILE_W = 270, TILE_H = 86;
function frameRect(o, noPlace = false) {
  if (o.collapsed) {
    if (o.cx == null) { const ns = S.nodes.filter((n) => n.outpost === o.id); o.cx = ns.length ? Math.min(...ns.map((n) => n.x)) - FRAME_PAD : 0; o.cy = ns.length ? Math.min(...ns.map((n) => n.y)) - FRAME_HEAD : 0; }
    return { x: o.cx, y: o.cy, w: TILE_W, h: TILE_H, collapsed: true };
  }
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const n of S.nodes) {
    if (n.outpost !== o.id) continue;
    const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`);
    if (!el) continue;
    b.x0 = Math.min(b.x0, n.x); b.y0 = Math.min(b.y0, n.y); b.x1 = Math.max(b.x1, n.x + el.offsetWidth); b.y1 = Math.max(b.y1, n.y + el.offsetHeight);
  }
  if (b.x0 !== Infinity) return { x: b.x0 - FRAME_PAD, y: b.y0 - FRAME_HEAD, w: b.x1 - b.x0 + 2 * FRAME_PAD, h: b.y1 - b.y0 + FRAME_HEAD + FRAME_PAD };
  if (o.hidden || S.nodes.some((n) => n.outpost === o.id)) return null;
  // An empty outpost still gets a spot on the canvas: to the right of everything else, until it has machines.
  if (o.x == null) { if (noPlace) return null; placeEmptyOutpost(o); }
  return { x: o.x, y: o.y, w: EMPTY_W, h: EMPTY_H, empty: true };
}
const EMPTY_W = 640, EMPTY_H = 300;
// Place an empty outpost to the right of every other frame and tile (collapsed outposts included).
function placeEmptyOutpost(o) {
  let x1 = null, y0 = null;
  for (const q of S.outposts) {
    if (q === o || q.hidden || q.planet !== o.planet) continue;
    const r = frameRect(q, true);
    if (!r) continue;
    x1 = Math.max(x1 ?? -Infinity, r.x + r.w); y0 = Math.min(y0 ?? Infinity, r.y);
  }
  o.x = Math.round(x1 == null ? 0 : x1 + OUTPOST_GAP); o.y = Math.round(y0 ?? -FRAME_HEAD);
}
const rectsOverlap = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// An empty outpost that ended up on top of another frame moves out of the way.
function unstackEmptyOutposts() {
  for (const o of S.outposts || []) {
    if (o.hidden || o.collapsed || o.x == null || S.nodes.some((n) => n.outpost === o.id)) continue;
    const mine = { x: o.x, y: o.y, w: EMPTY_W, h: EMPTY_H };
    if (S.outposts.some((q) => q !== o && !q.hidden && q.planet === o.planet && rectsOverlap(mine, frameRect(q, true)))) placeEmptyOutpost(o);
  }
}
function outpostOutputs(o) {
  if (!R) return '';
  return S.nodes.filter((n) => n.outpost === o.id && n.type === 'sink').map((n) => `<span class="fo">${itemIc(n.item, 'xs')}${fmt(R.got[n.id]?.[n.item] || 0)}${us()}</span>`).join('');
}
function drawFrames() {
  const layer = $('#frames');
  if (!layer || !S.outposts) return;
  unstackEmptyOutposts();
  layer.innerHTML = S.outposts.filter((o) => !o.hidden && onCanvas(o)).map((o) => {
    const r = frameRect(o);
    if (!r) return '';
    const P = G.planets.find((x) => x.name === o.planet);
    const bad = R ? S.nodes.filter((n) => n.outpost === o.id && n.type === 'recipe' && R.eff[n.id] < 0.999).length : 0;
    if (r.collapsed) {
      const ns = S.nodes.filter((n) => n.outpost === o.id), sk = ns.find((n) => n.type === 'sink'), rn = ns.find((n) => n.type === 'recipe');
      const big = sk ? itemIc(sk.item, 'lg') : rn ? ic(G.recipes[rn.recipe]?.icon, G.recipes[rn.recipe]?.label || '', 'lg') : P ? ic(P.icon, P.label, 'lg') : '';
      return `<div class="frame tile ${o.id === S.active ? 'active' : ''} ${o.color ? 'tinted' : ''}" data-op="${o.id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;${o.color ? `--fc:${o.color}` : ''}"><div class="fh tileh" data-op="${o.id}" title="${esc(o.name)} · drag to move · double-click to expand">${big}<span class="tilet"><span class="fname">${P ? ic(P.icon, P.label, 'xs') : ''}${esc(o.name)}</span><span class="fouts">${outpostOutputs(o) || `<span class="note">${ns.filter((n) => n.type === 'recipe').length} machines</span>`}</span></span>${bad ? `<span class="fbad" title="${bad} machines short">!</span>` : ''}<button class="fold" data-fold="${o.id}" title="Expand" aria-label="Expand ${esc(o.name)}">⤢</button></div></div>`;
    }
    return `<div class="frame ${o.id === S.active ? 'active' : ''} ${r.empty ? 'empty' : ''} ${o.color ? 'tinted' : ''}" data-op="${o.id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;${o.color ? `--fc:${o.color}` : ''}">${r.empty ? `<div class="fempty">Empty outpost<br><span>Use <b>Plan production</b> or <b>Add node</b> (Space) to fill it.</span></div>` : ''}<div class="fh" data-op="${o.id}" title="Drag to move this outpost · double-click the name to rename"><span class="fhin">${P ? ic(P.icon, P.label, 'sm') : ''}<span class="fname">${esc(o.name)}</span><span class="fouts">${outpostOutputs(o)}</span>${bad ? `<span class="fbad">${bad} short</span>` : ''}${(() => { const sug = bestPlanetFor(o); return sug ? `<button class="fsug" data-sug="${o.id}" data-p="${sug.planet.name}" title="${sug.now} machines can't run on this planet">⚠ Switch to ${esc(sug.planet.label)}</button>` : ''; })()}${o.note ? `<span class="fnote" title="${esc(o.note)}">${esc(o.note)}</span>` : ''}</span>${r.empty ? '' : `<button class="fold" data-fold="${o.id}" title="Collapse to a small tile" aria-label="Collapse ${esc(o.name)}">–</button>`}</div></div>`;
  }).join('');
  stickFrameHeads();
}
// Keep each frame's name and outputs on the visible part of its header while panning across wide outposts.
function stickFrameHeads() {
  const left = -view.x / view.k, right = left + canvas.clientWidth / view.k;
  document.querySelectorAll('#frames .frame').forEach((f) => {
    const fx = parseFloat(f.style.left), fw = parseFloat(f.style.width), inner = f.querySelector('.fhin');
    if (!inner) return;
    const off = right < fx || left > fx + fw ? 0 : Math.max(0, Math.min(fw - inner.offsetWidth - 28, left - fx + 12));
    inner.style.transform = `translateX(${off}px)`;
  });
}
function toggleCollapse(id) {
  const o = outpost(id);
  if (!o) return;
  if (!o.collapsed) {
    const r = frameRect(o);
    if (r) { o.cx = r.x; o.cy = r.y; }
    o.collapsed = true;
    selected = new Set([...selected].filter((nid) => node(nid)?.outpost !== id));
  } else {
    // Open the outpost where its tile is.
    const ns = S.nodes.filter((n) => n.outpost === id);
    if (ns.length && o.cx != null) {
      const dx = o.cx - (Math.min(...ns.map((n) => n.x)) - FRAME_PAD), dy = o.cy - (Math.min(...ns.map((n) => n.y)) - FRAME_HEAD);
      ns.forEach((n) => { n.x += dx; n.y += dy; });
    }
    o.collapsed = false;
  }
  rebuild(); maybeArrange(); drawEdges(); commit();
}
function focusOutpost(id) {
  const o = outpost(id);
  if (!o) return;
  if (o.hidden) { o.hidden = false; rebuild(); }
  const r = frameRect(o), c = canvas.getBoundingClientRect();
  if (r && r.collapsed) { view = { k: Math.max(view.k, 0.8), x: 0, y: 0 }; view.x = c.width / 2 - (r.x + r.w / 2) * view.k; view.y = c.height / 2 - (r.y + r.h / 2) * view.k; applyView(); drawEdges(); autosave(); return; }
  if (!r) return;
  const k = Math.min(1, Math.max(0.6, Math.min((c.width - 80) / r.w, (c.height - 80) / r.h)));
  view = { k, x: c.width / 2 - (r.x + r.w / 2) * k, y: r.h * k < c.height - 60 ? c.height / 2 - (r.y + r.h / 2) * k : 30 - r.y * k };
  applyView(); drawEdges(); autosave();
}

/* ---------- Links between outposts ----------
   An outpost's input can come "from outside" (an Import/Resource node, or simply unconnected) or from another outpost.
   Linking connects the supplying outpost's producing machines straight to the consumers, so Auto-balance sizes the
   supplier for both its own outputs and what it sends on. */
const isLinkEdge = (e) => { const a = node(e.from), b = node(e.to); return a && b && a.outpost !== b.outpost; };
// Items an outpost needs from somewhere: what its Import/Resource nodes supply, unconnected inputs, and current links.
function outpostInputs(o) {
  const ns = S.nodes.filter((n) => n.outpost === o.id), items = new Set();
  ns.forEach((n) => { if (n.type === 'source') items.add(n.item); });
  for (const n of ns) {
    if (n.type !== 'recipe') continue;
    const ins = nominal(n).ins;
    for (const k in ins) if (ins[k] > 1e-12 && !S.edges.some((e) => e.to === n.id && e.item === k)) items.add(k);
  }
  S.edges.forEach((e) => { if (isLinkEdge(e) && node(e.to).outpost === o.id) items.add(e.item); });
  return [...items];
}
// Which outpost currently supplies an item to this one (null = outside).
function linkedFrom(o, it) {
  const e = S.edges.find((x) => x.item === it && isLinkEdge(x) && node(x.to).outpost === o.id);
  return e ? node(e.from).outpost : null;
}
// Outposts that make an item.
function makersOf(it, exceptId) {
  return S.outposts.filter((o) => o.id !== exceptId && S.nodes.some((n) => n.outpost === o.id && n.type === 'recipe' && (nominal(n).outs[it] > 1e-12 || G.recipes[n.recipe]?.out.some((x) => x.n === it))));
}
function linkSupply(toId, it, fromId, quiet = false) {
  const to = outpost(toId);
  const mine = (n) => n.outpost === toId;
  // Consumers in the receiving outpost: whatever its supply nodes fed, plus inputs that were left unconnected.
  const consumers = new Set();
  const oldSources = S.nodes.filter((n) => mine(n) && n.type === 'source' && n.item === it);
  S.edges.forEach((e) => { if (oldSources.some((sn) => sn.id === e.from)) consumers.add(e.to); });
  S.nodes.forEach((n) => { if (mine(n) && n.type === 'recipe' && nominal(n).ins[it] > 1e-12 && !S.edges.some((e) => e.to === n.id && e.item === it)) consumers.add(n.id); });
  S.edges.forEach((e) => { if (e.item === it && isLinkEdge(e) && mine(node(e.to))) consumers.add(e.to); });
  // A supplier that was sending to this outpost shrinks by that share again (it no longer has to make it).
  const sent = new Map();
  S.edges.forEach((e) => { if (e.item === it && isLinkEdge(e) && mine(node(e.to))) sent.set(e.from, (sent.get(e.from) || 0) + ((R && R.flow[e.id]) || 0)); });
  // Drop the old supply: import nodes and earlier links.
  const gone = new Set(oldSources.map((n) => n.id));
  S.nodes = S.nodes.filter((n) => !gone.has(n.id));
  S.edges = S.edges.filter((e) => !gone.has(e.from) && !(e.item === it && isLinkEdge(e) && mine(node(e.to))));
  if (fromId == null) {
    // Back to outside: one Import node (Auto) feeding the consumers.
    if (consumers.size) {
      const first = node([...consumers][0]);
      const src = addNode({ type: 'source', item: it, outpost: toId, x: first.x - 300, y: first.y });
      consumers.forEach((c) => connect(src.id, c, it));
    }
  } else {
    // Producers in the supplying outpost: what feeds its Output for this item, else every machine making it.
    const fromNodes = S.nodes.filter((n) => n.outpost === fromId);
    const sinks = fromNodes.filter((n) => n.type === 'sink' && n.item === it).map((n) => n.id);
    let providers = [...new Set(S.edges.filter((e) => sinks.includes(e.to) && e.item === it).map((e) => e.from))];
    if (!providers.length) providers = fromNodes.filter((n) => n.type === 'recipe' && nominal(n).outs[it] > 1e-12).map((n) => n.id);
    consumers.forEach((c) => providers.forEach((pid) => connect(pid, c, it)));
  }
  for (const [pid, f] of sent) {
    const pn = node(pid);
    if (!pn || pn.type !== 'recipe' || pn.pin || S.edges.some((e) => e.from === pid && e.item === it && node(e.to)?.type !== 'sink')) continue;
    const made = nominal(pn).outs[it] || 0;
    if (made > 1e-12) pn.count = Math.max(0, (+pn.count || 0) * (made - f) / made);
  }
  if (quiet) return;
  autoBalance(); rebuild(); maybeArrange(); commit();
  toast(fromId == null ? `${item(it).label} for ${to.name} now comes from outside` : `${outpost(fromId).name} now supplies ${item(it).label} to ${to.name}`);
}

/* ---------- Recalculating outposts when buildings or planets change ----------
   An outpost with Output nodes is planned again for the same products and rates (keeping its recipe choices, modules,
   leftover settings and links). Otherwise each machine that is locked or can't work on the planet is swapped for the
   best allowed building at the same output, or for another recipe for the same product. */
function outpostGoals(o) {
  if (o.plan?.items?.length) return o.plan.items.filter((t) => G.items[t.item] && +t.rate > 0);
  if (!R) R = solve();
  return S.nodes.filter((n) => n.outpost === o.id && n.type === 'sink')
    .filter((sk) => !S.edges.some((e) => e.to === sk.id && node(e.from)?.absorb))
    .map((sk) => ({ item: sk.item, rate: R.got[sk.id]?.[sk.item] || 0 })).filter((t) => t.rate > 1e-9);
}
function replanOutpost(id) {
  const o = outpost(id), goal = outpostGoals(o);
  if (!goal.length) return false;
  const inLinks = outpostInputs(o).map((it) => ({ it, from: linkedFrom(o, it) })).filter((x) => x.from != null);
  const outLinks = [...new Set(S.edges.filter((e) => isLinkEdge(e) && node(e.from).outpost === id).map((e) => node(e.to).outpost + '|' + e.item))].map((k) => { const [to, it] = k.split('|'); return { to: +to, it }; });
  const gone = new Set(S.nodes.filter((n) => n.outpost === id).map((n) => n.id));
  S.nodes = S.nodes.filter((n) => !gone.has(n.id));
  S.edges = S.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  const pl = o.plan || {};
  const keep = { active: S.active, planet: S.planet, hoff: S.helpersOff, uses: S.leftoverUse };
  S.active = id; S.planet = o.planet; localCache = {};
  planModsOverride = pl.mods === undefined ? null : pl.mods || { mod: '', bc: 0 };
  S.helpersOff = pl.helpersOff || keep.hoff; S.leftoverUse = pl.uses || keep.uses;
  try { buildChain(goal, null, pl.prefs || S.prefs || {}); }
  finally { S.active = keep.active; S.planet = keep.planet; S.helpersOff = keep.hoff; S.leftoverUse = keep.uses; planModsOverride = null; localCache = {}; }
  for (const l of inLinks) if (outpost(l.from)) linkSupply(id, l.it, l.from, true);
  for (const l of outLinks) if (outpost(l.to)) linkSupply(l.to, l.it, id, true);
  return true;
}
function refitMachines(id) {
  const o = outpost(id), keep = { active: S.active, planet: S.planet };
  let changed = 0;
  S.active = id; S.planet = o.planet; localCache = {}; FX = {};
  try {
    for (const n of S.nodes.filter((x) => x.outpost === id && x.type === 'recipe')) {
      const r = G.recipes[n.recipe];
      if (!r) continue;
      const M = G.machines[n.machine];
      const fits = M && M.categories.includes(r.category) && !settings.disabled.includes(M.name) && condOK(M.conditions);
      const recipeHere = condOK(r.conditions) && minedHere(r);
      if (fits && recipeHere) continue;
      if (recipeHere && machinesFor(r).length) {
        const before = outPerMachine(n);
        n.machine = bestMachine(r).name; n.modN = undefined; FX = {};
        const Mn = G.machines[n.machine];
        if (n.mod && !moduleFits(G.modules[n.mod] || { effect: {} }, Mn.allowed, r)) n.mod = undefined;
        if (n.bmod && G.beacon && !moduleFits(G.modules[n.bmod] || { effect: {} }, G.beacon.allowed, r)) n.bmod = undefined;
        const after = outPerMachine(n);
        if (before > 0 && after > 0) n.count = (+n.count || 0) * (before / after);
        changed++;
        continue;
      }
      const alt = (byOut[r.main] || []).filter((x) => x.name !== r.name && !x.aux && !x.hidden && !x.mining && recipeOK(x)).sort((a, b) => machineScore(bestMachine(b), b) - machineScore(bestMachine(a), a));
      if (alt.length) { swapRecipe(n, alt[0].name, bestMachine(alt[0]).name); changed++; }
    }
  } finally { S.active = keep.active; S.planet = keep.planet; localCache = {}; FX = {}; }
  return changed;
}
function recalcOutposts(ids, why) {
  ids = ids || S.outposts.map((o) => o.id);
  R = solve();
  const replanned = [], refit = [];
  for (const id of ids) {
    const o = outpost(id);
    if (!o || !S.nodes.some((n) => n.outpost === id)) continue;
    if (settings.recalcMode !== 'swap' && replanOutpost(id)) replanned.push(o.name);
    else if (refitMachines(id)) refit.push(o.name);
  }
  autoBalance(); rebuild(); maybeArrange(); commit();
  const parts = [];
  if (replanned.length) parts.push(`re-planned ${replanned.join(', ')}`);
  if (refit.length) parts.push(`updated buildings in ${refit.join(', ')}`);
  if (parts.length) toast(`${why}: ${parts.join('; ')}. Ctrl+Z to undo.`);
}
let recalcT;
const recalcSoon = (why) => { clearTimeout(recalcT); recalcT = setTimeout(() => recalcOutposts(null, why), 500); };
// The planet whose rules fit an outpost's machines best (used to suggest a switch when many are flagged).
function bestPlanetFor(o) {
  const ns = S.nodes.filter((n) => n.outpost === o.id && n.type === 'recipe');
  const bad = (P) => ns.filter((n) => { const r = G.recipes[n.recipe], M = G.machines[n.machine]; return r && (!condOK(r.conditions, P) || (M && !condOK(M.conditions, P)) || (r.mining && !(P.resources || []).includes(r.main))); }).length;
  const cur = G.planets.find((p) => p.name === o.planet);
  const now = cur ? bad(cur) : 0;
  if (!now) return null;
  let best = null, bestBad = now;
  for (const P of G.planets) { const b = bad(P); if (b < bestBad) { best = P; bestBad = b; } }
  return best && { planet: best, now, after: bestBad };
}
function switchOutpostPlanet(id, planetName) {
  const o = outpost(id);
  o.planet = planetName;
  o.x = undefined;
  switchCanvas(planetName, true);
  S.active = id;
  localCache = {}; syncToolbar();
  recalcOutposts([id], `${o.name} moved to ${G.planets.find((p) => p.name === planetName)?.label}`);
}

/* ---------- Outpost settings (right-click) ---------- */
const OUTPOST_COLOURS = [['', 'None'], ['#f2a22c', 'Amber'], ['#4a9fe0', 'Blue'], ['#6cbf5a', 'Green'], ['#e2583e', 'Red'], ['#a77bdb', 'Purple'], ['#3fbfb0', 'Teal'], ['#9a948c', 'Grey']];
function closeCtx() { const c = $('#ctx'); if (c) c.remove(); }
function outpostStats(o) {
  const ns = S.nodes.filter((n) => n.outpost === o.id);
  let bld = 0, w = 0;
  FX = {};
  for (const n of ns) if (n.type === 'recipe') { bld += Math.ceil((+n.count || 0) - 1e-6); const f = fx(n); if (!f.M.burner) w += f.power * (+n.count || 0) * (R ? R.eff[n.id] ?? 1 : 1); }
  const list = (type) => ns.filter((n) => n.type === type).map((n) => `<span class="fo">${itemIc(n.item, 'xs')}${fmt(type === 'sink' ? R?.got[n.id]?.[n.item] || 0 : +n.rate || 0)}${us()}</span>`).join('') || '<span class="note">none</span>';
  return `<div><b>${bld}</b> buildings · <b>${fmtW(w)}</b></div><div class="ctxrow"><span class="lbl">Makes</span>${list('sink')}</div><div class="ctxrow"><span class="lbl">Takes in</span>${list('source')}</div>`;
}
function openOutpostMenu(id, cx, cy) {
  const o = outpost(id);
  if (!o) return;
  closeCtx();
  if (S.active !== id) setActive(id);
  const el = document.createElement('div');
  el.id = 'ctx'; el.className = 'ctx'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Outpost settings');
  el.innerHTML = `
    <div class="ctxsec"><label class="lbl" for="ctxName">Name</label><input id="ctxName" value="${esc(o.name)}" spellcheck="false"></div>
    <div class="ctxsec"><span class="lbl">Planet</span><div class="planets all" id="ctxPlanet">${G.planets.map((p) => `<button data-p="${p.name}" aria-pressed="${p.name === o.planet}" title="${esc(p.label)}">${ic(p.icon, p.label, 'sm')}<span class="lbltxt">${esc(p.label)}</span></button>`).join('')}</div></div>
    <div class="ctxsec"><span class="lbl">Colour</span><div class="swatches" id="ctxCol">${OUTPOST_COLOURS.map(([c, l]) => `<button data-c="${c}" title="${l}" aria-label="${l}" aria-pressed="${(o.color || '') === c}" style="--sw:${c || 'transparent'}"></button>`).join('')}</div></div>
    <div class="ctxsec"><label class="lbl" for="ctxNote">Note</label><textarea id="ctxNote" rows="2" placeholder="e.g. north of the main bus, needs 2 more substations">${esc(o.note || '')}</textarea></div>
    ${(() => { const sug = bestPlanetFor(o); return sug ? `<div class="ctxsec ctxwarn">${sug.now} machine${sug.now > 1 ? 's' : ''} can't run on ${esc(G.planets.find((p) => p.name === o.planet)?.label || o.planet)}. <button class="btn" data-a="planet" data-p="${sug.planet.name}">Switch to ${esc(sug.planet.label)}</button></div>` : ''; })()}
    <div class="ctxsec ctxstats">${outpostStats(o)}</div>
    ${(() => {
      const ins = outpostInputs(o);
      if (!ins.length) return '';
      return `<div class="ctxsec"><span class="lbl">Supplies</span><div class="supplies">${ins.map((it) => {
        const cur = linkedFrom(o, it), makers = makersOf(it, o.id);
        return `<div class="suprow">${itemIc(it, 'sm')}<span class="supname">${esc(item(it).label)}</span><select data-link="${esc(it)}" aria-label="Where ${esc(item(it).label)} comes from"><option value="">from outside</option>${makers.map((m) => `<option value="${m.id}" ${cur === m.id ? 'selected' : ''}>from ${esc(m.name)}</option>`).join('')}</select></div>`;
      }).join('')}</div><div class="note">Pick another outpost to have it supply this one. It grows to cover both.</div></div>`;
    })()}
    <div class="ctxacts">
      <button class="btn primary" data-a="plan">Plan production here…</button>
      <button class="btn" data-a="select">Select all</button>
      <button class="btn" data-a="arrange">Arrange</button>
      <button class="btn" data-a="dup">Duplicate</button>
      <button class="btn" data-a="replan" title="Plan this outpost again for the same products with the buildings you have now">Re-plan</button>
      <button class="btn" data-a="fold">${o.collapsed ? 'Expand' : 'Collapse'}</button>
      <button class="btn" data-a="hide">${o.hidden ? 'Show' : 'Hide'}</button>
      <button class="btn danger" data-a="del">Delete</button>
    </div>`;
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(cx, innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(cy, innerHeight - r.height - 8)) + 'px';
  $('#ctxName').focus(); $('#ctxName').select();
  $('#ctxName').addEventListener('input', (e) => { o.name = e.target.value.trim() || o.name; renderOutposts(); drawFrames(); });
  $('#ctxName').addEventListener('change', commit);
  $('#ctxName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); closeCtx(); } });
  $('#ctxNote').addEventListener('input', (e) => { o.note = e.target.value.trim(); drawFrames(); });
  $('#ctxNote').addEventListener('change', commit);
  $('#ctxPlanet').onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    $('#ctxPlanet').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    switchOutpostPlanet(o.id, b.dataset.p);
  };
  el.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-link]');
    if (!sel) return;
    const it = sel.dataset.link;
    closeCtx();
    linkSupply(o.id, it, sel.value ? +sel.value : null);
  });
  $('#ctxCol').onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    o.color = b.dataset.c || undefined;
    $('#ctxCol').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    renderOutposts(); drawFrames(); commit();
  };
  el.querySelector('.ctxacts').onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'plan') { closeCtx(); openPlan(o.id); }
    if (a === 'select') { selected = new Set(S.nodes.filter((n) => n.outpost === o.id && visible(n)).map((n) => n.id)); markSel(); closeCtx(); toast(`Selected ${selected.size} nodes. Drag one to move them, Delete removes them.`); }
    if (a === 'arrange') { closeCtx(); arrange(); commit(); focusOutpost(o.id); }
    if (a === 'dup') { closeCtx(); duplicateOutpost(o.id); }
    if (a === 'fold') { closeCtx(); toggleCollapse(o.id); }
    if (a === 'replan') { closeCtx(); R = solve(); if (replanOutpost(o.id)) { autoBalance(); rebuild(); maybeArrange(); commit(); toast(`Re-planned ${o.name}. Ctrl+Z to undo.`); } else toast('This outpost has no Output node, so there is nothing to plan it for.'); }
    if (a === 'planet') { closeCtx(); switchOutpostPlanet(o.id, e.target.closest('[data-a]').dataset.p); }
    if (a === 'hide') { o.hidden = !o.hidden; if (o.hidden) selected.clear(); closeCtx(); rebuild(); commit(); }
    if (a === 'del') {
      const b = e.target.closest('[data-a]');
      if (S.outposts.length === 1) { toast('Keep at least one outpost. Delete its nodes instead.'); return; }
      if (!b.classList.contains('arm')) { b.classList.add('arm'); b.textContent = 'Click again to delete'; return; }
      closeCtx(); deleteOutpost(o.id);
    }
  };
}
document.addEventListener('pointerdown', (e) => { const c = $('#ctx'); if (c && !c.contains(e.target)) closeCtx(); }, true);
function deleteOutpost(id) {
  const o = outpost(id), gone = new Set(S.nodes.filter((n) => n.outpost === id).map((n) => n.id));
  S.nodes = S.nodes.filter((n) => !gone.has(n.id));
  S.edges = S.edges.filter((x) => !gone.has(x.from) && !gone.has(x.to));
  S.outposts = S.outposts.filter((x) => x.id !== id);
  if (S.active === id) S.active = S.outposts[0].id;
  autoBalance(); setActive(S.active); rebuild(); commit();
  toast(`Deleted ${o.name}. Ctrl+Z to undo.`);
}
function duplicateOutpost(id) {
  const o = outpost(id);
  const copy = newOutpost(o.name + ' copy', o.planet);
  if (o.color) copy.color = o.color;
  if (o.note) copy.note = o.note;
  const nodeMap = new Map(), edgeMap = new Map();
  for (const n of S.nodes.filter((x) => x.outpost === id)) {
    const c = { ...JSON.parse(JSON.stringify(n)), id: S.next++, outpost: copy.id };
    nodeMap.set(n.id, c.id);
    S.nodes.push(c);
  }
  for (const e of S.edges.filter((x) => nodeMap.has(x.from) && nodeMap.has(x.to))) {
    const ne = { ...e, id: S.next++, from: nodeMap.get(e.from), to: nodeMap.get(e.to) };
    edgeMap.set(e.id, ne.id);
    S.edges.push(ne);
  }
  for (const n of S.nodes) if (n.outpost === copy.id && n.type === 'splitter') n.prio = (n.prio || []).map((x) => edgeMap.get(x)).filter(Boolean);
  setActive(copy.id); rebuild(); arrange(); commit(); focusOutpost(copy.id);
  toast(`Duplicated as ${copy.name}`);
}

/* ---------- Outposts panel ---------- */
function renderOutposts() {
  const list = $('#oplist');
  if (!list || !S.outposts) return;
  const here = S.outposts.filter(onCanvas);
  const P0 = G.planets.find((x) => x.name === S.viewPlanet);
  $('#ophead-title').textContent = `Outposts on ${P0 ? P0.label : ''}`;
  const others = G.planets.filter((p) => p.name !== S.viewPlanet).map((p) => [p, S.outposts.filter((o) => o.planet === p.name).length]).filter(([, k]) => k);
  $('#opothers').innerHTML = others.length ? `<span class="lbl">Other planets</span>${others.map(([p, k]) => `<button class="opplanet" data-goto-planet="${p.name}">${ic(p.icon, p.label, 'xs')}${esc(p.label)} <b>${k}</b></button>`).join('')}` : '';
  list.innerHTML = (here.length ? '' : `<div class="empty">No outposts here yet. Use <b>Plan production</b> or <b>+ New</b>.</div>`) + here.map((o) => {
    const P = G.planets.find((x) => x.name === o.planet);
    const ns = S.nodes.filter((n) => n.outpost === o.id);
    const bad = R ? ns.filter((n) => n.type === 'recipe' && R.eff[n.id] < 0.999).length : 0;
    return `<div class="op ${o.id === S.active ? 'active' : ''} ${o.hidden ? 'off' : ''}" data-op="${o.id}">
      <span class="opdot" style="background:${o.color || 'transparent'}"></span>${P ? ic(P.icon, P.label, 'sm') : ''}<div class="opt"><span class="opname" title="Double-click to rename">${esc(o.name)}</span><span class="opmeta">${ns.filter((n) => n.type === 'recipe').length} machines${o.collapsed ? ' · collapsed' : ''}${bad ? ` · <b class="bad">${bad} short</b>` : ''}</span><span class="opouts">${outpostOutputs(o)}</span>${(() => { const ls = [...new Set(S.edges.filter((e) => isLinkEdge(e) && node(e.to).outpost === o.id).map((e) => e.item + '|' + node(e.from).outpost))]; return ls.length ? `<span class="oplinks">${ls.map((k) => { const [it, from] = k.split('|'); const fo = outpost(+from); const far = fo && fo.planet !== o.planet ? ` (${esc(G.planets.find((p) => p.name === fo.planet)?.label || fo.planet)})` : ''; return `<span>${itemIc(it, 'xs')} ← ${esc(fo?.name || '')}${far}</span>`; }).join('')}</span>` : ''; })()}</div>
      <button class="opb" data-opact="hide" title="${o.hidden ? 'Show on canvas' : 'Hide from canvas'}" aria-label="${o.hidden ? 'Show' : 'Hide'} ${esc(o.name)}">${o.hidden ? '◌' : '◉'}</button>
      <button class="opb" data-opact="del" title="Delete outpost" aria-label="Delete ${esc(o.name)}">×</button></div>`;
  }).join('');
}
function newOutpost(name, planetName) {
  const o = { id: S.next++, name: name || 'Outpost ' + (S.outposts.length + 1), planet: planetName || S.planet };
  S.outposts.push(o);
  return o;
}
function renameOutpost(id, el) {
  const o = outpost(id);
  if (!o || !el) return;
  const inp = document.createElement('input');
  inp.className = 'oprename'; inp.value = o.name; inp.setAttribute('aria-label', 'Outpost name');
  el.replaceWith(inp); inp.focus(); inp.select();
  const done = (ok) => { if (ok && inp.value.trim()) { o.name = inp.value.trim(); commit(); } renderOutposts(); drawFrames(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  inp.addEventListener('blur', () => done(true));
}
function applyView() {
  canvas.classList.toggle('far', view.k < 0.55);
  requestAnimationFrame(() => typeof stickFrameHeads === 'function' && stickFrameHeads());
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
  canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  canvas.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`;
}

/* ---------- Summary ---------- */
function renderSide() {
  const side = $('#side');
  if (side.hidden || !R) return;
  const scope = S.nodes.filter((n) => n.outpost === S.active);
  const inScope = new Set(scope.map((n) => n.id));
  const src = {}, snk = {}, mach = {}, issues = [], spare = {};
  let power = 0, fuel = 0;
  const assumedTot = {};
  for (const id in R.assumed || {}) if (inScope.has(+id)) for (const k in R.assumed[id]) assumedTot[k] = (assumedTot[k] || 0) + R.assumed[id][k] * (R.eff[id] ?? 1);
  for (const n of scope) {
    if (n.type === 'source') { const s = (src[n.item] = src[n.item] || { s: 0, d: 0 }); s.s += +n.rate || 0; s.d += portDemand(n.id, n.item); }
    if (n.type === 'sink') snk[n.item] = (snk[n.item] || 0) + (R.got[n.id][n.item] || 0);
    if (n.type === 'recipe') {
      const f = fxc(n), M = f.M;
      mach[M.name] = (mach[M.name] || 0) + Math.ceil((+n.count || 0) - 1e-6);
      const w = f.power * (+n.count || 0) * R.eff[n.id];
      if (M.burner) fuel += w; else power += w;
      if (R.eff[n.id] < 0.999) issues.push(n);
      for (const k in R.left[n.id] || {}) { const v = R.left[n.id][k]; if (v > 1e-6) spare[k] = (spare[k] || 0) + v; }
    }
  }
  const line = (it, v, cls = '') => `<div class="sl ${cls}">${itemIc(it, 'sm')}<span class="nm">${esc(item(it).label)}</span><span class="v">${v}</span></div>`;
  let h = `<section><h3>Outputs</h3>${Object.keys(snk).length ? Object.entries(snk).map(([k, v]) => line(k, fmt(v) + us())).join('') : '<div class="empty">Add an Output node to track what leaves the factory.</div>'}</section>`;
  h += `<section><h3>Inputs</h3>${Object.keys(src).length ? Object.entries(src).map(([k, v]) => line(k, `${fmt(v.d)} / ${fmt(v.s)}`, v.d > v.s * 1.001 + 1e-9 ? 'bad' : '')).join('') + `<div class="note" style="margin-top:4px">used / supplied ${us()}</div>` : '<div class="empty">No resource nodes yet.</div>'}</section>`;
  if (Object.keys(assumedTot).length) h += `<section><h3>Assumed inputs</h3>${Object.entries(assumedTot).map(([k, v]) => line(k, fmt(v) + us(), 'assumed')).join('')}<div class="note" style="margin-top:4px">Not connected to anything; counted as if they arrive from outside.</div></section>`;
  h += `<section><h3>Power</h3><div class="sl"><span class="nm">Electric</span><span class="v">${fmtW(power)}</span></div>${fuel > 0 ? `<div class="sl"><span class="nm">Burner fuel</span><span class="v">${fmtW(fuel)}</span></div>` : ''}<div class="note" style="margin-top:4px">Machines only, at current load.</div></section>`;
  h += `<section><h3>Buildings</h3>${Object.keys(mach).length ? Object.entries(mach).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="sl">${ic(G.machines[k].icon, G.machines[k].label, 'sm')}<span class="nm">${esc(G.machines[k].label)}</span><span class="v">${v}</span></div>`).join('') : '<div class="empty">None</div>'}</section>`;
  h += `<section><h3>Bottlenecks</h3>${issues.length ? issues.map((n) => `<div class="sl ${R.eff[n.id] < 0.5 ? 'bad' : 'warn'}">${ic(G.recipes[n.recipe].icon, '', 'sm')}<button data-goto="${n.id}">${esc(G.recipes[n.recipe].label)}</button><span class="v">${(R.eff[n.id] * 100).toFixed(1)}%</span></div>`).join('') : '<div class="empty">Every machine is fully supplied.</div>'}</section>`;
  h += `<section><h3>Unused output</h3>${Object.keys(spare).length ? Object.entries(spare).map(([k, v]) => line(k, '+' + fmt(v) + us(), 'warn')).join('') : '<div class="empty">Nothing piling up.</div>'}</section>`;
  side.innerHTML = `<div class="sidehead">${esc(outpost(S.active)?.name || 'No outpost selected')}</div>` + h;
}

/* ---------- Planner ---------- */
let byOut = {};
function indexRecipes() {
  byOut = {};
  for (const r of Object.values(G.recipes)) for (const o of r.out) (byOut[o.n] = byOut[o.n] || []).push(r);
}
// An output fully ignored by productivity is something the recipe hands back (coolant, catalyst), not real production.
const returnsOnly = (r, it) => r.out.every((o) => o.n !== it || (o.ig > 0 && o.ig >= o.a - 1e-9));
const candidates = (it) => (byOut[it] || []).filter((r) => !r.aux && (!r.hidden || r.mining) && recipeOK(r) && !returnsOnly(r, it));

// Items that can be produced on the current planet from what's mined or pumped there, found by repeatedly applying every usable recipe.
let localCache = {};
// A recipe can run if every input is available, allowing inputs it also produces (pentapod eggs) as long as something else feeds it.
function selfFeasible(r, ok) {
  let fed = false;
  for (const i of r.in) {
    if (ok.has(i.n)) fed = true;
    else if (!r.out.some((o) => o.n === i.n)) return false;
  }
  return fed || !r.in.length;
}
// withImports: also count every solid intermediate as available (it can be shipped in), to see which fluids are makeable here.
function localItems(withImports = false) {
  const key = S.planet + '|' + settings.disabled.join(',') + (withImports ? '|imp' : '');
  if (localCache[key]) return localCache[key];
  const ok = new Set(planet().resources || []);
  if (withImports) for (const I of Object.values(G.items)) if (I.type !== 'fluid' && !I.resource) ok.add(I.name);
  const grow = (recipes) => {
    for (let grew = true; grew;) {
      grew = false;
      for (const r of recipes) {
        if (!selfFeasible(r, ok)) continue;
        for (const o of r.out) if (!ok.has(o.n)) { ok.add(o.n); grew = true; }
      }
    }
  };
  grow(Object.values(G.recipes).filter((r) => !r.mining && !r.hidden && recipeOK(r)));
  // Fulgora: items salvaged from scrap can be recycled further, which is how plates are obtained there.
  const salvaged = new Set(Object.values(G.recipes).filter((r) => r.category.startsWith('recycling') && !r.hidden && recipeOK(r) && selfFeasible(r, ok)).flatMap((r) => r.out.map((o) => o.n)));
  const recycle = Object.values(G.recipes).filter((r) => r.recycling && recipeOK(r) && r.in.every((i) => salvaged.has(i.n)));
  if (recycle.length) { recycle.forEach((r) => r.out.forEach((o) => ok.add(o.n))); grow(Object.values(G.recipes).filter((r) => !r.mining && !r.hidden && recipeOK(r))); }
  return (localCache[key] = ok);
}
function defaultChoice(it, prefs, banned = new Set(), isTarget = false) {
  const p = prefs[it];
  if (p === 'raw') return 'raw';
  if (p && G.recipes[p] && recipeOK(G.recipes[p]) && !banned.has(p)) return p;
  if ((planet().resources || []).includes(it)) return 'raw';
  const local = localItems();
  const c = candidates(it).filter((r) => !r.mining && !banned.has(r.name));
  const feasible = (r) => selfFeasible(r, local);
  const rank = (r) => (feasible(r) ? 0 : 100) + (r.name === it ? 0 : 10) + (r.main === it ? 0 : 5) + r.out.length + r.in.length * 0.1;
  const best = c.sort((a, b) => rank(a) - rank(b))[0];
  // Nothing on this planet can make it: plan it as an import rather than a chain back to off-world resources.
  const offworld = (r) => r.in.some((i) => item(i.n).resource && !local.has(i.n));
  return best && (feasible(best) || isTarget || !offworld(best)) ? best.name : 'raw';
}
// Modules the planner fills into every building it places (Plan production > Modules). planModsOverride is the
// unsaved choice while the plan window is open.
let planModsOverride = null;
const planMods = () => planModsOverride || S.planMods || null;
function applyPlanMods(t) {
  const pm = planMods();
  if (!pm) return t;
  const M = G.machines[t.machine], r = G.recipes[t.recipe];
  if (!M || !r) return t;
  const m = G.modules[pm.mod];
  if (m && M.slots && moduleFits(m, M.allowed, r)) { t.mod = pm.mod; t.modq = pm.modq || 'normal'; t.modN = M.slots; }
  const bm = G.modules[pm.bmod];
  if (G.beacon && +pm.bc > 0 && bm && moduleFits(bm, G.beacon.allowed, r) && M.slots) { t.bc = +pm.bc; t.bmod = pm.bmod; t.bmodq = pm.bmodq || 'normal'; }
  return t;
}

// Cost of bringing an item in from another planet or another factory: deliberately higher than mining it here.
// Fluids can't be shipped between planets, so they are effectively never imported.
const importCost = (it) => (item(it).type === 'fluid' ? 1e4 : 50);

// Most-efficient planning: every recipe that works on this planet is a candidate (loops included), and the
// solver picks the mix that uses the least raw resources. Items the user set a recipe for use only that recipe.
// Products to plan: one item + rate, or a list [{ item, rate }] planned together so shared intermediates are sized once.
function normTargets(target, rate) {
  const T = (Array.isArray(target) ? target : [{ item: target, rate }]).filter((t) => t && t.item && +t.rate > 0);
  return { T, tset: new Set(T.map((t) => t.item)), trate: (it) => T.filter((t) => t.item === it).reduce((a, t) => a + +t.rate, 0) };
}
function planChainEfficient(target, rate, prefs, uses = {}) {
  const { tset, trate } = normTargets(target, rate);
  const local = new Set(planet().resources || []);
  const L = localItems(), LI = localItems(true);
  const candFor = (it) => {
    const p = prefs[it];
    if (p === 'raw') return [];
    if (p && G.recipes[p] && recipeOK(G.recipes[p])) return [G.recipes[p]];
    if (local.has(it) && !tset.has(it)) return [];
    // Usable here: everything it needs can be made locally, or what's missing is a solid intermediate that can be
    // shipped in (never a fluid, never another planet's raw resource).
    let c = candidates(it).filter((r) => !r.mining && (selfFeasible(r, L) || r.in.every((i) => LI.has(i.n) || L.has(i.n))));
    if (!c.length && tset.has(it)) c = candidates(it).filter((r) => !r.mining);
    return c;
  };
  const items = new Set(), recMap = new Map(), stack = [...tset], cands = {};
  while (stack.length) {
    const it = stack.pop();
    if (items.has(it)) continue;
    items.add(it);
    cands[it] = candFor(it);
    // An ingredient a recipe gives back at least as much of (coal liquefaction's heavy oil) doesn't need its own supply chain.
    for (const r of cands[it]) if (!recMap.has(r.name)) { recMap.set(r.name, r); r.in.forEach((i) => { const back = r.out.filter((o) => o.n === i.n).reduce((a, o) => a + o.a, 0); if (back < i.a) stack.push(i.n); }); }
  }
  const byp = new Set();
  recMap.forEach((r) => r.out.forEach((o) => byp.add(o.n)));
  // Recipes that turn leftovers into needed items stay available even where the user fixed a recipe
  // (e.g. cracking still feeds petroleum gas when advanced oil processing was picked).
  const wanted = new Set(items);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of Object.values(G.recipes)) {
      if (recMap.has(r.name) || r.aux || r.hidden || r.mining || !recipeOK(r)) continue;
      if (r.out.some((o) => tset.has(o.n) && prefs[o.n])) continue;
      if (!r.in.some((i) => byp.has(i.n)) || !r.out.some((o) => wanted.has(o.n) && !r.in.some((i) => i.n === o.n))) continue;
      if (!r.in.every((i) => items.has(i.n) || byp.has(i.n) || local.has(i.n))) continue;
      recMap.set(r.name, r); r.out.forEach((o) => byp.add(o.n)); r.in.forEach((i) => wanted.add(i.n)); grew = true;
    }
  }
  const usable = (it) => Object.values(G.recipes).filter((r) => !r.aux && !r.hidden && !r.mining && recipeOK(r)
    && r.in.some((i) => i.n === it) && !r.out.some((o) => o.n === it)
    && r.in.every((i) => i.n === it || items.has(i.n) || byp.has(i.n) || local.has(i.n))).sort(bySort);
  const useRecs = [];
  for (const [it, rn] of Object.entries(uses)) {
    if (tset.has(it)) continue;
    const r = usable(it).find((x) => x.name === rn);
    if (r) { useRecs.push({ it, r }); if (!recMap.has(r.name)) recMap.set(r.name, r); }
  }
  const recs = [...recMap.values()];
  const tmpl = {};
  const coef = recs.map((r) => {
    const t = (tmpl[r.name] = applyPlanMods({ id: -1, type: 'recipe', recipe: r.name, machine: bestMachine(r).name, count: 1, mq: 'normal' }));
    const f = fx(t), net = {}, gross = {};
    for (const i of r.in) net[i.n] = (net[i.n] || 0) - i.a;
    for (const o of r.out) { const a = o.a + Math.max(0, o.a - o.ig) * f.prod; net[o.n] = (net[o.n] || 0) + a; gross[o.n] = (gross[o.n] || 0) + a; }
    return { net, gross, machines: r.time / f.speed };
  });
  const all = new Set(items);
  coef.forEach((c) => Object.keys(c.net).forEach((k) => all.add(k)));
  const list = [...all], nr = recs.length;
  const rows = list.map((it, k) => ({ c: [...recs.map((r, j) => [j, coef[j].net[it] || 0]).filter((v) => v[1]), [nr + k, 1]], op: '>=', rhs: trate(it) }));
  for (const u of useRecs) rows.push({ c: recs.map((r, j) => [j, coef[j].net[u.it] || 0]).filter((v) => v[1]), op: '<=', rhs: 0 });
  // Use up leftovers: wasting an item that a recipe in the chain could consume (e.g. light oil -> cracking) is penalised,
  // so the solver prefers using it over buying more raw input. Waste variables come after the imports.
  const waste = [];
  if (settings.useLeftovers) list.forEach((it, k) => {
    if (!byp.has(it) || !coef.some((c) => (c.net[it] || 0) < 0)) return;
    const w = nr + list.length + waste.length;
    waste.push(item(it).type === 'fluid' ? 50 : 500);
    rows.push({ c: [...recs.map((r, j) => [j, coef[j].net[it] || 0]).filter((v) => v[1]), [nr + k, 1], [w, -1]], op: '<=', rhs: trate(it) });
  });
  // Mined/pumped here: real resource cost. Nothing on this planet makes it: import. Otherwise importing is a last resort.
  // Solids this planet can't produce on its own may be shipped in; anything makeable here must be made here.
  const supply = (it) => (!items.has(it) ? (local.has(it) ? supplyCost(it) : 1e9) : local.has(it) && !cands[it].length ? supplyCost(it) : !cands[it].length || (!tset.has(it) && !L.has(it) && item(it).type !== 'fluid') ? importCost(it) : 1e9);
  const cost = [...coef.map((c) => 1e-3 * c.machines), ...list.map(supply), ...waste];
  const x = solveLP(nr + list.length + waste.length, rows, cost);
  if (!x) throw new Error('No balanced solution was found for this chain.');
  const crafts = {}, imports = {}, need = Object.fromEntries([...tset].map((t) => [t, trate(t)])), made = {};
  recs.forEach((r, j) => {
    if (x[j] <= 1e-10) return;
    crafts[r.name] = x[j];
    for (const i of r.in) need[i.n] = (need[i.n] || 0) + i.a * x[j];
    for (const o in coef[j].gross) (made[o] = made[o] || {})[r.name] = coef[j].gross[o] * x[j];
  });
  list.forEach((it, k) => { if (x[nr + k] > 1e-10) imports[it] = x[nr + k]; });
  // The recipe shown for an item: the user's pick, otherwise whichever recipe makes most of it.
  const primary = {};
  for (const it in made) primary[it] = Object.entries(made[it]).sort((a, b) => b[1] - a[1])[0][0];
  const choice = (it) => (prefs[it] && prefs[it] !== '' ? prefs[it] : primary[it] || 'raw');
  const fromByp = {};
  for (const it in made) for (const [rn, v] of Object.entries(made[it])) if (rn !== choice(it)) fromByp[it] = (fromByp[it] || 0) + v;
  const surplus = {};
  list.forEach((it) => {
    const m = Object.values(made[it] || {}).reduce((a, b) => a + b, 0);
    const extra = m + (imports[it] || 0) - (need[it] || 0);
    if (extra > 1e-6 * Math.max(1, m)) surplus[it] = extra;
  });
  // Order rows from the product back to raw resources.
  const depth = Object.fromEntries([...tset].map((t) => [t, 0])), queue = [...tset];
  while (queue.length) {
    const it = queue.shift();
    for (const rn of Object.keys(made[it] || {})) for (const i of G.recipes[rn].in) if (depth[i.n] === undefined) { depth[i.n] = depth[it] + 1; queue.push(i.n); }
  }
  const order = Object.keys(depth).sort((a, b) => depth[a] - depth[b]);
  const uses2 = useRecs.map(({ it, r }) => ({ it, r: r.name, used: (crafts[r.name] || 0) * (r.in.find((i) => i.n === it)?.a || 0), outs: r.out.map((o) => o.n) }));
  return { order, choice, crafts, imports, need, fromByp, surplus, helpers: [], tmpl, forced: new Set(), uses: uses2, usable, auto: (it) => !prefs[it], cands: (it) => cands[it] || candFor(it) };
}

// Plan a chain: pick one recipe per item (the user's choice or a sensible default), add "helper" recipes that turn
// byproducts into needed items (e.g. cracking), then solve for the cheapest balanced mix. Loops the user chose are allowed.
function planChain(target, rate, prefs, helpersOff = [], uses = {}) {
  if (settings.efficient) return planChainEfficient(target, rate, prefs, uses);
  const { tset, trate } = normTargets(target, rate);
  const banned = new Set(), forced = new Set();
  let order, choice;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 80) throw new Error('Could not resolve this production chain.');
    choice = (it) => (forced.has(it) ? 'raw' : defaultChoice(it, prefs, banned, tset.has(it)));
    order = [];
    const state = {};
    let cyc = null;
    const visit = (it) => {
      if (cyc || state[it] === 2) return;
      if (state[it] === 1) {
        // A loop through a recipe the user picked is intentional (Kovarex, eggs); a loop made by defaults is broken up.
        if (!(prefs[it] && prefs[it] !== 'raw')) cyc = it;
        return;
      }
      state[it] = 1;
      const c = choice(it);
      if (c !== 'raw') for (const i of G.recipes[c].in) visit(i.n);
      state[it] = 2;
      order.push(it);
    };
    tset.forEach(visit);
    if (!cyc) break;
    const c = choice(cyc);
    if (c !== 'raw' && !tset.has(cyc)) banned.add(c); else forced.add(cyc);
    if (defaultChoice(cyc, prefs, banned, tset.has(cyc)) === 'raw') forced.add(cyc);
  }
  order.reverse();
  const items = new Set(order);
  const chosen = new Set(order.map(choice).filter((c) => c !== 'raw'));
  const local = new Set(planet().resources || []);
  const byp = new Set();
  // Leftovers: anything the chain doesn't need, plus every output of a multi-output recipe (it can be over-produced).
  const addByp = (r) => r.out.forEach((o) => { if (r.out.length > 1 || !items.has(o.n) || choice(o.n) !== r.name) byp.add(o.n); });
  chosen.forEach((c) => addByp(G.recipes[c]));
  // Helpers may chain: heavy oil cracking qualifies once light oil cracking wants the light oil it makes.
  const helpers = [], wanted = new Set(items);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of Object.values(G.recipes)) {
      if (chosen.has(r.name) || helpers.includes(r) || r.aux || r.hidden || r.mining || !recipeOK(r)) continue;
      if (!r.in.some((i) => byp.has(i.n))) continue;
      if (r.out.some((o) => tset.has(o.n))) continue;
      if (!r.out.some((o) => wanted.has(o.n) && !r.in.some((i) => i.n === o.n))) continue;
      if (!r.in.every((i) => items.has(i.n) || byp.has(i.n) || local.has(i.n))) continue;
      helpers.push(r); addByp(r); r.in.forEach((i) => wanted.add(i.n)); grew = true;
    }
  }
  const off = new Set(helpersOff);
  // Recipes that can use up a leftover: they consume it and need nothing the chain can't already supply.
  const usable = (it) => Object.values(G.recipes).filter((r) => !r.aux && !r.hidden && !r.mining && recipeOK(r)
    && r.in.some((i) => i.n === it) && !r.out.some((o) => o.n === it)
    && r.in.every((i) => i.n === it || items.has(i.n) || byp.has(i.n) || local.has(i.n))).sort(bySort);
  const useRecs = [];
  for (const [it, rn] of Object.entries(uses)) {
    if (tset.has(it) || !byp.has(it)) continue;
    const r = usable(it).find((x) => x.name === rn);
    if (r) useRecs.push({ it, r });
  }
  const recs = [...chosen].map((c) => G.recipes[c]).concat(helpers.filter((r) => !off.has(r.name)));
  for (const u of useRecs) if (!recs.includes(u.r)) recs.push(u.r);
  const tmpl = {};
  const coef = recs.map((r) => {
    const t = (tmpl[r.name] = applyPlanMods({ id: -1, type: 'recipe', recipe: r.name, machine: bestMachine(r).name, count: 1, mq: 'normal' }));
    const f = fx(t), net = {}, gross = {};
    for (const i of r.in) net[i.n] = (net[i.n] || 0) - i.a;
    for (const o of r.out) { const a = o.a + Math.max(0, o.a - o.ig) * f.prod; net[o.n] = (net[o.n] || 0) + a; gross[o.n] = (gross[o.n] || 0) + a; }
    return { net, gross, machines: r.time / f.speed };
  });
  const all = new Set(items);
  coef.forEach((c) => Object.keys(c.net).forEach((k) => all.add(k)));
  const list = [...all], nr = recs.length;
  const rows = list.map((it, k) => ({ c: [...recs.map((r, j) => [j, coef[j].net[it] || 0]).filter((v) => v[1]), [nr + k, 1]], op: '>=', rhs: trate(it) }));
  // A leftover the user wants used up must be consumed exactly: nothing piles up.
  for (const u of useRecs) rows.push({ c: recs.map((r, j) => [j, coef[j].net[u.it] || 0]).filter((v) => v[1]), op: '<=', rhs: 0 });
  // Only real inputs can come from outside: the chain's raw items, and local resources a byproduct recipe needs (water for cracking).
  const isRaw = (it) => (items.has(it) ? choice(it) === 'raw' : local.has(it));
  const cost = [...coef.map((c) => 1e-3 * c.machines), ...list.map((it) => (isRaw(it) ? supplyCost(it) : 1e9))];
  const x = solveLP(nr + list.length, rows, cost);
  if (!x) throw new Error('No balanced solution was found for this chain.');
  const crafts = {}, imports = {}, need = Object.fromEntries([...tset].map((t) => [t, trate(t)])), fromByp = {};
  recs.forEach((r, j) => {
    if (x[j] <= 1e-10) return;
    crafts[r.name] = x[j];
    for (const i of r.in) need[i.n] = (need[i.n] || 0) + i.a * x[j];
    for (const o in coef[j].gross) if (choice(o) !== r.name) fromByp[o] = (fromByp[o] || 0) + coef[j].gross[o] * x[j];
  });
  list.forEach((it, k) => { if (x[nr + k] > 1e-10) imports[it] = x[nr + k]; });
  const surplus = {};
  list.forEach((it) => {
    let made = 0;
    recs.forEach((r, j) => { if (crafts[r.name]) made += (coef[j].gross[it] || 0) * x[j]; });
    const extra = made + (imports[it] || 0) - (need[it] || 0);
    if (extra > 1e-6 * Math.max(1, made)) surplus[it] = extra;
  });
  const uses2 = useRecs.map(({ it, r }) => ({ it, r: r.name, used: (crafts[r.name] || 0) * (r.in.find((i) => i.n === it)?.a || 0), outs: r.out.map((o) => o.n) }));
  return { order, choice, crafts, imports, need, fromByp, surplus, helpers: helpers.map((r) => ({ r, off: off.has(r.name) })), tmpl, forced, uses: uses2, usable };
}
function buildChain(target, rate, prefs, { noSink = false } = {}) {
  const { tset, trate } = normTargets(target, rate);
  const P = planChain(target, rate, prefs, S.helpersOff || [], S.leftoverUse || {});
  const made = [], producers = {};
  const addProd = (it, id) => (producers[it] = producers[it] || []).push(id);
  FX = {};
  for (const [c, k] of Object.entries(P.crafts)) {
    const r = G.recipes[c];
    const t = P.tmpl[c];
    const n = addNode({ type: 'recipe', recipe: c, machine: t.machine, mod: t.mod, modq: t.modq, modN: t.modN, bc: t.bc, bmod: t.bmod, bmodq: t.bmodq });
    n.count = (k * r.time) / fx(n).speed;
    made.push(n);
  }
  for (const [it, q] of Object.entries(P.imports)) { const n = addNode({ type: 'source', item: it, rate: q }); made.push(n); }
  for (const n of made) {
    const o = nominal(n).outs;
    const r = n.type === 'recipe' && G.recipes[n.recipe];
    for (const it in o) {
      if (!(o[it] > 1e-12)) continue;
      if (r && r.in.some((i) => i.n === it)) {
        // Recipe that feeds itself (coal liquefaction, Kovarex): output -> priority splitter -> #1 back into itself.
        const sp = addNode({ type: 'splitter', item: it });
        made.push(sp);
        connect(n.id, sp.id, it);
        connect(sp.id, n.id, it);
        addProd(it, sp.id);
      } else addProd(it, n.id);
    }
  }
  for (const n of made) {
    if (n.type !== 'recipe') continue;
    const ins = nominal(n).ins;
    for (const it in ins) if (ins[it] > 1e-12) for (const pid of producers[it] || []) connect(pid, n.id, it);
  }
  if (!noSink) {
    for (const t of tset) {
      const sink = addNode({ type: 'sink', item: t, target: trate(t) });
      made.push(sink);
      for (const pid of producers[t] || []) connect(pid, sink.id, t);
    }
  }
  for (const u of P.uses) {
    const n = made.find((m) => m.type === 'recipe' && m.recipe === u.r);
    if (!n) continue;
    n.absorb = u.it;
    const outs = nominal(n).outs;
    for (const o in outs) {
      if (outs[o] <= 1e-12 || S.edges.some((e) => e.from === n.id && e.item === o)) continue;
      const sk = addNode({ type: 'sink', item: o });
      made.push(sk);
      connect(n.id, sk.id, o);
    }
  }
  // Columns: longest path to the end of the chain, ignoring links that loop back.
  const ids = new Set(made.map((n) => n.id)), outs = {};
  for (const e of S.edges) if (ids.has(e.from) && ids.has(e.to)) (outs[e.from] = outs[e.from] || []).push(e.to);
  const depth = {}, state = {};
  const dfs = (id) => {
    if (state[id] === 2) return depth[id];
    if (state[id] === 1) return -1;
    state[id] = 1;
    let d = 0;
    for (const t of outs[id] || []) { const dt = dfs(t); if (dt >= 0) d = Math.max(d, dt + 1); }
    state[id] = 2;
    return (depth[id] = d);
  };
  made.forEach((n) => dfs(n.id));
  const maxD = Math.max(0, ...Object.values(depth));
  made.forEach((n) => (n._col = maxD - (depth[n.id] || 0)));
  made.producers = producers[[...tset][0]] || [];
  made.producer = made.producers[0];
  return made;
}
function layoutColumns(nodes, ox, oy) {
  const cols = {};
  nodes.forEach((n) => (cols[n._col] = cols[n._col] || []).push(n));
  const hs = {};
  nodes.forEach((n) => { const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`); hs[n.id] = el ? el.offsetHeight : 180; });
  const tot = (c) => c.reduce((s, n) => s + hs[n.id] + 36, -36);
  const H = Math.max(...Object.values(cols).map(tot));
  for (const k in cols) {
    let y = oy + (H - tot(cols[k])) / 2;
    cols[k].forEach((n) => { n.x = Math.round(ox + k * 370); n.y = Math.round(y); y += hs[n.id] + 36; delete n._col; });
  }
  nodes.forEach((n) => { const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`); if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; } });
}
function bounds() {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const n of S.nodes) {
    const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`);
    if (!el) continue;
    b.x0 = Math.min(b.x0, n.x); b.y0 = Math.min(b.y0, n.y);
    b.x1 = Math.max(b.x1, n.x + (el ? el.offsetWidth : 284)); b.y1 = Math.max(b.y1, n.y + (el ? el.offsetHeight : 180));
  }
  for (const o of S.outposts || []) if (o.collapsed && !o.hidden && onCanvas(o)) { const r = frameRect(o); b.x0 = Math.min(b.x0, r.x); b.y0 = Math.min(b.y0, r.y); b.x1 = Math.max(b.x1, r.x + r.w); b.y1 = Math.max(b.y1, r.y + r.h); }
  return b;
}
// Fit the factory on screen, but never zoom out so far that nodes become unreadable: big factories are shown from
// the output end (the right), and you pan left to follow the chain back.
function fitView() {
  if (!S.nodes.some(visible) && !(S.outposts || []).some((o) => o.collapsed && !o.hidden)) { view = { x: 40, y: 40, k: 1 }; applyView(); drawEdges(); return; }
  const b = bounds(), r = canvas.getBoundingClientRect(), pad = 50;
  const fit = Math.min((r.width - pad * 2) / (b.x1 - b.x0), (r.height - pad * 2) / (b.y1 - b.y0));
  const k = Math.min(1.1, Math.max(0.6, fit));
  const x = fit >= 0.6 ? (r.width - (b.x1 - b.x0) * k) / 2 - b.x0 * k : r.width - pad - b.x1 * k;
  const y = (b.y1 - b.y0) * k <= r.height - pad * 2 ? (r.height - (b.y1 - b.y0) * k) / 2 - b.y0 * k : pad - b.y0 * k;
  view = { k, x, y };
  applyView(); drawEdges(); autosave();
}

/* ---------- Automatic layout ----------
   Columns from raw inputs (left) to outputs (right) by longest path, loops ignored; resources sit just left of what
   they feed; within a column nodes are ordered next to their neighbours (barycenter sweeps) to keep lines short and
   uncrossed; separate production chains are stacked. */
const COL_W = 252 + 150, ROW_GAP = 44, CHAIN_GAP = 140, OUTPOST_GAP = 140, ROW_WIDTH = 5200;
function arrange() {
  ensureOutposts();
  let cx = 0, cy = 0, rowH = 0;
  for (const o of S.outposts.filter(onCanvas)) {
    const ns = S.nodes.filter((n) => n.outpost === o.id);
    if (o.hidden) continue;
    if (o.collapsed) {
      if (cx > 0 && cx + TILE_W > ROW_WIDTH) { cx = 0; cy += rowH + OUTPOST_GAP; rowH = 0; }
      if (ns.length) { const dx = cx - (Math.min(...ns.map((n) => n.x)) - FRAME_PAD), dy = cy - (Math.min(...ns.map((n) => n.y)) - FRAME_HEAD); ns.forEach((n) => { n.x += dx; n.y += dy; }); }
      o.cx = cx; o.cy = cy; cx += TILE_W + OUTPOST_GAP; rowH = Math.max(rowH, TILE_H);
      continue;
    }
    if (!ns.length) {
      if (cx > 0 && cx + EMPTY_W > ROW_WIDTH) { cx = 0; cy += rowH + OUTPOST_GAP; rowH = 0; }
      o.x = cx; o.y = cy; cx += EMPTY_W + OUTPOST_GAP; rowH = Math.max(rowH, EMPTY_H);
      continue;
    }
    const size = layoutGroup(ns);
    const w = size.w + 2 * FRAME_PAD, h = size.h + FRAME_HEAD + FRAME_PAD;
    if (cx > 0 && cx + w > ROW_WIDTH) { cx = 0; cy += rowH + OUTPOST_GAP; rowH = 0; }
    ns.forEach((n) => { n.x += cx + FRAME_PAD; n.y += cy + FRAME_HEAD; });
    cx += w + OUTPOST_GAP; rowH = Math.max(rowH, h);
  }
  S.nodes.forEach((n) => { const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`); if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; } });
  drawEdges();
}
// Lay out one group of nodes from (0, 0); returns its size.
function layoutGroup(ns) {
  const ids = new Set(ns.map((n) => n.id));
  const E = S.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const outs = new Map(), ins = new Map();
  ns.forEach((n) => { outs.set(n.id, []); ins.set(n.id, []); });
  E.forEach((e) => { if (!outs.get(e.from).includes(e.to)) outs.get(e.from).push(e.to); if (!ins.get(e.to).includes(e.from)) ins.get(e.to).push(e.from); });
  // Longest path to the end of the chain; links that loop back are ignored.
  const depth = new Map(), state = new Map();
  const dfs = (id) => {
    if (state.get(id) === 2) return depth.get(id);
    if (state.get(id) === 1) return -1;
    state.set(id, 1);
    let d = 0;
    for (const t of outs.get(id)) { const dt = dfs(t); if (dt >= 0) d = Math.max(d, dt + 1); }
    state.set(id, 2); depth.set(id, d);
    return d;
  };
  [...ns].sort((a, b) => ins.get(a.id).length - ins.get(b.id).length || a.id - b.id).forEach((n) => dfs(n.id));
  // Connected chains.
  const comp = new Map();
  let nc = 0;
  for (const n of ns) {
    if (comp.has(n.id)) continue;
    const st = [n.id];
    comp.set(n.id, nc);
    while (st.length) { const id = st.pop(); for (const t of [...outs.get(id), ...ins.get(id)]) if (!comp.has(t)) { comp.set(t, nc); st.push(t); } }
    nc++;
  }
  const h = new Map(ns.map((n) => [n.id, nodesEl.querySelector(`.node[data-id="${n.id}"]`)?.offsetHeight || 120]));
  const chains = [];
  for (let c = 0; c < nc; c++) {
    const mem = ns.filter((n) => comp.get(n.id) === c);
    const maxD = Math.max(...mem.map((n) => depth.get(n.id)));
    const col = new Map(mem.map((n) => [n.id, maxD - depth.get(n.id)]));
    // Inputs sit right next to their first consumer instead of at the far left.
    for (const n of mem) if (!ins.get(n.id).length && outs.get(n.id).length) col.set(n.id, Math.max(0, Math.min(...outs.get(n.id).map((t) => col.get(t))) - 1));
    const ncol = Math.max(...col.values()) + 1;
    const cols = Array.from({ length: ncol }, () => []);
    [...mem].sort((a, b) => a.y - b.y || a.id - b.id).forEach((n) => cols[col.get(n.id)].push(n.id));
    const pos = new Map();
    const index = () => cols.forEach((list) => list.forEach((id, i) => pos.set(id, i / Math.max(1, list.length - 1))));
    index();
    for (let sweep = 0; sweep < 8; sweep++) {
      const fwd = sweep % 2 === 0;
      const order = fwd ? cols.map((_, i) => i) : cols.map((_, i) => ncol - 1 - i);
      for (const ci of order) {
        const list = cols[ci];
        const bary = (id) => {
          const nb = (fwd ? ins.get(id) : outs.get(id)).filter((t) => col.get(t) !== undefined && (fwd ? col.get(t) < ci : col.get(t) > ci));
          return nb.length ? nb.reduce((a, t) => a + pos.get(t), 0) / nb.length : pos.get(id);
        };
        const b = new Map(list.map((id) => [id, bary(id)]));
        list.sort((x, y) => b.get(x) - b.get(y));
        list.forEach((id, i) => pos.set(id, i / Math.max(1, list.length - 1)));
      }
    }
    const colH = cols.map((list) => list.reduce((a, id) => a + h.get(id) + ROW_GAP, -ROW_GAP));
    const H = Math.max(...colH);
    const place = new Map();
    cols.forEach((list, ci) => {
      let y = (H - colH[ci]) / 2;
      for (const id of list) { place.set(id, { x: ci * COL_W, y }); y += h.get(id) + ROW_GAP; }
    });
    chains.push({ place, H, size: mem.length });
  }
  chains.sort((a, b) => b.size - a.size);
  let oy = 0, w = 0;
  for (const ch of chains) {
    for (const [id, p] of ch.place) { const n = node(id); n.x = Math.round(p.x); n.y = Math.round(oy + p.y); w = Math.max(w, n.x + 252); }
    oy += ch.H + CHAIN_GAP;
  }
  return { w, h: oy - CHAIN_GAP };
}
function maybeArrange() { if (settings.autoArrange) arrange(); }

/* ---------- Canvas interaction ---------- */
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) {
    // Right-drag on the canvas draws a selection box; Shift or Ctrl adds to the current selection.
    if (e.target.closest('.node,.el,.empty-canvas')) return;
    const box = document.createElement('div');
    box.className = 'marquee';
    canvas.appendChild(box);
    drag = { kind: 'box', sx: e.clientX, sy: e.clientY, add: e.shiftKey || e.ctrlKey, base: new Set(selected), box, frame: e.target.closest('.frame')?.dataset.op };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0 && e.button !== 1) return;
  const port = e.target.closest('.port');
  if (port && e.button === 0) {
    e.preventDefault();
    const nid = +port.dataset.node, it = port.dataset.item, dir = port.dataset.dir;
    const into = dir === 'in' ? S.edges.filter((x) => x.to === nid && x.item === it) : [];
    if (into.length) {
      // Grabbing a connected input picks up its wire: drop it on another input to move it, anywhere else to remove it.
      const ed = into[into.length - 1];
      S.edges = S.edges.filter((x) => x !== ed);
      const a = portPos(ed.from, it, 'out');
      drag = { kind: 'wire', nid: ed.from, item: it, dir: 'out', a, b: toWorld(e.clientX, e.clientY), detached: ed };
      refresh();
    } else {
      const a = portPos(nid, it, dir);
      drag = { kind: 'wire', nid, item: it, dir, a, b: a };
    }
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  const fh = e.target.closest('.fh');
  if (fh && e.button === 0 && !e.target.closest('button')) {
    const id = +fh.dataset.op, o = outpost(id);
    if (S.active !== id) setActive(id);
    const p = toWorld(e.clientX, e.clientY);
    const group = S.nodes.filter((n) => n.outpost === id).map((n) => ({ n, x: n.x, y: n.y, el: nodesEl.querySelector(`.node[data-id="${n.id}"]`) }));
    const empty = !group.length && !o.collapsed;
    drag = { kind: 'node', p0: p, group, moved: false, frame: true, tile: o.collapsed ? { o, x: o.cx, y: o.cy, kx: 'cx', ky: 'cy' } : empty ? { o, x: o.x, y: o.y, kx: 'x', ky: 'y' } : null };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  const nh = e.target.closest('.nh');
  if (nh && e.button === 0 && !e.target.closest('button')) {
    const id = +nh.parentElement.dataset.id;
    if (e.ctrlKey || e.shiftKey) { selected.has(id) ? selected.delete(id) : selected.add(id); markSel(); return; }
    if (!selected.has(id)) { selected = new Set([id]); markSel(); }
    // Dragging a selected node moves the whole selection.
    const p = toWorld(e.clientX, e.clientY);
    const group = S.nodes.filter((n) => selected.has(n.id)).map((n) => ({ n, x: n.x, y: n.y, el: nodesEl.querySelector(`.node[data-id="${n.id}"]`) }));
    drag = { kind: 'node', p0: p, group, moved: false };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button === 0 && e.target.closest('.node,.el,.empty-canvas,.fold,.fsug')) return;
  drag = { kind: 'pan', sx: e.clientX - view.x, sy: e.clientY - view.y, x0: e.clientX, y0: e.clientY, button: e.button };
  canvas.classList.add('panning');
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'pan') { view.x = e.clientX - drag.sx; view.y = e.clientY - drag.sy; applyView(); }
  else if (drag.kind === 'node') {
    const p = toWorld(e.clientX, e.clientY), dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
    for (const g of drag.group) {
      g.n.x = Math.round(g.x + dx); g.n.y = Math.round(g.y + dy);
      if (g.el) { g.el.style.left = g.n.x + 'px'; g.el.style.top = g.n.y + 'px'; }
    }
    if (drag.tile) { drag.tile.o[drag.tile.kx] = Math.round(drag.tile.x + dx); drag.tile.o[drag.tile.ky] = Math.round(drag.tile.y + dy); }
    drag.moved = true;
    drawEdges();
  } else if (drag.kind === 'box') {
    const r = canvas.getBoundingClientRect();
    const x0 = Math.min(drag.sx, e.clientX), y0 = Math.min(drag.sy, e.clientY), x1 = Math.max(drag.sx, e.clientX), y1 = Math.max(drag.sy, e.clientY);
    Object.assign(drag.box.style, { left: x0 - r.left + 'px', top: y0 - r.top + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' });
    selected = new Set(drag.add ? drag.base : []);
    nodesEl.querySelectorAll('.node').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.right > x0 && b.left < x1 && b.bottom > y0 && b.top < y1) selected.add(+el.dataset.id);
    });
    markSel();
  } else if (drag.kind === 'wire') {
    drag.b = toWorld(e.clientX, e.clientY);
    nodesEl.querySelectorAll('.port.hot').forEach((p) => p.classList.remove('hot'));
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.port');
    if (t && t.dataset.item === drag.item && t.dataset.dir !== drag.dir) t.classList.add('hot');
    drawEdges();
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.classList.remove('panning');
  if (d.kind === 'node') {
    // A node dropped inside another outpost's frame moves to that outpost.
    if (d.moved && !d.frame) {
      for (const g of d.group) {
        const el = g.el, cx = g.n.x + (el ? el.offsetWidth / 2 : 120), cy = g.n.y + 20;
        const into = S.outposts.find((o) => o.id !== g.n.outpost && !o.hidden && !o.collapsed && (() => { const r = frameRect(o); return r && cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h; })());
        if (into) { g.n.outpost = into.id; toast(`Moved to ${into.name}`); }
      }
      drawFrames(); renderOutposts();
    }
    if (d.moved) commit();
    return;
  }
  if (d.kind === 'box') {
    d.box.remove();
    // A right-click without dragging on an outpost's frame opens that outpost's settings.
    if (d.frame && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) { selected = new Set(d.base); markSel(); openOutpostMenu(+d.frame, e.clientX, e.clientY); }
    return;
  }
  if (d.kind === 'pan') {
    // A plain left click on empty canvas clears the selection; a pan keeps it.
    if (d.button === 0 && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) { selected.clear(); markSel(); }
    autosave();
    return;
  }
  nodesEl.querySelectorAll('.port.hot').forEach((p) => p.classList.remove('hot'));
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const port = t && t.closest('.port');
  if (port && port.dataset.item === d.item && port.dataset.dir !== d.dir) {
    const o = +port.dataset.node;
    const made = d.dir === 'out' ? connect(d.nid, o, d.item) : connect(o, d.nid, d.item);
    if (made || d.detached) { autoBalance(); refresh(); maybeArrange(); commit(); }
    return;
  }
  if (d.detached) { autoBalance(); refresh(); maybeArrange(); commit(); return; }
  if (t && (t === canvas || t.closest('#world')) && !t.closest('.node') && Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 20) {
    openPalette({ at: d.b, link: { nid: d.nid, item: d.item, dir: d.dir } });
    return;
  }
  drawEdges();
});
canvas.addEventListener('wheel', (e) => {
  if (e.target.closest('select')) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.min(2, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015)));
  view.x = mx - ((mx - view.x) * k) / view.k; view.y = my - ((my - view.y) * k) / view.k; view.k = k;
  applyView(); autosave();
}, { passive: false });
canvas.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.frame.tile');
  if (tile) { toggleCollapse(+tile.dataset.op); return; }
  const fn = e.target.closest('.fh .fname');
  if (fn) { renameOutpost(+fn.closest('.fh').dataset.op, fn); return; } if (e.target.closest('.node,.el,.empty-canvas')) return; openPalette({ at: toWorld(e.clientX, e.clientY) }); });
world.addEventListener('click', (e) => {
  const sug = e.target.closest('[data-sug]');
  if (sug) { switchOutpostPlanet(+sug.dataset.sug, sug.dataset.p); return; }
  const fold = e.target.closest('[data-fold]');
  if (fold) { toggleCollapse(+fold.dataset.fold); return; }
  const sb = e.target.closest('[data-split]');
  if (sb) {
    const ed = S.edges.find((x) => x.id === +sb.dataset.split);
    if (!ed) return;
    const a = node(ed.from), b2 = node(ed.to);
    const sp = addNode({ type: 'splitter', item: ed.item });
    sp.x = Math.round((a.x + b2.x) / 2); sp.y = Math.round((a.y + b2.y) / 2 + 60);
    S.edges = S.edges.filter((x) => x !== ed);
    connect(a.id, sp.id, ed.item); connect(sp.id, b2.id, ed.item);
    selected = new Set([sp.id]);
    autoBalance(); rebuild(); maybeArrange(); commit();
    return;
  }
  const eb = e.target.closest('[data-edge]');
  if (eb) { S.edges = S.edges.filter((x) => x.id !== +eb.dataset.edge); autoBalance(); refresh(); maybeArrange(); commit(); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = +b.closest('.node').dataset.id, n = node(id);
  if (b.dataset.act === 'del') delNode(id);
  if (b.dataset.act === 'open') { n.open = !n.open; rebuildNode(n); commit(); return; }
  if (b.dataset.act === 'fit') { n.pin = false; fitNode(n); autoBalance(); rebuildNode(n); commit(); }
  if (b.dataset.act === 'up' || b.dataset.act === 'down') {
    const order = splitterOuts(n).map((e) => e.id), i = order.indexOf(+b.dataset.e), j = i + (b.dataset.act === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    n.prio = order;
    rebuildNode(n); commit();
    return;
  }
  if (b.dataset.act === 'noabsorb') { n.absorb = undefined; autoBalance(); rebuildNode(n); commit(); }
  if (b.dataset.act === 'unpin') { n.pin = false; fitNode(n); autoBalance(); rebuildNode(n); commit(); }
  if (b.dataset.act === 'auto') { n.pin = !n.pin; if (!n.pin) fitNode(n); autoBalance(); rebuildNode(n); commit(); }
});
world.addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  if (!f) return;
  const n = node(+e.target.closest('.node').dataset.id);
  const v = e.target.value;
  // Changing how a machine works (building, quality, modules, beacons, bonuses) keeps the node's output the same:
  // the machine count is rescaled and everything feeding it is resized to the new input needs.
  if (f === 'machine' && v.startsWith('recipe:')) { const [rn, mn] = v.slice(7).split('|'); swapRecipe(n, rn, mn); commit(); return; }
  const keepOutput = n.type === 'recipe' && f !== 'count';
  const before = keepOutput ? outPerMachine(n) : 0;
  if (['machine', 'mq', 'mod', 'modq', 'bmod', 'bmodq'].includes(f)) n[f] = v || undefined;
  else if (f === 'rate') n.rate = (+v || 0) / uf();
  else n[f] = +v || 0;
  if (f === 'machine') n.modN = undefined;
  // A count or amount typed by hand is pinned so Auto-balance keeps it.
  if (f === 'count' || f === 'rate') n.pin = true;
  if (keepOutput) {
    const after = outPerMachine(n);
    if (before > 0 && after > 0) n.count = (+n.count || 0) * (before / after);
  }
  if (settings.autoBalance) balanceAll(); else if (keepOutput) fitUpstream(n);
  if (f === 'machine' || ((f === 'count' || f === 'rate') && !e.target.closest('.node').querySelector('.pin,.tog[aria-pressed="false"]'))) rebuildNode(n);
  else { FX = {}; refresh(); }
  if (f === 'count' || f === 'rate') { const el = document.getElementById(e.target.id); if (el && el !== document.activeElement) { el.focus(); const L = el.value.length; try { el.setSelectionRange(L, L); } catch {} } }
  commit();
});
// Switch a node to another recipe for the same product (e.g. smelting -> casting), keeping its output,
// removing supply chains that only fed the old ingredients and planning new ones for the new ingredients.
function swapRecipe(n, name, machine) {
  const oldR = G.recipes[n.recipe], newR = G.recipes[name];
  const main = newR.out.some((o) => o.n === oldR.main) ? oldR.main : newR.main;
  const rate = nominal(n).outs[main] || 0;
  n.recipe = name; n.machine = machine || bestMachine(newR).name; n.modN = undefined; FX = {};
  const M = G.machines[n.machine];
  if (n.mod && !moduleFits(G.modules[n.mod] || { effect: {} }, M.allowed, newR)) n.mod = undefined;
  if (n.bmod && G.beacon && !moduleFits(G.modules[n.bmod] || { effect: {} }, G.beacon.allowed, newR)) n.bmod = undefined;
  const per = perMachine(n).o[main];
  if (per > 0 && rate > 0) n.count = rate / per;
  const oldSuppliers = [];
  S.edges = S.edges.filter((e) => {
    if (e.to === n.id && !newR.in.some((i) => i.n === e.item)) { oldSuppliers.push(e.from); return false; }
    return !(e.from === n.id && !newR.out.some((o) => o.n === e.item));
  });
  pruneOrphans(oldSuppliers);
  FX = {};
  const need = nominal(n).ins, chains = [];
  for (const i of newR.in) {
    if (S.edges.some((e) => e.to === n.id && e.item === i.n) || !(need[i.n] > 0)) continue;
    const made = buildChain(i.n, need[i.n], S.prefs, { noSink: true });
    for (const pid of made.producers) connect(pid, n.id, i.n);
    chains.push(made);
  }
  autoBalance();
  rebuild();
  if (settings.autoArrange) arrange();
  else {
    let oy = n.y;
    for (const made of chains) {
      const cols = Math.max(0, ...made.map((m) => m._col ?? 0));
      layoutColumns(made, n.x - (cols + 1) * 370, oy);
      oy = Math.max(...made.map((m) => m.y + (nodesEl.querySelector(`.node[data-id="${m.id}"]`)?.offsetHeight || 100))) + 40;
    }
  }
  drawEdges();
  toast(`Switched to ${newR.label}`);
}
// Remove nodes that no longer supply anything, following the chain upstream.
function pruneOrphans(ids) {
  for (const id of ids) {
    const nd = node(id);
    if (!nd || nd.type === 'sink' || S.edges.some((e) => e.from === id)) continue;
    const ups = S.edges.filter((e) => e.to === id).map((e) => e.from);
    S.nodes = S.nodes.filter((x) => x.id !== id);
    S.edges = S.edges.filter((e) => e.to !== id);
    selected.delete(id);
    pruneOrphans(ups);
  }
}
function outPerMachine(n) {
  const r = G.recipes[n.recipe], f = fx(n);
  const o = r.out.find((x) => x.n === r.main) || r.out[0];
  return ((o.a + Math.max(0, o.a - o.ig) * f.prod) * f.speed) / r.time;
}
function fitUpstream(n) {
  const up = [], seen = new Set([n.id]), queue = [n.id];
  while (queue.length) {
    const id = queue.shift();
    for (const e of S.edges) if (e.to === id && !seen.has(e.from) && node(e.from)) { seen.add(e.from); up.push(node(e.from)); queue.push(e.from); }
  }
  for (let pass = 0; pass < 30; pass++) {
    const before = up.map((p) => p.count ?? p.rate).join();
    FX = {};
    up.forEach(fitNode);
    if (up.map((p) => p.count ?? p.rate).join() === before) break;
  }
}
// Show recalculated counts and supply rates without rebuilding nodes (which would steal focus from the field being edited).
function syncInputs() {
  for (const n of S.nodes) {
    const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`);
    const inp = el && el.querySelector(n.type === 'source' ? '[data-f=rate]' : '[data-f=count]');
    if (inp && inp !== document.activeElement) inp.value = n.type === 'source' ? rateField(n.rate) : +(+n.count).toFixed(3);
  }
}
world.addEventListener('toggle', (e) => { const el = e.target.closest('.node'); if (el && e.target.matches('details.mods')) { node(+el.dataset.id).showMods = e.target.open; requestAnimationFrame(drawEdges); } }, true);
function markSel() { nodesEl.querySelectorAll('.node').forEach((el) => el.classList.toggle('sel', selected.has(+el.dataset.id))); }
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input,textarea,select');
  if (e.key === 'Escape' && $('#ctx')) { closeCtx(); return; }
  if (e.key === 'Escape' && $('#modal').innerHTML) { closeModal(); return; }
  if ($('#modal').innerHTML || !$('#welcome').hidden || typing) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) delNodes([...selected]);
  if (e.key === 'Escape' && selected.size) { selected.clear(); markSel(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selected = new Set(S.nodes.filter(visible).map((n) => n.id)); markSel(); }
  if (e.key === ' ') { e.preventDefault(); openAddCentered(); }
});
new ResizeObserver(() => drawEdges()).observe(canvas);

/* ---------- Modals ---------- */
function closeModal() { $('#modal').innerHTML = ''; }
function modal(title, body, { wide = false, footer = '' } = {}) {
  $('#modal').innerHTML = `<div class="ov"><div class="dlg ${wide ? 'wide' : ''}" role="dialog" aria-label="${esc(title)}"><header><span>${esc(title)}</span><button class="x" id="mx" aria-label="Close">×</button></header><div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div></div>`;
  $('#mx').onclick = closeModal;
  $('.ov').addEventListener('pointerdown', (e) => { if (e.target.classList.contains('ov')) closeModal(); });
}
const amt = (a) => +(+a).toFixed(a < 1 ? 3 : 2);
function recipeSummary(r) {
  const side = (list) => list.slice(0, 6).map((x) => `<span>${amt(x.a)}${ic(item(x.n).icon, item(x.n).label, 'xs')}</span>`).join('') + (list.length > 6 ? `<span>+${list.length - 6}</span>` : '');
  return `${side(r.in)}<span>→</span>${side(r.out)}<span>${+r.time.toFixed(3)}s</span>`;
}
function openAddCentered() { const r = canvas.getBoundingClientRect(); openPalette({ at: toWorld(r.left + r.width / 2 - 140, r.top + r.height / 2 - 100) }); }

function openPalette(ctx) {
  const L = ctx.link;
  const entries = [];
  const recipeEntry = (r) => { const why = unusableReason(r); return { k: 'recipe', r, label: r.label, icon: r.icon, sub: recipeSummary(r), ok: !why, why, group: r.group, sort: r.sort, tag: r.mining ? 'Extraction' : (machinesFor(r)[0] || machinesFor(r, true)[0] || {}).label || '' }; };
  const showRecipe = (r) => (!r.aux || settings.showAux) && (!r.hidden || r.mining);
  if (L) {
    const I = item(L.item);
    entries.push({ k: 'splitter', item: L.item, label: 'Priority splitter: ' + I.label, icon: I.icon, sub: L.dir === 'out' ? 'Send this to several places in priority order (or loop it back)' : 'Feed this from a priority splitter', ok: true, tag: 'Logistics' });
    if (L.dir === 'in') entries.push({ k: 'source', item: L.item, label: ((planet().resources || []).includes(L.item) ? 'Resource: ' : 'Import: ') + I.label, icon: I.icon, sub: 'Supplied from outside this factory', ok: true, tag: 'Input' });
    else entries.push({ k: 'sink', item: L.item, label: 'Output: ' + I.label, icon: I.icon, sub: 'Leaves the factory', ok: true, tag: 'Output' });
    for (const r of Object.values(G.recipes)) {
      if (!showRecipe(r)) continue;
      if (L.dir === 'out' ? !r.in.some((i) => i.n === L.item) : !r.out.some((o) => o.n === L.item)) continue;
      entries.push(recipeEntry(r));
    }
  } else {
    for (const r of Object.values(G.recipes)) if (showRecipe(r)) entries.push(recipeEntry(r));
    for (const I of Object.values(G.items)) {
      if (I.hidden) continue;
      const here = (planet().resources || []).includes(I.name);
      entries.push({ k: 'source', item: I.name, label: (here ? 'Resource: ' : 'Import: ') + I.label, icon: I.icon, sub: here ? 'Raw supply on this planet' : 'Supplied from elsewhere', ok: true, tag: 'Input', group: 'io', sort: (here ? 'a' : 'b') + I.sort, quiet: !here });
      entries.push({ k: 'sink', item: I.name, label: 'Output: ' + I.label, icon: I.icon, sub: 'Leaves the factory', ok: true, tag: 'Output', group: 'io', sort: 'c' + I.sort, quiet: true });
    }
  }
  entries.sort((a, b) => (a.k === 'recipe') - (b.k === 'recipe') || (b.ok - a.ok) || bySort(a, b));
  let tab = L ? null : localStorage.getItem('ffp-tab') || G.groups[0]?.name;
  const tabs = L ? '' : `<div class="tabs" id="ptabs">${G.groups.map((g) => `<button data-g="${g.name}" title="${esc(g.label)}" aria-pressed="${g.name === tab}">${ic(g.icon, g.label, 'lg')}</button>`).join('')}<button data-g="io" title="Resources, imports and outputs" aria-pressed="${tab === 'io'}"><span class="ic lg fb">I/O</span></button></div>`;
  modal(L ? `${L.dir === 'out' ? 'Use' : 'Make'} ${item(L.item).label}` : 'Add node', `${tabs}<input class="search" id="psearch" placeholder="Search recipes and items" aria-label="Search" autocomplete="off" spellcheck="false"><div class="plist" id="plist"></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap"><label class="chk"><input type="checkbox" id="plock" ${settings.showLocked ? 'checked' : ''}> Show recipes I can't use (locked or other planets)</label><label class="chk"><input type="checkbox" id="paux" ${settings.showAux ? 'checked' : ''}> Show recycling and barrel recipes</label><button class="linkbtn" id="pbuild" style="margin-left:auto">Choose unlocked buildings…</button></div>`, { wide: true });
  let act = 0, shown = [];
  const draw = () => {
    const q = $('#psearch').value.trim().toLowerCase();
    shown = entries.filter((x) => (x.ok || settings.showLocked) && (q ? x.label.toLowerCase().includes(q) : L || (x.group === tab && !x.quiet))).slice(0, 200);
    if (q) shown.sort((a, b) => (b.ok - a.ok) || (a.label.toLowerCase().startsWith(q) ? 0 : 1) - (b.label.toLowerCase().startsWith(q) ? 0 : 1));
    act = Math.max(0, Math.min(act, shown.length - 1));
    $('#plist').innerHTML = shown.length ? shown.map((x, i) => `<button class="pi ${i === act ? 'act' : ''} ${x.ok ? '' : 'dim'}" data-i="${i}" title="${esc(x.why || '')}">${ic(x.icon, x.label)}<span class="pt"><b>${esc(x.label)}</b><span class="rs">${x.sub}</span></span><span class="tag">${esc(x.ok ? x.tag : x.why)}</span></button>`).join('') : `<div class="empty">No match${settings.showLocked ? '' : ' among recipes you can use here'}. Try another name, or tick "Show recipes I can't use".</div>`;
  };
  const pick = (x) => {
    closeModal();
    const n = x.k === 'recipe' ? addNode({ type: 'recipe', recipe: x.r.name }) : addNode({ type: x.k, item: x.item });
    n.x = Math.round(ctx.at.x - (L && L.dir === 'in' ? 284 : 0));
    n.y = Math.round(ctx.at.y - 40);
    if (L) {
      const e = L.dir === 'out' ? connect(L.nid, n.id, L.item) : connect(n.id, L.nid, L.item);
      R = solve();
      if (e && n.type === 'recipe') {
        const pm = perMachine(n);
        if (L.dir === 'out') { const spare = Math.max(0, (R.left[L.nid][L.item] || 0) + (R.flow[e.id] || 0)); if (spare > 1e-9 && pm.i[L.item]) { n.count = spare / pm.i[L.item]; n.absorb = L.item; } }
        else { const c = node(L.nid), un = (R.nom[c.id].ins[L.item] || 0) - (R.got[c.id][L.item] || 0) + (R.flow[e.id] || 0); if (un > 1e-9 && pm.o[L.item]) n.count = un / pm.o[L.item]; }
      }
      if (e && n.type === 'source') { const c = node(L.nid); n.rate = Math.max(0, (R.nom[c.id].ins[L.item] || 0) - (R.got[c.id][L.item] || 0) + (R.flow[e.id] || 0)); }
    }
    selected = new Set([n.id]);
    autoBalance();
    rebuild(); maybeArrange(); commit();
  };
  draw();
  $('#psearch').focus();
  $('#psearch').addEventListener('input', () => { act = 0; draw(); });
  $('#psearch').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { act = Math.min(act + 1, shown.length - 1); draw(); e.preventDefault(); $('#plist .act')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { act = Math.max(act - 1, 0); draw(); e.preventDefault(); $('#plist .act')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter' && shown[act]) pick(shown[act]);
  });
  $('#plist').addEventListener('click', (e) => { const b = e.target.closest('.pi'); if (b) pick(shown[+b.dataset.i]); });
  $('#paux').addEventListener('change', (e) => { settings.showAux = e.target.checked; saveSettings(); closeModal(); openPalette(ctx); });
  $('#plock').addEventListener('change', (e) => { settings.showLocked = e.target.checked; saveSettings(); draw(); });
  $('#pbuild').addEventListener('click', () => openBuildings(() => openPalette(ctx)));
  $('#ptabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    tab = b.dataset.g;
    try { localStorage.setItem('ffp-tab', tab); } catch {}
    $('#ptabs').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    $('#psearch').value = ''; act = 0; draw();
  });
}

function openPlan(destId) {
  const producible = Object.values(G.items).filter((I) => !I.hidden && (byOut[I.name] || []).some((r) => !r.aux && !r.mining && !r.hidden)).sort(bySort);
  // Products being planned, rates in /s. Older saves stored a single { item, rate }.
  let targets = (S.lastPlan?.items || (S.lastPlan?.item ? [{ item: S.lastPlan.item, rate: S.lastPlan.rate }] : [])).filter((t) => G.items[t.item]).map((t) => ({ item: t.item, rate: +t.rate || 1 }));
  if (!targets.length) targets = [{ item: (producible.find((i) => i.name === 'automation-science-pack') || producible[0]).name, rate: 1 }];
  let pickIdx = null;
  const draft = { ...S.prefs };
  const hoff = new Set(S.helpersOff || []);
  const duse = { ...(S.leftoverUse || {}) };
  // The planet being planned for; the factory only switches to it when the chain is built.
  let dlgPlanet = S.viewPlanet;
  const dmods = { mod: '', modq: 'normal', bc: 0, bmod: '', bmodq: 'normal', ...(S.planMods || {}) };
  const withPlanet = (fn) => { const keep = S.planet; S.planet = dlgPlanet; planModsOverride = dmods; try { return fn(); } finally { S.planet = keep; planModsOverride = null; } };
  const modList = Object.values(G.modules).sort(bySort);
  const beaconMods = G.beacon ? modList.filter((m) => Object.entries(m.effect).every(([k, v]) => !(v > 0) || G.beacon.allowed.includes(k))) : [];
  const qOpts = (cur) => G.qualities.map((q) => `<option value="${q.name}" ${q.name === cur ? 'selected' : ''}>${esc(q.label)}</option>`).join('');
  modal('Plan production', `
    <div class="field"><span class="lbl">Products</span><div id="plTargets" class="tlist"></div>
      <div class="tactions"><button class="btn" id="plAddT">+ Add another product</button><div class="seg" id="plUnit" role="group" aria-label="Rate unit">${Object.keys(UNITS).map((u) => `<button data-u="${u}" aria-pressed="${u === S.unit}">/${u}</button>`).join('')}</div><label class="lbl" for="plDest">Build into</label><select id="plDest" class="dest">${(() => { const empty = S.active != null && !S.nodes.some((n) => n.outpost === S.active), pick = destId ?? (empty ? S.active : 'new'); return `<option value="new" ${pick === 'new' ? 'selected' : ''}>a new outpost</option>` + S.outposts.map((o) => `<option value="${o.id}" ${o.id === pick ? 'selected' : ''}>"${esc(o.name)}" on ${esc(G.planets.find((p) => p.name === o.planet)?.label || o.planet)} (replace its contents)</option>`).join(''); })()}</select></div>
    </div>
    <div class="field"><span class="lbl">Planet</span><div class="planets all" id="plPlanet" role="group" aria-label="Planet to plan for">${G.planets.map((p) => `<button data-p="${p.name}" aria-pressed="${p.name === S.planet}" title="${esc(p.label)}">${ic(p.icon, p.label, 'sm')}<span class="lbltxt">${esc(p.label)}</span></button>`).join('')}</div></div>
    <div class="field"><span class="lbl">Modules</span><div class="modrow">
      <select id="plMod" aria-label="Module in every building"><option value="">No modules</option>${modList.map((m) => `<option value="${m.name}" ${m.name === dmods.mod ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      <select id="plModQ" aria-label="Module quality">${qOpts(dmods.modq)}</select>
      ${G.beacon ? `<span class="lbl">Beacons</span><input id="plBc" class="num sm" type="number" min="0" max="16" value="${+dmods.bc || 0}" aria-label="Beacons reaching each building" title="Beacons reaching each building">
      <select id="plBMod" aria-label="Module in beacons"><option value="">—</option>${beaconMods.map((m) => `<option value="${m.name}" ${m.name === dmods.bmod ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      <select id="plBModQ" aria-label="Beacon module quality">${qOpts(dmods.bmodq)}</select>` : ''}
    </div><div class="note" id="plModNote"></div></div>
    <div id="plPicker" hidden><input class="search" id="plSearch" placeholder="Search items" aria-label="Search items" autocomplete="off" spellcheck="false"><div class="plist" id="plItems" style="max-height:34vh"></div></div>
    <div class="note">${settings.efficient ? '"Automatic" picks whatever mix of recipes uses the least raw resources on this planet, loops and byproducts included.' : 'Every intermediate below uses the recipe shown.'} Pick a recipe to fix it, or "Import" to supply it from outside. Choices are remembered for this factory.</div>
    <div style="overflow:auto"><table class="chain" id="plChain"></table></div>
    <div id="plByp"></div>`, { wide: true, footer: '<span class="note" id="plMsg" style="margin-right:auto"></span><button class="btn" id="plCancel">Cancel</button><button class="btn primary" id="plGo">Build chain</button>' });
  const live = () => targets.filter((t) => t.rate > 0);
  const drawTargets = () => {
    $('#plTargets').innerHTML = targets.map((t, i) => { const I = item(t.item); return `<div class="trow"><button class="picked" data-pick="${i}">${ic(I.icon, I.label, 'sm')}<span>${esc(I.label)}</span><span class="note" style="margin-left:auto">Change</span></button><input class="num" type="number" min="0" data-rate="${i}" value="${rateField(t.rate)}" aria-label="Rate for ${esc(I.label)}"><span class="lbl">${us()}</span>${targets.length > 1 ? `<button class="x" data-del="${i}" aria-label="Remove ${esc(I.label)}" title="Remove">×</button>` : ''}</div>`; }).join('');
  };
  const drawChain = () => withPlanet(drawChainHere);
  const drawChainHere = () => {
    let P;
    try { P = planChain(live(), null, draft, [...hoff], duse); } catch (err) { $('#plChain').innerHTML = ''; $('#plByp').innerHTML = ''; $('#plMsg').textContent = err.message; return; }
    $('#plMsg').textContent = P.forced.size ? `Loop detected; ${[...P.forced].map((i) => item(i).label).join(', ')} will be imported. Pick its recipe explicitly to build the loop.` : '';
    const mtxt = (c) => {
      if (!P.crafts[c]) return '';
      const r = G.recipes[c], M = G.machines[P.tmpl[c].machine];
      const k = (P.crafts[c] * r.time) / fx(P.tmpl[c]).speed;
      return `${k >= 1 ? +k.toFixed(2) : +k.toPrecision(2)} × ${esc(M.label)}`;
    };
    const tset = new Set(live().map((t) => t.item));
    const rows = P.order.filter((it) => (P.need[it] || 0) > 0 || tset.has(it)).map((it) => {
      const I = item(it), c = P.choice(it), cands = candidates(it);
      const isAuto = P.auto && P.auto(it);
      const here = (planet().resources || []).includes(it);
      const autoOpt = P.auto ? `<option value="" ${isAuto ? 'selected' : ''}>Automatic: ${esc(c === 'raw' ? (here ? 'raw resource' : 'import') : G.recipes[c].label)}</option>` : '';
      const opts = autoOpt + cands.map((r) => `<option value="${r.name}" ${!isAuto && r.name === c ? 'selected' : ''}>${esc(r.label)}${r.out.length > 1 ? ' (+byproducts)' : ''}</option>`).join('') + `<option value="raw" ${!isAuto && c === 'raw' ? 'selected' : ''}>Import / raw resource</option>`;
      let m = c !== 'raw' ? mtxt(c) : P.imports[it] ? `${here ? 'mined' : 'import'} ${fmt(P.imports[it])}${us()}` : '';
      if (P.fromByp[it] > 1e-9) m += `${m ? '<br>' : ''}<span class="byp">${fmt(Math.min(P.fromByp[it], P.need[it] || P.fromByp[it]))}${us()} from byproducts</span>`;
      if (c !== 'raw' && !P.crafts[c] && P.fromByp[it] > 1e-9) m = `<span class="byp">all from byproducts</span>`;
      return `<tr><td><span class="it">${ic(I.icon, I.label, 'sm')}${esc(I.label)}</span></td><td class="n">${fmt(P.need[it] || 0)}${us()}</td><td>${cands.length ? `<select data-item="${esc(it)}" aria-label="Recipe for ${esc(I.label)}">${opts}</select>` : '<span class="note">Raw resource</span>'}</td><td class="m">${m}</td></tr>`;
    });
    $('#plChain').innerHTML = rows.join('');
    const hl = P.helpers.map(({ r, off }) => `<label class="chk hrow"><input type="checkbox" data-h="${r.name}" ${off ? '' : 'checked'}>${ic(r.icon, r.label, 'sm')}<span>${esc(r.label)}</span><span class="note">${off ? 'not used' : mtxt(r.name) || 'not needed'}</span></label>`).join('');
    const useOuts = new Set(P.uses.flatMap((u) => u.outs));
    const leftovers = [...new Set([...Object.keys(P.surplus).filter((it) => !tset.has(it) && !useOuts.has(it)), ...Object.keys(duse)])];
    const sp = leftovers.map((it) => {
      const u = P.uses.find((x) => x.it === it), cands = P.usable(it);
      if (!u && !(P.surplus[it] > 0)) return '';
      const opts = `<option value="">Keep as leftover</option>` + cands.map((r) => `<option value="${r.name}" ${duse[it] === r.name ? 'selected' : ''}>Use for ${esc(r.label)}</option>`).join('');
      const made = u ? u.outs.filter((o) => P.surplus[o]).map((o) => `${fmt(P.surplus[o])}${us()} ${esc(item(o).label)}`).join(', ') : '';
      return `<div class="lrow">${ic(item(it).icon, item(it).label, 'sm')}<span class="lname">${esc(item(it).label)}</span><span class="lamt">${u ? `${fmt(u.used)}${us()} used` : `+${fmt(P.surplus[it])}${us()}`}</span>${cands.length ? `<select data-use="${esc(it)}" aria-label="What to do with leftover ${esc(item(it).label)}">${opts}</select>` : '<span class="note">Nothing in reach can use it</span>'}${made ? `<span class="note">makes ${made} (new output)</span>` : ''}</div>`;
    }).join('');
    $('#plByp').innerHTML = (hl ? `<div class="sec">Byproduct recipes</div><div class="note">These turn leftovers from the chain into things it needs. Untick one to leave it out.</div><div class="hlist">${hl}</div>` : '')
      + (sp ? `<div class="sec">Left over</div><div class="note">Pick a recipe to use up a leftover; its product becomes an extra output.</div><div class="llist">${sp}</div>` : '');
  };
  const drawItems = () => {
    const q = $('#plSearch').value.trim().toLowerCase();
    const list = producible.filter((I) => !q || I.label.toLowerCase().includes(q)).slice(0, 150);
    $('#plItems').innerHTML = list.map((I) => `<button class="pi" data-n="${esc(I.name)}">${ic(I.icon, I.label)}<span class="pt"><b>${esc(I.label)}</b></span></button>`).join('');
  };
  drawTargets(); drawChain();
  const openPicker = (idx) => { pickIdx = idx; $('#plPicker').hidden = false; $('#plSearch').value = ''; drawItems(); $('#plSearch').focus(); };
  $('#plTargets').onclick = (e) => {
    const pk = e.target.closest('[data-pick]'), del = e.target.closest('[data-del]');
    if (pk) { const i = +pk.dataset.pick; if (!$('#plPicker').hidden && pickIdx === i) $('#plPicker').hidden = true; else openPicker(i); }
    if (del) { targets.splice(+del.dataset.del, 1); $('#plPicker').hidden = true; drawTargets(); drawChain(); }
  };
  $('#plTargets').oninput = (e) => { const r = e.target.closest('[data-rate]'); if (!r) return; targets[+r.dataset.rate].rate = Math.max(0, +r.value || 0) / uf(); drawChain(); };
  $('#plAddT').onclick = () => openPicker('new');
  $('#plSearch').oninput = drawItems;
  $('#plItems').onclick = (e) => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    if (pickIdx === 'new') targets.push({ item: b.dataset.n, rate: targets[0]?.rate || 1 });
    else targets[pickIdx].item = b.dataset.n;
    $('#plPicker').hidden = true; drawTargets(); drawChain();
  };
  // Switching unit keeps the same amount (60/min becomes 1/s) and switches the whole app to that unit.
  $('#plUnit').onclick = (e) => {
    const b = e.target.closest('[data-u]');
    if (!b || b.dataset.u === S.unit) return;
    S.unit = b.dataset.u;
    $('#plUnit').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    drawTargets(); syncToolbar(); rebuild(); commit(); drawChain();
  };
  $('#plChain').onchange = (e) => { const s = e.target.closest('select[data-item]'); if (!s) return; if (s.value) draft[s.dataset.item] = s.value; else delete draft[s.dataset.item]; drawChain(); };
  $('#plByp').onchange = (e) => {
    const h = e.target.dataset.h, u = e.target.dataset.use;
    if (h) { if (e.target.checked) hoff.delete(h); else hoff.add(h); }
    if (u !== undefined) { if (e.target.value) duse[u] = e.target.value; else delete duse[u]; }
    drawChain();
  };
  const modNote = () => {
    const m = G.modules[dmods.mod];
    $('#plModNote').textContent = !m ? 'Pick a module to fill every building with it.' : (m.effect.productivity > 0 ? `${m.label} goes into every building whose recipe allows productivity (intermediates); the rest stay empty.` : `${m.label} goes into every building that accepts it.`) + (+dmods.bc > 0 && dmods.bmod ? ` Each building is reached by ${+dmods.bc} beacon${+dmods.bc > 1 ? 's' : ''} with ${G.modules[dmods.bmod].label}.` : '');
  };
  modNote();
  const modsChanged = (e) => {
    const id = e.target.id, v = e.target.value;
    if (id === 'plMod') dmods.mod = v;
    if (id === 'plModQ') dmods.modq = v;
    if (id === 'plBc') dmods.bc = Math.max(0, +v || 0);
    if (id === 'plBMod') dmods.bmod = v;
    if (id === 'plBModQ') dmods.bmodq = v;
    modNote(); drawChain();
  };
  for (const id of ['plMod', 'plModQ', 'plBc', 'plBMod', 'plBModQ']) { const el = document.getElementById(id); if (el) el.addEventListener(id === 'plBc' ? 'input' : 'change', modsChanged); }
  $('#plPlanet').onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    dlgPlanet = b.dataset.p;
    $('#plPlanet').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    drawChain();
  };
  $('#plCancel').onclick = closeModal;
  $('#plGo').onclick = () => {
    const goal = live();
    if (!goal.length) { $('#plMsg').textContent = 'Enter a rate above zero for at least one product.'; return; }
    if (dlgPlanet !== S.viewPlanet) switchCanvas(dlgPlanet, true);
    const label = goal.length === 1 ? item(goal[0].item).label : goal.map((t) => item(t.item).label).join(' + ').slice(0, 60);
    const dest = $('#plDest').value;
    if (dest === 'new') setActive(newOutpost(label, dlgPlanet).id);
    else {
      const o = outpost(+dest);
      const gone = new Set(S.nodes.filter((n) => n.outpost === o.id).map((n) => n.id));
      S.nodes = S.nodes.filter((n) => !gone.has(n.id));
      S.edges = S.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
      o.planet = dlgPlanet;
      if (!gone.size || /^(Main|Outpost \d+)$/.test(o.name)) o.name = label;
      setActive(o.id);
    }
    if (S.name === 'New factory') { S.name = label; $('#fname').value = S.name; }
    S.prefs = draft;
    S.helpersOff = [...hoff];
    S.leftoverUse = duse;
    S.planMods = dmods.mod || (+dmods.bc > 0 && dmods.bmod) ? { ...dmods } : null;
    S.lastPlan = { items: goal.map((t) => ({ ...t })) };
    const oy = S.nodes.length ? bounds().y1 + 160 : 0;
    withPlanet(() => buildChain(goal, null, draft));
    outpost(S.active).plan = { items: goal.map((t) => ({ ...t })), prefs: { ...draft }, helpersOff: [...hoff], uses: { ...duse }, mods: S.planMods };
    closeModal(); rebuild(); arrange(); commit(); focusOutpost(S.active);
  };
}

function buildingGroupsHTML() {
  const kinds = { craft: 'Crafting machines', mine: 'Mining drills', pump: 'Pumps' };
  return Object.entries(kinds).map(([k, label]) => {
    const ms = Object.values(G.machines).filter((m) => m.kind === k && !m.hidden).sort((a, b) => a.speed - b.speed || a.label.localeCompare(b.label));
    return ms.length ? `<div class="sec">${label}</div><div class="mgrid">${ms.map((m) => `<label class="unlock">${ic(m.icon, m.label)}<input type="checkbox" data-m="${m.name}" ${settings.disabled.includes(m.name) ? '' : 'checked'}> ${esc(m.label)}</label>`).join('')}</div>` : '';
  }).join('');
}
function onBuildingToggle(e) {
  const m = e.target.dataset.m;
  if (!m) return;
  settings.disabled = e.target.checked ? settings.disabled.filter((x) => x !== m) : [...settings.disabled, m];
  saveSettings(); localCache = {}; rebuild();
  recalcSoon('Buildings changed');
}
function openBuildings(after) {
  modal('Unlocked buildings', `
    <div class="note">Tick the buildings you have unlocked. Recipes that need a locked building are hidden when adding nodes, and the planner only uses ticked buildings.</div>
    <div style="display:flex;gap:8px"><button class="btn" id="ubAll">Tick all</button><button class="btn" id="ubBasic">Early game only</button></div>
    <div id="ubList">${buildingGroupsHTML()}</div>`, { wide: true, footer: '<button class="btn primary" id="ubDone">Done</button>' });
  $('.dlg').addEventListener('change', onBuildingToggle);
  const setAll = (keep) => { settings.disabled = Object.values(G.machines).filter((m) => !keep(m)).map((m) => m.name); saveSettings(); localCache = {}; $('#ubList').innerHTML = buildingGroupsHTML(); rebuild(); recalcSoon('Buildings changed'); };
  $('#ubAll').onclick = () => setAll(() => true);
  $('#ubBasic').onclick = () => setAll((m) => ['stone-furnace', 'burner-mining-drill', 'assembling-machine-1', 'electric-mining-drill', 'offshore-pump'].includes(m.name));
  $('#ubDone').onclick = () => { closeModal(); if (after) after(); };
}
function openSettings() {
  modal('Settings', `
    <div class="sec">Buildings</div>
    <div><button class="btn" id="stBuild">Choose unlocked buildings…</button> <span class="note">${Object.values(G.machines).filter((m) => !m.hidden && !settings.disabled.includes(m.name)).length} unlocked</span></div>
    <label class="chk"><input type="checkbox" id="stEff" ${settings.efficient ? 'checked' : ''}> Plan with the most efficient recipes (least raw resources, loops allowed). Off: simplest recipe for each item</label>
    <div class="chk"><label for="stRecalc">When unlocked buildings or a planet change:</label><select id="stRecalc"><option value="replan" ${settings.recalcMode !== 'swap' ? 'selected' : ''}>Re-plan outposts for the same products</option><option value="swap" ${settings.recalcMode === 'swap' ? 'selected' : ''}>Only swap buildings (keep my layout)</option></select></div>
    <label class="chk"><input type="checkbox" id="stArr" ${settings.autoArrange ? 'checked' : ''}> Arrange the factory automatically after changes (off: nodes stay where you put them)</label>
    <label class="chk"><input type="checkbox" id="stLeft" ${settings.useLeftovers ? 'checked' : ''}> Use up leftovers when something in the factory can consume them (e.g. crack all light and heavy oil)</label>
    <label class="chk"><input type="checkbox" id="stAssume" ${settings.assumeInputs ? 'checked' : ''}> Treat unconnected inputs as supplied (machines run as if the input arrives from outside)</label>
    <label class="chk"><input type="checkbox" id="stAuto" ${settings.autoBalance ? 'checked' : ''}> Auto-balance: resize machines and supplies whenever the factory changes</label>
    <label class="chk"><input type="checkbox" id="stAux" ${settings.showAux ? 'checked' : ''}> Show recycling and barrel recipes when adding nodes</label>
    <div class="sec">Updates</div>
    <div><span class="note" id="stVer"></span> <button class="btn" id="stUpd">Check for updates</button></div>
    <div class="sec">Game data</div>
    <div class="note">Factorio ${esc(G.factorioVersion || '?')} · ${esc((G.mods || []).join(', '))} · imported ${esc(new Date(G.importedAt).toLocaleString())}<br>${Object.keys(G.recipes).length} recipes, ${Object.keys(G.items).length} items, ${G.planets.length} planets</div>
    <div><button class="btn" id="stImport">Re-import from Factorio…</button></div>`, { wide: true });
  $('.dlg').addEventListener('change', (e) => {
    if (e.target.id === 'stAux') { settings.showAux = e.target.checked; saveSettings(); }
    if (e.target.id === 'stAuto') { setAuto(e.target.checked); }
    if (e.target.id === 'stRecalc') { settings.recalcMode = e.target.value; saveSettings(); }
    if (e.target.id === 'stArr') { settings.autoArrange = e.target.checked; saveSettings(); if (settings.autoArrange) { arrange(); commit(); } }
    if (e.target.id === 'stLeft') { settings.useLeftovers = e.target.checked; saveSettings(); autoBalance(); rebuild(); commit(); }
    if (e.target.id === 'stEff') { settings.efficient = e.target.checked; saveSettings(); }
    if (e.target.id === 'stAssume') { settings.assumeInputs = e.target.checked; saveSettings(); autoBalance(); rebuild(); commit(); }
  });
  $('#stBuild').onclick = () => openBuildings(openSettings);
  window.ffp.getVersion().then((v) => { const el = $('#stVer'); if (el) el.textContent = 'Version ' + v; });
  $('#stUpd').onclick = () => window.ffp.checkUpdates();
  $('#stImport').onclick = () => { closeModal(); showImport(true); };
}

/* ---------- Game data import screen ---------- */
async function showImport(cancelable) {
  const w = $('#welcome');
  w.hidden = false;
  let exe = await window.ffp.detectFactorio();
  const draw = (busy = false) => {
    w.innerHTML = `<div class="wbox">
      <h1>Factorio <span>Flow Planner</span></h1>
      <p>The planner reads recipes, machines, planets and icons straight from your own copy of Factorio, so the numbers always match your game version and enabled mods (including Space Age).</p>
      <div class="field"><span class="lbl">Factorio</span><div class="path">${exe ? esc(exe) : 'Not found automatically. Choose factorio.exe below.'}</div></div>
      <p class="note">Close the game first. Importing runs Factorio twice in the background: once to export data, once to render icons (a window may appear for up to a minute).</p>
      <div class="wbtns">
        <button class="btn primary" id="wImport" ${exe && !busy ? '' : 'disabled'}>Import game data</button>
        <button class="btn" id="wBrowse" ${busy ? 'disabled' : ''}>Choose factorio.exe…</button>
        <button class="btn" id="wDump" ${busy ? 'disabled' : ''}>Use a data-raw-dump.json…</button>
        ${cancelable && !busy ? '<button class="btn" id="wCancel" style="margin-left:auto">Cancel</button>' : ''}
      </div>
      <div class="wpack ${exe ? '' : 'first'}">
        <div><b>No Factorio on this PC?</b> Someone who has it can use <b>Game data → Export game data</b> in their planner and send you the file. Open that file here and everything works without the game.</div>
        <button class="btn ${exe ? '' : 'primary'}" id="wPack" ${busy ? 'disabled' : ''}>Use a game data file…</button>
      </div>
      <div class="log" id="wLog" ${busy || w.dataset.log ? '' : 'hidden'}>${w.dataset.log || ''}</div>
    </div>`;
    $('#wImport').onclick = () => run(() => window.ffp.importGameData(exe));
    $('#wBrowse').onclick = async () => { const p = await window.ffp.browseFactorio(); if (p) { exe = p; draw(); } };
    $('#wDump').onclick = () => run(() => window.ffp.importDumpFile());
    $('#wPack').onclick = () => run(() => window.ffp.importGamePack());
    if ($('#wCancel')) $('#wCancel').onclick = () => { w.hidden = true; };
  };
  const log = (m, cls = '') => { w.dataset.log = (w.dataset.log || '') + `<div class="${cls}">${esc(m)}</div>`; const l = $('#wLog'); if (l) { l.hidden = false; l.innerHTML = w.dataset.log; l.scrollTop = 1e9; } };
  showImport.log = log;
  const run = async (fn) => {
    w.dataset.log = '';
    draw(true);
    const res = await fn();
    if (res.canceled) { draw(); return; }
    if (!res.ok) { log(res.error, 'err'); draw(); return; }
    w.dataset.log = '';
    w.hidden = true;
    startWith(res.model);
    toast('Game data imported');
  };
  draw();
}
window.ffp.onImportProgress((m) => showImport.log && showImport.log(m));

/* ---------- Toolbar & menu ---------- */
function syncToolbar() {
  $('#fname').value = S.name || '';
  document.querySelectorAll('.seg [data-u]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.u === S.unit));
  $('#planets').innerHTML = G.planets.map((p) => { const k = (S.outposts || []).filter((o) => o.planet === p.name).length; return `<button data-p="${p.name}" aria-pressed="${p.name === S.viewPlanet}" title="${esc(p.label)} canvas · ${k} outpost${k === 1 ? '' : 's'}">${ic(p.icon, p.label, 'sm')}<span class="lbltxt">${esc(p.label)}</span>${k ? `<span class="pcount">${k}</span>` : ''}</button>`; }).join('');
}
$('#planets').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) switchCanvas(b.dataset.p); });
document.querySelector('.seg').addEventListener('click', (e) => { const b = e.target.closest('[data-u]'); if (!b) return; S.unit = b.dataset.u; syncToolbar(); rebuild(); commit(); });
$('#fname').addEventListener('input', (e) => { S.name = e.target.value; commit(); });
$('#bPlan').onclick = openPlan;
$('#eaPlan').onclick = openPlan;
$('#bAdd').onclick = openAddCentered;
$('#eaAdd').onclick = openAddCentered;
$('#bFit').onclick = fitView;
$('#bArrange').onclick = () => { arrange(); commit(); fitView(); };
$('#bSettings').onclick = openSettings;
$('#opAdd').onclick = () => { const o = newOutpost(null, S.viewPlanet); setActive(o.id); rebuild(); drawEdges(); focusOutpost(o.id); commit(); toast(`Added ${o.name}. Plan production or add nodes to fill it.`); };
$('#opothers').addEventListener('click', (e) => { const b = e.target.closest('[data-goto-planet]'); if (b) switchCanvas(b.dataset.gotoPlanet); });
$('#oplist').addEventListener('click', (e) => {
  const row = e.target.closest('.op');
  if (!row) return;
  const id = +row.dataset.op, act = e.target.closest('[data-opact]')?.dataset.opact;
  if (act === 'hide') { const o = outpost(id); o.hidden = !o.hidden; if (o.hidden) selected.clear(); rebuild(); commit(); return; }
  if (act === 'del') {
    if (S.outposts.length === 1) { toast('Keep at least one outpost. Delete its nodes instead.'); return; }
    deleteOutpost(id);
    return;
  }
  setActive(id, true);
});
$('#oplist').addEventListener('contextmenu', (e) => { const row = e.target.closest('.op'); if (!row) return; e.preventDefault(); openOutpostMenu(+row.dataset.op, e.clientX, e.clientY); });
$('#oplist').addEventListener('dblclick', (e) => { const n = e.target.closest('.opname'); if (n) renameOutpost(+n.closest('.op').dataset.op, n); });
$('#bOutposts').onclick = () => { const p = $('#opanel'); p.hidden = !p.hidden; try { localStorage.setItem('ffp-opanel', p.hidden ? '0' : '1'); } catch {} requestAnimationFrame(drawEdges); };
function setAuto(on) {
  settings.autoBalance = on; saveSettings();
  $('#bAuto').setAttribute('aria-pressed', on);
  if (on) { balanceAll(); rebuild(); commit(); toast('Auto-balance on: machines resize when the factory changes'); }
  else toast('Auto-balance off');
}
$('#bAuto').onclick = () => setAuto(!settings.autoBalance);
$('#bAuto').setAttribute('aria-pressed', settings.autoBalance);
$('#bSide').onclick = () => { const s = $('#side'); s.hidden = !s.hidden; renderSide(); try { localStorage.setItem('ffp-side', s.hidden ? '0' : '1'); } catch {} requestAnimationFrame(drawEdges); };
$('#side').addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (!g) return;
  const n = node(+g.dataset.goto), r = canvas.getBoundingClientRect();
  selected = new Set([n.id]); markSel();
  view.x = r.width / 2 - (n.x + 142) * view.k; view.y = r.height / 2 - (n.y + 120) * view.k;
  applyView(); drawEdges();
});
function doBalance() { balanceAll(); rebuild(); commit(); toast('Machines and resources sized to demand'); }

async function save(saveAs) {
  const r = await window.ffp.saveFile(JSON.stringify({ ...S, view }, null, 1), saveAs, S.name);
  if (r) toast(r.fresh ? `Saved to ${r.path.replace(/^.*?(Documents|Dokument)/, '$1')}` : 'Saved');
  return r;
}
function loadState(obj) {
  if (!obj || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) throw new Error('This file is not a factory layout.');
  const { view: v, ...st } = obj;
  S = { ...blankState(), ...st };
  if (!Array.isArray(st.outposts)) { S.outposts = undefined; S.active = undefined; }
  // Older saves have no canvas planet: open the canvas of the outpost that was in use.
  if (!st.viewPlanet) S.viewPlanet = (Array.isArray(st.outposts) && st.outposts.find((o) => o.id === st.active)?.planet) || st.planet || S.planet;
  S.next = Math.max(S.next || 1, ...S.nodes.map((n) => n.id + 1), ...S.edges.map((e) => e.id + 1));
  if (v) view = v;
  ensureOutposts();
}
window.ffp.onMenu(async (cmd) => {
  if (!G && cmd !== 'import' && cmd !== 'importPack') return;
  const typing = document.activeElement && document.activeElement.closest('input,textarea');
  switch (cmd) {
    case 'new': S = blankState(); ensureOutposts(); selected.clear(); window.ffp.newFile(); syncToolbar(); rebuild(); commit(); window.ffp.setDirty(false); break;
    case 'open': {
      const f = await window.ffp.openFile();
      if (!f) return;
      try { loadState(JSON.parse(f.text)); } catch (err) { toast(err.message || 'Could not read that file.'); return; }
      syncToolbar(); applyView(); rebuild(); resetHistory(); autosave(); window.ffp.setDirty(false);
      break;
    }
    case 'save': await save(false); break;
    case 'saveAs': await save(true); break;
    case 'showFile': window.ffp.showFile(); break;
    case 'save-then-close': if (await save(false)) window.ffp.closeNow(); break;
    case 'undo': if (typing) document.execCommand('undo'); else undo(-1); break;
    case 'redo': if (typing) document.execCommand('redo'); else undo(1); break;
    case 'plan': openPlan(); break;
    case 'add': openAddCentered(); break;
    case 'balance': doBalance(); break;
    case 'fit': fitView(); break;
    case 'arrange': arrange(); commit(); fitView(); break;
    case 'import': closeModal(); showImport(!!G); break;
    case 'importPack': {
      const r = await window.ffp.importGamePack();
      if (r.ok) { $('#welcome').hidden = true; startWith(r.model); toast('Game data loaded'); } else if (!r.canceled) toast(r.error);
      break;
    }
    case 'exportPack': {
      const r = await window.ffp.exportGamePack();
      if (r.ok) toast(`Saved game data (${(r.bytes / 1048576).toFixed(1)} MB). Send that file to whoever needs it.`); else if (!r.canceled) toast(r.error);
      break;
    }
    case 'settings': openSettings(); break;
    case 'buildings': openBuildings(); break;
  }
});

/* ---------- Updates ---------- */
window.ffp.onUpdate((kind, version) => {
  if (kind === 'none') { toast(`You have the latest version (${version})`); return; }
  if (kind === 'failed') { toast('The update could not start: ' + version); const g = $('#upGo'); if (g) { g.disabled = false; g.textContent = 'Restart and update'; } return; }
  if (kind === 'downloading') { const g = $('#upGo'); if (g) g.textContent = 'Downloading…'; return; }
  if (kind === 'dev') { toast(`Running from source (${version}); updates apply to the installed app`); return; }
  const b = $('#update');
  if (!b.hidden && b.dataset.v === version) return;
  b.dataset.v = version;
  b.innerHTML = `<b>Version ${esc(version)} is ready</b><span class="note">Your factory is kept. The planner closes, updates and opens again in a few seconds.</span><div class="row-btns"><button class="btn primary" id="upGo">Restart and update</button><button class="btn" id="upLater">Later</button></div>`;
  b.hidden = false;
  $('#upGo').onclick = () => {
    // Write the session out immediately so it is restored after the restart.
    try { localStorage.setItem('ffp-autosave', JSON.stringify({ S, view })); } catch {}
    $('#upGo').disabled = true; $('#upGo').textContent = 'Updating…';
    window.ffp.installUpdate();
  };
  $('#upLater').onclick = () => { b.hidden = true; };
});

/* ---------- Boot ---------- */
function startWith(model) {
  G = model;
  localCache = {};
  indexRecipes();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('ffp-autosave')); } catch {}
  try { loadState(saved && saved.S ? { ...saved.S, view: saved.view } : blankState()); } catch { S = blankState(); }
  if (!G.planets.some((p) => p.name === S.planet)) S.planet = G.planets[0]?.name;
  try { if (localStorage.getItem('ffp-side') === '0') $('#side').hidden = true; if (localStorage.getItem('ffp-opanel') === '0') $('#opanel').hidden = true; } catch {}
  syncToolbar(); applyView(); rebuild(); resetHistory();
  if (!saved && S.nodes.length) fitView();
}
(async () => {
  const model = await window.ffp.loadGameData();
  if (model) startWith(model);
  else showImport(false);
})();
