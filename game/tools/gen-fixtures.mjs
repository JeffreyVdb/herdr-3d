#!/usr/bin/env node
// Writes the recorded-style bridge streams in game/fixtures/: one JSON line
// per protocol message, exactly what `herdr-world dump` prints on stdout (a
// world.snapshot, then events). The fixture server plays them over
// protocol v1. Deterministic: rerunning produces identical files.
//
//   node tools/gen-fixtures.mjs          # (re)write all fixtures
//   node tools/gen-fixtures.mjs --check  # exit 1 if a committed fixture is stale
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const uuid = (r) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;

// Original cute names, none from any film franchise.
const NAMES = [
  'Nibble', 'Pixel', 'Mochi', 'Sprocket', 'Biscuit', 'Noodle', 'Pip', 'Waffle', 'Bean', 'Tofu', 'Gizmo', 'Pebble',
  'Dumpling', 'Sprout', 'Tater', 'Bloop', 'Zippy', 'Fidget', 'Muffin', 'Nugget', 'Pickle', 'Taco', 'Wobble', 'Button',
  'Crumb', 'Doodle', 'Jellybean', 'Kiwi', 'Marble', 'Nacho', 'Olive', 'Peanut', 'Quibble', 'Ravioli', 'Scone', 'Tinker',
  'Umami', 'Velvet', 'Widget', 'Yeti', 'Ziggy', 'Bramble', 'Cobble', 'Dandy', 'Fizz', 'Gumdrop', 'Hopper', 'Inky',
  'Jumble', 'Kazoo', 'Lentil', 'Mango', 'Nimbus', 'Orzo', 'Pompom', 'Quokka', 'Rumble', 'Sesame', 'Truffle', 'Udon',
  'Vroom', 'Wasabi',
];

const T0 = 1790582400000; // 2026-09-28T08:00:00Z, the fixture's "now" is around here

/** harness, model, effort */
const MODELS = [
  ['claude', 'claude-opus-5-5', 'high'],
  ['claude', 'claude-opus-5-5', 'xhigh'],
  ['claude', 'claude-fable-5-1', 'medium'],
  ['codex', 'gpt-6-sol', 'high'],
  ['codex', 'gpt-6-luna', 'medium'],
  ['codex', 'gpt-6-astra', 'high'],
  ['claude', undefined, undefined],
];

function worker({ r, session, i, name, desk, status, title, label, model, cwd }) {
  const [harness, m, effort] = model ?? [undefined, undefined, undefined];
  const w = {
    id: uuid(r),
    session,
    workspace_id: `w${(i + 1).toString(36)}`,
    label,
    cwd,
    pane_id: `w${(i + 1).toString(36)}:p1`,
    status,
  };
  if (harness) {
    w.agent_kind = harness;
    w.agent_session = uuid(r);
  }
  if (title) w.title = title;
  w.name = name;
  w.desk_index = desk;
  if (harness) w.harness = harness;
  if (m) w.model = m;
  if (effort) w.effort = effort;
  w.status_since = T0 - Math.floor(r() * 3 * 3600_000);
  return w;
}

// ---- demo: 2 buildings, 3 floors, 40 workers --------------------------------

