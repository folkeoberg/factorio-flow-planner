// Builds the model from an existing Factorio export without launching the game: node scripts/test-import.js
const path = require('path');
const { importFromDump, detectFactorio, installDirOf } = require('../src/gamedata');
const out = path.join(__dirname, '..', '.test-gamedata');
const so = path.join(process.env.APPDATA, 'Factorio', 'script-output');
const exe = detectFactorio();
importFromDump(path.join(so, 'data-raw-dump.json'), exe ? [path.join(installDirOf(exe), 'data')] : [], out, console.log).then((m) => {
  const r = (n) => m.recipes[n];
  console.log(JSON.stringify(r('casting-iron')));
  console.log(JSON.stringify(r('scrap-recycling').out.slice(0, 3)), r('scrap-recycling').label);
  console.log(r('iron-gear-wheel-recycling').label, r('iron-gear-wheel-recycling').aux, r('light-oil-cracking').label);
  console.log(JSON.stringify(m.machines.foundry), JSON.stringify(m.machines['big-mining-drill']));
  console.log(JSON.stringify(r('mine:uranium-ore')), JSON.stringify(r('pump:lava')));
  console.log(m.planets.map((p) => p.label + ':' + !!p.icon).join(', '));
  console.log(m.belts.map((b) => b.label + '=' + b.rate).join(', '));
  console.log(m.qualities.map((q) => q.label).join(', '), m.groups.map((g) => g.label).join(', '));
  console.log('mods', m.mods, 'no-icon items', Object.values(m.items).filter((i) => !i.icon).length, 'no-icon recipes', Object.values(m.recipes).filter((x) => !x.icon).length);
  console.log('pretty-fallback labels', Object.values(m.items).filter((i) => !/[A-Z]/.test(i.label[0])).slice(0, 5).map((i) => i.name + '=' + i.label));
  console.log(m.items['assembling-machine-1'].label, m.items['speed-module'].label, m.items['molten-iron'].label);
});
