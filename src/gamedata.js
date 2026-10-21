// Finds Factorio, runs its data/icon exports, and turns data.raw into the compact model the planner uses.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');

const MODEL_VERSION = 1;
const STEAM_APP_ID = '427520';

// Lua empty tables are dumped as {} and arrays as [], so normalise everything list-like.
const A = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
const pretty = (n) => n.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/* ---------- Locating the game ---------- */

function steamLibraries() {
  const roots = ['C:/Program Files (x86)/Steam', 'C:/Program Files/Steam'];
  const libs = new Set();
  for (const root of roots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(root);
    const text = fs.readFileSync(vdf, 'utf8');
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  return [...libs];
}

function detectFactorio(saved) {
  const candidates = [];
  if (saved) candidates.push(saved);
  for (const lib of steamLibraries()) candidates.push(path.join(lib, 'steamapps', 'common', 'Factorio', 'bin', 'x64', 'factorio.exe'));
  candidates.push('C:/Program Files/Factorio/bin/x64/factorio.exe');
  for (const d of 'DEFGH') candidates.push(`${d}:/SteamLibrary/steamapps/common/Factorio/bin/x64/factorio.exe`, `${d}:/Factorio/bin/x64/factorio.exe`);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const installDirOf = (exe) => path.resolve(path.dirname(exe), '..', '..');

function runFactorio(exe, args, onLine) {
  return new Promise((resolve, reject) => {
    // Setting the app id stops the Steam build from relaunching itself through Steam (which drops our arguments).
    const p = spawn(exe, args, {
      cwd: path.dirname(exe),
      env: { ...process.env, SteamAppId: STEAM_APP_ID, SteamGameId: STEAM_APP_ID },
    });
    let out = '';
    const take = (d) => {
      const s = String(d);
      out += s;
      if (onLine) s.split(/\r?\n/).forEach((l) => l.trim() && onLine(l.trim()));
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', reject);
    p.on('close', (code) => {
      if (/another instance/i.test(out)) return reject(new Error('Factorio is already running. Close the game and try again.'));
      if (code !== 0) return reject(new Error('Factorio exited with an error:\n' + out.trim().split(/\r?\n/).slice(-6).join('\n')));
      resolve(out);
    });
  });
}

function writeDirFromLog(log, exe) {
  const m = log.match(/Write data path:\s*(.+?)\s*\[/);
  if (m) return path.normalize(m[1]);
  const portable = path.join(installDirOf(exe), 'script-output');
  return fs.existsSync(portable) ? installDirOf(exe) : path.join(process.env.APPDATA || '', 'Factorio');
}

/* ---------- Locale ---------- */

function parseCfg(text, into) {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    if (line[0] === '[' && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    const eq = line.indexOf('=');
    if (eq > 0) into[(section ? section + '.' : '') + line.slice(0, eq)] = line.slice(eq + 1);
  }
}

function readLocale(dirs) {
  const loc = {};
  const order = ['core', 'base', 'elevated-rails', 'quality', 'space-age'];
  for (const root of dirs) {
    if (!root || !fs.existsSync(root)) continue;
    const mods = fs.readdirSync(root).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    for (const mod of mods) {
      const dir = path.join(root, mod, 'locale', 'en');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.cfg')) parseCfg(fs.readFileSync(path.join(dir, f), 'utf8'), loc);
    }
  }
  return loc;
}

/* ---------- Model ---------- */

function parsePower(s) {
  if (typeof s === 'number') return s * 60;
  const m = String(s || '').match(/^([\d.]+)\s*([kMGT]?)W$/);
  if (!m) return 0;
  return +m[1] * { '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]];
}

function buildModel(raw, loc, iconSrc, iconDest, meta = {}) {
  const L = (ls) => {
    if (ls == null) return null;
    if (typeof ls === 'string' || typeof ls === 'number') return String(ls);
    const a = A(ls);
    if (!a.length) return null;
    if (a[0] === '') return a.slice(1).map(L).join('');
    let s = loc[a[0]];
    if (s == null) return null;
    s = s.replace(/__(\d+)__/g, (_, i) => L(a[+i]) ?? '');
    return expand(s);
  };
  const expand = (s) => s.replace(/__(ITEM|FLUID|ENTITY|RECIPE|TILE)__([\w-]+)__/g, (_, t, n) => loc[t.toLowerCase() + '-name.' + n] || pretty(n));

  // Copy each icon we reference into the app's own data folder.
  const copied = new Set();
  const icon = (kind, name) => {
    if (!iconSrc) return null;
    const rel = `${kind}/${name}.png`;
    if (copied.has(rel)) return rel;
    const src = path.join(iconSrc, kind, name + '.png');
    if (!fs.existsSync(src)) return null;
    if (iconDest) {
      fs.mkdirSync(path.join(iconDest, kind), { recursive: true });
      fs.copyFileSync(src, path.join(iconDest, rel));
    }
    copied.add(rel);
    return rel;
  };

  const groups = raw['item-group'] || {}, subgroups = raw['item-subgroup'] || {};
  const sortKey = (subgroup, order, name) => {
    const sg = subgroups[subgroup] || {};
    const g = groups[sg.group] || {};
    return `${g.order || 'zz'}|${sg.order || 'zz'}|${order || 'zz'}|${name}`;
  };
  const groupOf = (subgroup) => (subgroups[subgroup] || {}).group || 'other';

  /* items & fluids */
  const items = {};
  const itemTypes = Object.keys(raw).filter((t) => Object.values(raw[t]).some((v) => v && v.stack_size !== undefined));
  for (const t of itemTypes) {
    for (const p of Object.values(raw[t])) {
      if (!p || p.stack_size === undefined || p.parameter) continue;
      const label = L(p.localised_name) || loc['item-name.' + p.name] || (p.place_result && loc['entity-name.' + p.place_result]) || loc['entity-name.' + p.name] || loc['equipment-name.' + p.name] || pretty(p.name);
      items[p.name] = { name: p.name, label, type: 'item', icon: icon('item', p.name), group: groupOf(p.subgroup), sort: sortKey(p.subgroup, p.order, p.name), hidden: !!p.hidden };
    }
  }
  for (const p of Object.values(raw.fluid || {})) {
    if (p.parameter) continue;
    const sg = p.subgroup || 'fluid';
    items[p.name] = { name: p.name, label: L(p.localised_name) || loc['fluid-name.' + p.name] || pretty(p.name), type: 'fluid', icon: icon('fluid', p.name), group: groupOf(sg), sort: sortKey(sg, p.order, p.name), hidden: !!p.hidden };
  }
  const ensureItem = (name, type) => {
    if (!items[name]) items[name] = { name, label: pretty(name), type: type === 'fluid' ? 'fluid' : 'item', icon: icon(type === 'fluid' ? 'fluid' : 'item', name), group: 'other', sort: 'zz|' + name, hidden: false };
  };

  /* recipes */
  const recipes = {};
  const addAmount = (list, n, a, ig, t) => {
    const ex = list.find((x) => x.n === n);
    if (ex) { ex.a += a; ex.ig += ig; } else list.push({ n, a, ig, t });
  };
  for (const r of Object.values(raw.recipe || {})) {
    if (r.parameter) continue;
    const results = A(r.results);
    if (!results.length) continue;
    const ins = [], outs = [];
    for (const i of A(r.ingredients)) { ensureItem(i.name, i.type); addAmount(ins, i.name, i.amount, 0, i.type); }
    for (const o of results) {
      ensureItem(o.name, o.type);
      const p = o.probability ?? 1;
      const base = o.amount ?? ((o.amount_min ?? 0) + (o.amount_max ?? 0)) / 2;
      const expected = base * p + (o.extra_count_fraction || 0);
      addAmount(outs, o.name, expected, Math.min(expected, (o.ignored_by_productivity || 0) * p), o.type);
    }
    const main = r.main_product ? r.main_product : outs.length === 1 ? outs[0].n : null;
    const category = r.category || 'crafting';
    const label = L(r.localised_name) || loc['recipe-name.' + r.name] || (main && items[main] && items[main].label) || pretty(r.name);
    // Auto-generated "<item> recycling" recipes are hidden; scrap recycling and similar are real production recipes.
    const recycling = r.name.endsWith('-recycling') && !!r.hidden;
    const barrel = /barrel/.test(r.name) && /^(fill|empty)-|-barrel$/.test(r.name) && r.subgroup && /barrel/.test(r.subgroup);
    const sub = r.subgroup || (main && raw.item && raw.item[main] && raw.item[main].subgroup) || (main && raw.fluid && raw.fluid[main] && (raw.fluid[main].subgroup || 'fluid')) || '';
    recipes[r.name] = {
      name: r.name, label, icon: icon('recipe', r.name) || (main && items[main] && items[main].icon) || null,
      time: r.energy_required ?? 0.5, category, in: ins, out: outs, main,
      allowProd: !!r.allow_productivity, maxProd: r.maximum_productivity ?? 3,
      conditions: A(r.surface_conditions).map((c) => ({ p: c.property, min: c.min, max: c.max })),
      hidden: !!r.hidden, aux: !!(recycling || barrel), recycling: !!recycling,
      group: sub ? groupOf(sub) : (main && items[main] ? items[main].group : 'other'),
      sort: sortKey(sub, r.order, r.name),
    };
  }

  /* machines */
  const machines = {};
  const machineBase = (p, kind) => ({
    name: p.name, kind,
    label: L(p.localised_name) || loc['entity-name.' + p.name] || pretty(p.name),
    icon: icon('entity', p.name) || icon('item', p.name),
    power: parsePower(p.energy_usage),
    burner: !!(p.energy_source && p.energy_source.type === 'burner'),
    baseProd: (p.effect_receiver && p.effect_receiver.base_effect && p.effect_receiver.base_effect.productivity) || 0,
    slots: p.module_slots || 0,
    allowed: p.allowed_effects ? A(p.allowed_effects) : ['speed', 'productivity', 'consumption', 'pollution', 'quality'],
    conditions: A(p.surface_conditions).map((c) => ({ p: c.property, min: c.min, max: c.max })),
    hidden: A(p.flags).includes('hidden') || !!p.hidden,
  });
  for (const t of ['assembling-machine', 'furnace', 'rocket-silo']) {
    for (const p of Object.values(raw[t] || {})) {
      if (!p.crafting_categories) continue;
      machines[p.name] = { ...machineBase(p, 'craft'), categories: A(p.crafting_categories), speed: p.crafting_speed || 1 };
    }
  }
  for (const p of Object.values(raw['mining-drill'] || {})) {
    machines[p.name] = { ...machineBase(p, 'mine'), categories: A(p.resource_categories).map((c) => 'mine:' + c), speed: p.mining_speed || 1 };
  }

  /* mining recipes (one per resource) */
  for (const r of Object.values(raw.resource || {})) {
    const m = r.minable;
    if (!m) continue;
    const res = m.results ? A(m.results) : m.result ? [{ name: m.result, amount: m.count || 1, type: 'item' }] : [];
    if (!res.length) continue;
    const outs = res.map((o) => { ensureItem(o.name, o.type); return { n: o.name, a: (o.amount ?? ((o.amount_min + o.amount_max) / 2)) * (o.probability ?? 1), ig: 0, t: o.type || 'item' }; });
    const ins = m.required_fluid ? [{ n: m.required_fluid, a: (m.fluid_amount || 0) / 10, ig: 0, t: 'fluid' }] : [];
    const fluid = outs[0].t === 'fluid';
    const resLabel = loc['entity-name.' + r.name] || items[outs[0].n].label;
    recipes['mine:' + r.name] = {
      name: 'mine:' + r.name, label: resLabel + (fluid ? ' extraction (100% yield)' : ' mining'), icon: items[outs[0].n].icon,
      time: m.mining_time || 1, category: 'mine:' + (r.category || 'basic-solid'), in: ins, out: outs, main: outs[0].n,
      allowProd: true, maxProd: 1e6, conditions: [], hidden: false, aux: false, recycling: false, mining: true,
      group: items[outs[0].n].group, sort: items[outs[0].n].sort,
    };
    items[outs[0].n].resource = true;
  }

  /* offshore pumps (one recipe per pumpable tile fluid) */
  const pump = Object.values(raw['offshore-pump'] || {})[0];
  if (pump) {
    machines[pump.name] = { ...machineBase(pump, 'pump'), categories: ['offshore'], speed: 1 };
    const fluids = [...new Set(Object.values(raw.tile || {}).map((t) => t.fluid).filter(Boolean))];
    for (const f of fluids) {
      ensureItem(f, 'fluid');
      items[f].resource = true;
      recipes['pump:' + f] = {
        name: 'pump:' + f, label: items[f].label + ' (offshore pump)', icon: items[f].icon, time: 1, category: 'offshore',
        in: [], out: [{ n: f, a: (pump.pumping_speed || 20) * 60, ig: 0, t: 'fluid' }], main: f,
        allowProd: false, maxProd: 0, conditions: [], hidden: false, aux: false, recycling: false, mining: true,
        group: items[f].group, sort: items[f].sort,
      };
    }
  }
  // Plants and asteroid chunks have no recipe that makes them; treat them as resources too.
  for (const p of Object.values(raw.plant || {})) for (const o of A(p.minable && p.minable.results)) if (items[o.name]) items[o.name].resource = true;
  for (const c of Object.keys(raw['asteroid-chunk'] || {})) if (items[c]) items[c].resource = true;

  /* modules, beacon, qualities, belts */
  const modules = {};
  for (const m of Object.values(raw.module || {})) {
    modules[m.name] = { name: m.name, label: items[m.name] ? items[m.name].label : pretty(m.name), icon: icon('item', m.name), effect: m.effect || {}, tier: m.tier || 1, category: m.category, sort: items[m.name] ? items[m.name].sort : m.name };
  }
  const b = (raw.beacon || {}).beacon || Object.values(raw.beacon || {})[0];
  const beacon = b ? { name: b.name, label: loc['entity-name.' + b.name] || 'Beacon', icon: icon('entity', b.name), eff: b.distribution_effectivity || 0.5, profile: A(b.profile).length ? A(b.profile) : [1], slots: b.module_slots || 2, power: parsePower(b.energy_usage), allowed: b.allowed_effects ? A(b.allowed_effects) : ['speed', 'consumption', 'pollution'] } : null;
  const qualities = Object.values(raw.quality || {})
    .filter((q) => q.name !== 'quality-unknown' && !q.hidden)
    .map((q) => ({ name: q.name, label: loc['quality-name.' + q.name] || pretty(q.name), level: q.level || 0, icon: icon('quality', q.name) }))
    .sort((a, b) => a.level - b.level);
  const belts = Object.values(raw['transport-belt'] || {})
    .filter((t) => !A(t.flags).includes('hidden') && !t.hidden)
    .map((t) => ({ name: t.name, label: loc['entity-name.' + t.name] || pretty(t.name), icon: icon('item', t.name) || icon('entity', t.name), rate: Math.round(t.speed * 480 * 1000) / 1000 }))
    .sort((a, b) => a.rate - b.rate);

  /* planets and surfaces */
  const defaults = {};
  for (const [k, v] of Object.entries(raw['surface-property'] || {})) defaults[k] = v.default_value ?? 0;
  const planets = [];
  for (const p of Object.values(raw.planet || {})) {
    if (p.hidden) continue;
    // What can be mined or pumped here, from the planet's map generation settings.
    const auto = (p.map_gen_settings && p.map_gen_settings.autoplace_settings) || {};
    const resources = new Set();
    for (const e of Object.keys((auto.entity && auto.entity.settings) || {})) {
      const r = (raw.resource || {})[e];
      if (r && r.minable) for (const o of r.minable.results ? A(r.minable.results) : [{ name: r.minable.result }]) resources.add(o.name);
    }
    for (const t of Object.keys((auto.tile && auto.tile.settings) || {})) { const f = raw.tile && raw.tile[t] && raw.tile[t].fluid; if (f) resources.add(f); }
    // Plants (Gleba) are placed through autoplace controls rather than entity settings.
    const controls = Object.keys((p.map_gen_settings && p.map_gen_settings.autoplace_controls) || {});
    for (const pl of Object.values(raw.plant || {})) {
      if (pl.autoplace && controls.includes(pl.autoplace.control)) for (const o of A(pl.minable && pl.minable.results)) resources.add(o.name);
    }
    planets.push({ name: p.name, label: loc['space-location-name.' + p.name] || pretty(p.name), icon: icon('space-location', p.name), props: { ...defaults, ...(p.surface_properties || {}) }, order: p.order || p.name, resources: [...resources] });
  }
  for (const s of Object.values(raw.surface || {})) {
    planets.push({ name: s.name, label: loc['surface-name.' + s.name] || pretty(s.name), icon: icon('surface', s.name), props: { ...defaults, ...(s.surface_properties || {}) }, order: 'zz' + s.name, resources: Object.keys(raw['asteroid-chunk'] || {}).filter((c) => items[c]) });
  }
  planets.sort((a, b) => (a.order < b.order ? -1 : 1));

  /* item groups (tabs in the add-node picker) */
  const groupList = Object.values(groups)
    .filter((g) => !g.hidden && Object.values(recipes).some((r) => r.group === g.name && !r.aux && !r.hidden))
    .map((g) => ({ name: g.name, label: loc['item-group-name.' + g.name] || pretty(g.name), icon: icon('item-group', g.name), order: g.order || '' }))
    .sort((a, b) => (a.order < b.order ? -1 : 1));

  return {
    version: MODEL_VERSION, importedAt: new Date().toISOString(), ...meta,
    items, recipes, machines, modules, beacon, qualities, belts, planets, groups: groupList,
  };
}

/* ---------- Full import ---------- */

async function importFromFactorio(exe, outDir, progress = () => {}) {
  if (!exe || !fs.existsSync(exe)) throw new Error('factorio.exe was not found at that location.');
  progress('Exporting prototype data from Factorio…');
  const log = await runFactorio(exe, ['--dump-data']);
  const ver = (log.match(/Factorio (\d+\.\d+\.\d+)/) || [])[1];
  const writeDir = writeDirFromLog(log, exe);
  const scriptOut = path.join(writeDir, 'script-output');
  const dumpPath = path.join(scriptOut, 'data-raw-dump.json');
  if (!fs.existsSync(dumpPath)) throw new Error('Factorio finished but no data-raw-dump.json appeared in ' + scriptOut);

  progress('Rendering item icons. Factorio may open a window for up to a minute…');
  const iconLog = await runFactorio(exe, ['--dump-icon-sprites'], (l) => { if (/Steam requires game restart/i.test(l)) progress('Steam asked to relaunch the game; continuing…'); });
  const haveIcons = fs.existsSync(path.join(scriptOut, 'item'));
  if (!haveIcons) progress('Icons could not be exported; the planner will use letter badges instead.');

  return finishImport(dumpPath, haveIcons ? scriptOut : null, [path.join(installDirOf(exe), 'data'), path.join(writeDir, 'mods')], outDir, progress, { factorioVersion: ver, iconLog: undefined, source: exe });
}

async function importFromDump(dumpPath, localeDirs, outDir, progress = () => {}) {
  const scriptOut = path.dirname(dumpPath);
  const icons = fs.existsSync(path.join(scriptOut, 'item')) ? scriptOut : null;
  return finishImport(dumpPath, icons, localeDirs, outDir, progress, { source: dumpPath });
}

async function finishImport(dumpPath, iconSrc, localeDirs, outDir, progress, meta) {
  progress('Reading recipes, machines and planets…');
  const raw = JSON.parse(await fs.promises.readFile(dumpPath, 'utf8'));
  const loc = readLocale(localeDirs);
  const tmp = outDir + '.new';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const mods = Object.keys(raw.recipe || {}).length ? detectMods(raw) : [];
  const model = buildModel(raw, loc, iconSrc, path.join(tmp, 'icons'), { ...meta, mods });
  fs.writeFileSync(path.join(tmp, 'gamedata.json'), JSON.stringify(model));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(tmp, outDir);
  progress(`Loaded ${Object.keys(model.recipes).length} recipes, ${Object.keys(model.items).length} items and ${model.planets.length} planets.`);
  return model;
}

function detectMods(raw) {
  const mods = new Set();
  const scan = (s) => { for (const m of String(s).matchAll(/__([\w-]+)__\//g)) mods.add(m[1]); };
  for (const r of Object.values(raw.recipe)) if (r.icon) scan(r.icon);
  for (const i of Object.values(raw.item || {})) if (i.icon) scan(i.icon);
  mods.delete('core');
  return [...mods].sort();
}

function loadModel(outDir) {
  const f = path.join(outDir, 'gamedata.json');
  if (!fs.existsSync(f)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    return m.version === MODEL_VERSION ? m : null;
  } catch {
    return null;
  }
}

/* ---------- Game data files (for people without Factorio) ----------
   One gzip-compressed file holding the imported model and every icon, so someone with Factorio can export it
   and someone without can import it. */
const PACK_FORMAT = 'ffp-gamedata';
function exportPack(dataDir, file) {
  const model = JSON.parse(fs.readFileSync(path.join(dataDir, 'gamedata.json'), 'utf8'));
  const icons = {};
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f), r = rel ? rel + '/' + f : f;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else if (f.endsWith('.png')) icons[r] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(path.join(dataDir, 'icons'), '');
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify({ format: PACK_FORMAT, version: 1, model, icons })), { level: 9 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { icons: Object.keys(icons).length, bytes: buf.length };
}
function importPack(file, outDir) {
  let data;
  try { data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch { throw new Error('That file is not a Factorio Flow Planner game data file.'); }
  if (data.format !== PACK_FORMAT || !data.model || !data.model.recipes) throw new Error('That file is not a Factorio Flow Planner game data file.');
  if (data.model.version !== MODEL_VERSION) throw new Error('That game data file was made by a different version of the planner. Ask for a new export.');
  const tmp = outDir + '.new';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'icons'), { recursive: true });
  for (const [rel, b64] of Object.entries(data.icons || {})) {
    // Only plain "folder/name.png" paths, so a file can never write outside the icons folder.
    if (!/^\w[\w.-]*\/\w[\w.-]*\.png$/.test(rel)) continue;
    const dest = path.join(tmp, 'icons', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
  }
  fs.writeFileSync(path.join(tmp, 'gamedata.json'), JSON.stringify(data.model));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(tmp, outDir);
  return data.model;
}

module.exports = { exportPack, importPack, detectFactorio, importFromFactorio, importFromDump, loadModel, buildModel, readLocale, installDirOf };