function demo() {
  const r = rng(3);
  const bWork = 'b_3f09a1c2d4e5';
  const bHome = 'b_77aa01b2c3d4';
  let n = 0;
  const nextName = () => NAMES[n++];

  const herdr = [
    ['ORCH|m2-city', 'working', 'Orchestrating M2: city and office floors', 0],
    ['CODE|m2-go|3|r1', 'working', 'Persist desk_index across bridge restarts', 3],
    ['CODE|m2-game|3|r1', 'working', 'Wire the look-at HUD to the prompt bar', 0],
    ['REVIEW|m2-go|3|r1', 'blocked', 'Allow `go test ./internal/store`?', 3],
    ['UX|m2-hud', 'working', 'Sketching the speech-bubble cards', 2],
    ['bridge-ws', 'done', 'Replay buffer handles since_seq edge cases', 1],
    ['helper-tunnel', 'working', 'Backoff when the ssh tunnel drops', 4],
    ['fixtures', 'idle', '', 6],
    ['desk-plan', 'working', 'Deterministic desk pods for 96 desks', 5],
    ['GROUND|m3-plan', 'blocked', 'Which building should new sessions join?', 1],
    ['perf', 'working', 'Profiling 240 workers on Metal', 0],
    ['docs', 'idle', '', 2],
    ['CODE|lobby|7|r2', 'done', 'Elevator doors open on arrival', 3],
    ['scratch', 'unknown', '', null],
    ['release', 'blocked', 'Tag v0.3.0 and push?', 0],
    ['audit-log', 'working', 'Audit every floor.assign command', 5],
    ['sprites', 'idle', 'Claude Code', 6],
    ['ci', 'working', 'Cache pnpm store in CI', 3],
  ];
  // 18 workers on desks 0..19 without 5 and 12: two free desks to hire into.
  const herdrDesks = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19];
  const workers = herdr.map(([label, status, title, model], i) =>
    worker({
      r, session: 'herdr-3d', i, name: nextName(), desk: herdrDesks[i], status, title, label,
      model: model === null ? undefined : MODELS[model], cwd: '/home/dev/devel/herdr-3d',
    }),
  );

  const infra = ['ec2-costs', 'savings-plan', 'patch-scan', 'sg-targets', 'dashboards', 'alerts', 's3-cleanup', 'gravityzone'];
  infra.forEach((label, i) =>
    workers.push(
      worker({ r, session: 'depot-manager', i, name: nextName(), desk: i, status: 'unknown', label, model: MODELS[i % 6], cwd: '/home/dev/devel/fomra/depot-manager' }),
    ),
  );

  const pastry = [
    ['brioche', 'working', 'Scale the levain for 2 kg of dough', 0],
    ['recipes-site', 'working', 'Add print styles to the recipe page', 3],
    ['timers', 'done', 'grill timer notifications ship', 2],
    ['shopping-list', 'idle', '', 4],
    ['croissants', 'working', 'Lamination schedule for Saturday', 1],
    ['pantry', 'idle', '', 5],
    ['nutrition', 'blocked', 'Which unit system for the label?', 3],
    ['photos', 'working', 'Resize the step photos to WebP', 6],
    ['menu-plan', 'idle', 'Claude Code', 0],
    ['bread-math', 'working', 'Baker percentages calculator', 2],
    ['inventory', 'done', 'Flour stock report is ready', 4],
    ['grill-log', 'idle', '', 5],
    ['cookbook', 'working', 'Typeset chapter 3: enriched doughs', 1],
    ['proofing', 'idle', '', 3],
  ];
  pastry.forEach(([label, status, title, model], i) =>
    workers.push(
      worker({ r, session: 'pastry', i, name: nextName(), desk: i, status, title, label, model: MODELS[model], cwd: '/home/dev/pastry' }),
    ),
  );

  const floors = [
    { session: 'herdr-3d', state: 'running', default: true, building: bWork, index: 0, desks: 20 },
    { session: 'depot-manager', state: 'asleep', building: bWork, index: 1, desks: 10 },
    { session: 'pastry', state: 'running', building: bHome, index: 0, desks: 16 },
  ];
  const seq = 1042;
  // Cloned: the scripted events below mutate the live worker objects.
  const snapshot = structuredClone({
    t: 'world.snapshot',
    seq,
    world: {
      buildings: [
        { id: bWork, name: 'Work', sort: 0, floors: ['herdr-3d', 'depot-manager'] },
        { id: bHome, name: 'Personal', sort: 1, floors: ['pastry'] },
      ],
      unassigned: [],
      floors,
      workers,
    },
  });

  const byName = (name) => workers.find((w) => w.name === name);
  const nibble = byName('Nibble');
  const mochi = byName('Mochi');
  const release = workers.find((w) => w.label === 'release');
  const proofing = workers.find((w) => w.label === 'proofing');
  let s = seq;
  const at = (k) => T0 + 60_000 + k * 3000;
  const status = (w, next, title, k) => {
    const ev = { t: 'worker.status', seq: ++s, id: w.id, session: w.session, workspace_id: w.workspace_id, status: next, prev_status: w.status, status_since: at(k) };
    if (title !== undefined) ev.title = title;
    w.status = next;
    return ev;
  };
  const hired = worker({
    r, session: 'herdr-3d', i: 18, name: 'Gumdrop', desk: 5, status: 'working', title: 'Warming up: reading CONTRIBUTING.md',
    label: 'CODE|m2-game|3|r2', model: MODELS[2], cwd: '/home/dev/devel/herdr-3d',
  });
  hired.status_since = at(2);
  const events = [
    status(nibble, 'done', 'Orchestrating M2: both coders reported', 0),
    status(release, 'working', 'Tagging v0.3.0', 1),
    { t: 'worker.upsert', seq: ++s, worker: hired },
    { t: 'floor.upsert', seq: ++s, floor: { ...floors[0], desks: 21 } },
    status(mochi, 'working', 'Wire the look-at HUD: desk prompts', 3),
    { t: 'worker.removed', seq: ++s, id: proofing.id, session: 'pastry', workspace_id: proofing.workspace_id },
    { t: 'floor.upsert', seq: ++s, floor: { ...floors[2], desks: 15 } },
    status(byName('Pip'), 'working', 'Profiling 240 workers on Metal', 5),
  ];
  return [snapshot, ...events];
}

// ---- demo-m3: the demo city as an M3 bridge sends it ---------------------------
// Floor settings and suggestions, hire options, and a floor in the unassigned
// lot. For the simulating fixture server (`?sim=1`), so no recorded events.

function demoM3() {
  const [base] = demo();
  const snap = structuredClone(base);
  const r = rng(33);
  const w = snap.world;
  w.hire_options = {
    claude: { models: ['claude-opus-5-5', 'claude-fable-5-1'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    codex: {
      models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      extra_efforts: { 'gpt-6-sol': ['ultra'], 'gpt-6-astra': ['ultra'] },
    },
  };
  const floor = (s) => w.floors.find((f) => f.session === s);
  floor('herdr-3d').suggested = { repo: 'JeffreyVdb/herdr-3d', default_cwd: '/home/dev/devel/herdr-3d' };
  Object.assign(floor('depot-manager'), {
    settings: { repo: 'fomra/depot-manager', default_hire: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
    suggested: { repo: 'fomra/depot-manager', default_cwd: '/home/dev/devel/fomra/depot-manager' },
  });
  const cwd = '/home/dev/scratch';
  const lot = [
    ['notes', 'idle', '', undefined, 'Hopper'],
    ['spike-webgpu', 'working', 'Try the TSL outline pass', MODELS[0], 'Inky'],
    ['changelog', 'done', 'Changelog for v0.3.0 drafted', MODELS[4], 'Jumble'],
  ];
  lot.forEach(([label, status, title, model, name], i) =>
    w.workers.push(worker({ r, session: 'scratchpad', i, name, desk: i, status, title, label, model, cwd })),
  );
  w.unassigned = ['scratchpad'];
  w.floors.push({ session: 'scratchpad', state: 'running', building: null, index: null, desks: 6 });
  return [snap];
}

// ---- demo-m3b: three floors in one building ------------------------------------
// The M3 city with every floor in Work: herdr-3d on top (running), depot-manager
// in the middle (asleep), pastry at the bottom (running); Personal is empty and
// scratchpad stays in the lot. Walks the fire escape past all three.

function demoM3b() {
  const [base] = demoM3();
  const snap = structuredClone(base);
  const w = snap.world;
  const work = w.buildings.find((b) => b.name === 'Work');
  const home = w.buildings.find((b) => b.name === 'Personal');
  // Top to bottom, like the bridge: `floors` lists them in `index` order, index 0 on top.
  work.floors = ['herdr-3d', 'depot-manager', 'pastry'];
  home.floors = [];
  const floor = (s) => w.floors.find((f) => f.session === s);
  work.floors.forEach((s, index) => Object.assign(floor(s), { building: work.id, index }));
  return [snap];
}

// ---- perf: one floor with 60 workers ------------------------------------------

const STATES = ['working', 'working', 'working', 'working', 'idle', 'done', 'blocked', 'working', 'idle', 'working'];
const TASKS = [
  'Refactor the hub fan-out', 'Write vitest for the world store', 'Fix the flaky reconnect test', 'Profile the city view',
  'Review the desk assignment PR', 'Port the helper to launchd', 'Tune shadow cascades', 'Update protocol.md',
  'Chase a seq gap in replay', 'Draft the M3 building menu',
];

function floorOf(r, session, count, nameBase) {
  return Array.from({ length: count }, (_, i) =>
    worker({
      r, session, i, name: NAMES[(i + nameBase) % NAMES.length] + (i + nameBase >= NAMES.length ? ` ${Math.floor((i + nameBase) / NAMES.length) + 1}` : ''),
      desk: i, status: STATES[(i * 7 + nameBase) % STATES.length], title: TASKS[(i * 3 + nameBase) % TASKS.length],
      label: `worker-${i + 1}`, model: MODELS[(i + nameBase) % MODELS.length], cwd: `/srv/${session}`,
    }),
  );
}

function perfFloor60() {
  const r = rng(60);
  const b = 'b_perf00000060';
  const workers = floorOf(r, 'perf-floor', 60, 0);
  return [
    {
      t: 'world.snapshot',
      seq: 1,
      world: {
        buildings: [{ id: b, name: 'Perf', sort: 0, floors: ['perf-floor'] }],
        unassigned: [],
        floors: [{ session: 'perf-floor', state: 'running', building: b, index: 0, desks: 62 }],
        workers,
      },
    },
  ];
}

// ---- perf: the engine-bench city, 5 buildings / 30 floors / 240 workers -------

function perfCity240() {
  const r = rng(240);
  const per = [8, 6, 7, 4, 5];
  const buildings = [];
  const floors = [];
  const workers = [];
  let k = 0;
  per.forEach((nf, bi) => {
    const id = `b_perf0000000${bi}`;
    const sessions = Array.from({ length: nf }, (_, f) => `tower-${'abcde'[bi]}-${nf - f}`);
    buildings.push({ id, name: `Tower ${'ABCDE'[bi]}`, sort: bi, floors: sessions });
    sessions.forEach((session, f) => {
      floors.push({ session, state: 'running', building: id, index: f, desks: 10 });
      workers.push(...floorOf(r, session, 8, k));
      k += 8;
    });
  });
  return [{ t: 'world.snapshot', seq: 1, world: { buildings, unassigned: [], floors, workers } }];
}

const FIXTURES = { demo, 'demo-m3': demoM3, 'demo-m3b': demoM3b, 'perf-floor60': perfFloor60, 'perf-city240': perfCity240 };

const check = process.argv.includes('--check');
let stale = false;
mkdirSync(OUT, { recursive: true });
for (const [name, gen] of Object.entries(FIXTURES)) {
  const text = gen().map((m) => JSON.stringify(m)).join('\n') + '\n';
  const path = join(OUT, `${name}.jsonl`);
  if (check) {
    let cur = '';
    try {
      cur = readFileSync(path, 'utf8');
    } catch {}
    if (cur !== text) {
      console.error(`stale fixture: ${path}`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
