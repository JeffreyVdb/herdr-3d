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
    claude: { models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
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

// ---- demo-m4: demo-m3b with git worktrees ------------------------------------
// For hire / send home on the simulating fixture server (`?sim=1`): some
// workers work in linked worktrees of their own (with a branch), one in the
// repo's main checkout. The simulator's rules make a `working` worker's tree
// dirty (uncommitted changes, unpushed commits) and everyone else clean.

function demoM4() {
  const [base] = demoM3b();
  const snap = structuredClone(base);
  const w = snap.world;
  const linked = (label, repo, dir, branch) => {
    const x = w.workers.find((v) => v.label === label);
    const checkout = `${repo}-wt/${dir}`;
    x.cwd = checkout;
    x.worktree = { repo_root: repo, repo_name: repo.split('/').pop(), checkout_path: checkout, linked: true };
    x.branch = branch;
  };
  const herdr = '/home/dev/devel/herdr-3d';
  linked('CODE|m2-go|3|r1', herdr, 'm2-go', 'h3d/pixel-m2-go');
  linked('CODE|m2-game|3|r1', herdr, 'm2-game', 'h3d/mochi-m2-game');
  // A branch of the user's own (the bridge did not make it): send-home keeps it.
  linked('bridge-ws', herdr, 'bridge-ws', 'dev/bridge-ws');
  linked('fixtures', herdr, 'fixtures', 'h3d/waffle-fixtures');
  const pastry = '/home/dev/pastry';
  linked('brioche', pastry, 'brioche', 'h3d/brioche-levain');
  linked('timers', pastry, 'timers', 'h3d/timers-notify');
  const docs = w.workers.find((v) => v.label === 'docs');
  docs.worktree = { repo_root: herdr, repo_name: 'herdr-3d', checkout_path: herdr, linked: false };
  return [snap];
}

// ---- demo-h58: demo-m4 with virtual floors (#58) -------------------------------
// The bridge's shape since #58: every floor has its id, name, base session and the virtual and hidden flags, every
// worker its floor. Work, top to bottom: herdr-3d, its virtual floor "Frontend" (two of herdr-3d's workers were hired
// there: their workspaces live in herdr-3d), depot-manager (asleep) and its virtual floor "Depot docs" (asleep with
// it, no workers), pastry, and pastry's hidden virtual floor "Archive" (no workers: no list shows it). scratchpad stays
// in the lot. For the simulating fixture server (`?sim=1`).

function demoH58() {
  const [base] = demoM4();
  const snap = structuredClone(base);
  const w = snap.world;
  const work = w.buildings.find((b) => b.name === 'Work');
  const FRONT = 'v-00000000f0e1';
  const DOCS = 'v-00000000f0e2';
  const ARCHIVE = 'v-00000000f0e3';
  const real = (f) => Object.assign(f, { id: f.session, name: f.session, base_session: f.session, virtual: false, hidden: false });
  const virtual = (id, name, session, state, hidden = false) => ({ id, name, session, base_session: session, virtual: true, hidden, state, building: work.id, index: 0, desks: 6 });
  const floors = w.floors.map((f) => ({ id: f.session, name: f.session, ...real(f) }));
  const at = (id) => floors.findIndex((f) => f.id === id);
  floors.splice(at('herdr-3d') + 1, 0, virtual(FRONT, 'Frontend', 'herdr-3d', 'running'));
  floors.splice(at('depot-manager') + 1, 0, virtual(DOCS, 'Depot docs', 'depot-manager', 'asleep'));
  floors.splice(at('pastry') + 1, 0, virtual(ARCHIVE, 'Archive', 'pastry', 'running', true));
  work.floors = ['herdr-3d', FRONT, 'depot-manager', DOCS, 'pastry', ARCHIVE];
  work.floors.forEach((id, index) => Object.assign(floors[at(id)], { building: work.id, index }));
  w.floors = floors;
  for (const x of w.workers) x.floor = x.session;
  // Hired on Frontend: their workspaces are herdr-3d's, their desks Frontend's.
  ['UX|m2-hud', 'helper-tunnel'].forEach((label, desk) => Object.assign(w.workers.find((x) => x.label === label), { floor: FRONT, desk_index: desk }));
  return [snap];
}

// ---- demo-m5: demo-m4 with questions and usage --------------------------------
// For the M5 panels on the simulating fixture server (`?sim=1`): the blocked
// workers carry the question the bridge read off their screen, in the forms
// of the real captures (internal/server/testdata/screens): Claude Code's
// trust dialog (no digits, "No, exit" first), its AskUserQuestion menu and a
// Bash permission menu, a Codex approval, and a question without a menu
// (Codex's own trust dialog never shows as blocked, so it is not here). Most
// agents report usage (one priced as an unknown model, one with no model seen
// yet). N visits them oldest first: Tater (herdr-3d), Quibble (pastry), Tofu,
// Sprocket, Waffle; then the done ones.

/** 16 hex chars over kind + text + choices, standing in for the bridge's hash. */
function qhash(kind, text, choices) {
  let h = 2166136261;
  let out = '';
  for (let k = 0; out.length < 16; k++) {
    for (const c of `${kind}|${text}|${choices.join('|')}#${k}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 16);
}

function question(kind, text, choices, excerpt, selected) {
  const q = { kind, text, excerpt, choices: choices.map((label, i) => ({ n: i + 1, label })), hash: qhash(kind, text, choices) };
  if (selected) q.selected = selected;
  return q;
}

const WINDOW = { claude: 200_000, codex: 272_000 };

function demoM5() {
  const [base] = demoM4();
  const snap = structuredClone(base);
  const w = snap.world;
  const r = rng(55);
  const byName = (n) => w.workers.find((x) => x.name === n);
  const ask = (name, title, q) => Object.assign(byName(name), { status: 'blocked', title, question: q });
  ask('Tater', 'Claude Code', question('trust', 'Quick safety check: Is this a project you created or one you trust?', ['No, exit', 'Yes, I trust this folder'], [
    'Accessing workspace:',
    '/home/dev/devel/herdr-3d-wt/release',
    'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    'Claude Code’ll be able to read, edit, and execute files here.',
    '❯ No, exit',
    'Yes, I trust this folder',
    'Enter to confirm · Esc to cancel',
  ], 1));
  // A Claude worker in pastry (was Codex): its AskUserQuestion menu.
  Object.assign(byName('Quibble'), { agent_kind: 'claude', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  ask('Quibble', 'Which unit system for the label?', question('choice', 'Which unit system should the nutrition label use?', [
    'Metric (g, ml)', 'US customary (oz, cups)', 'Both, metric first', 'Type something.', 'Chat about this',
  ], [
    '☐ Units',
    'Which unit system should the nutrition label use?',
    '❯ 1. Metric (g, ml)',
    '  2. US customary (oz, cups)',
    '  3. Both, metric first',
    '  4. Type something.',
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ], 1));
  ask('Tofu', 'Push the M3 plan branch?', question('permission', 'Do you want to proceed?', [
    'Yes', "Yes, and don't ask again for git push commands in /home/dev/devel/herdr-3d", 'No',
  ], [
    'Bash command',
    'git push origin h3d/tofu-m3-plan',
    'Push the plan branch for review',
    'Do you want to proceed?',
    '❯ 1. Yes',
    "2. Yes, and don't ask again for git push commands in /home/dev/devel/herdr-3d",
    '3. No',
    'Esc to cancel · Tab to amend',
  ], 1));
  ask('Sprocket', 'Allow `go test ./internal/store`?', question('permission', 'Would you like to run the following command?', [
    'Yes, proceed (y)', "Yes, and don't ask again for commands that start with `go test` (p)", 'No, and tell Codex what to do differently (esc)',
  ], [
    'Would you like to run the following command?',
    'Reason: May I run the store tests outside the read-only sandbox?',
    '$ go test ./internal/store',
    '› 1. Yes, proceed (y)',
    "2. Yes, and don't ask again for commands that start with `go test` (p)",
    '3. No, and tell Codex what to do differently (esc)',
    'Press enter to confirm or esc to cancel',
  ], 1));
  // Blocked with no menu on screen: the question is in its words, in the excerpt.
  ask('Waffle', 'Regenerating the fixtures', question('other', '', [], [
    'I can regenerate every fixture, or only the new demo-m5 one.',
    'Should I regenerate every fixture, or only demo-m5?',
    '❯',
  ]));
  for (const x of w.workers) {
    // Plain shells have no agent session to count; one never ran a turn yet (below).
    if (!x.agent_kind || x.name === 'Waffle') continue;
    if (x.name === 'Zippy') {
      x.usage = { tokens: 0, input: 0, output: 0, cache_write: 0, cache_read: 0, cost_usd_est: 0, priced: 'none', context_pct: null, updated_at: T0 };
      continue;
    }
    const tokens = 4000 + Math.floor(r() * 380_000);
    const out = Math.floor(tokens * (0.18 + r() * 0.1));
    const unknown = x.name === 'Ravioli';
    const model = unknown ? 'claude-preview-2026-09' : (x.model ?? (x.harness === 'codex' ? 'gpt-6-sol' : 'claude-opus-5-5'));
    const rate = model.includes('fable') || model.includes('luna') ? 1.1 : 4.6;
    const win = WINDOW[x.harness] ?? 200_000;
    x.usage = {
      tokens,
      input: Math.floor(tokens * 0.04),
      output: out,
      cache_write: Math.floor(tokens * 0.7),
      cache_read: tokens * (8 + Math.floor(r() * 20)),
      cost_usd_est: Math.round(((tokens * rate) / 100_000) * 10_000) / 10_000,
      priced: unknown ? 'unknown_model' : 'known',
      model,
      context_pct: Math.round(Math.min(96, (tokens / win) * 100 * (0.25 + r() * 0.5)) * 10) / 10,
      context_window: win,
      updated_at: T0 - Math.floor(r() * 600_000),
    };
    // #101: the count the share came from (Codex's leaves out its 12k baseline), and Claude's window is an assumption.
    // After the literal: nothing here may draw from the random stream.
    const pct = x.usage.context_pct;
    x.usage.context_tokens = x.harness === 'codex' ? Math.round(12_000 + (pct / 100) * (win - 12_000)) : Math.round((pct / 100) * win);
    if (x.harness !== 'codex') x.usage.context_window_estimated = true;
  }
  // Fixed numbers (not from the generator's random stream, so the others stay put).
  byName('Waffle').usage = { tokens: 21_400, input: 900, output: 4100, cache_write: 14_000, cache_read: 210_000, cost_usd_est: 0.2511, priced: 'known', model: 'claude-opus-5-5', context_pct: 7.3, context_window: 200_000, context_tokens: 14_600, context_window_estimated: true, updated_at: T0 };
  return [snap];
}

// ---- demo-m6: demo-m5 with two write-code runs on a lab floor ------------------
// M6 crew: a `lab` floor on top of Work holds two synthetic runs read from
// fixtures/runs/<run>/ (see its README): the over-cap orchestrator with its
// pass-3 crew in the first pod, and a run with every other freelancer state.
// Workers get the fields the bridge derives (contract §1): role, run, round,
// ticket, issue, orch_id, phase / pass / over_cap, and each freelancer's report
// read and cut the way the bridge does it. For the simulating fixture server
// (`?sim=1`): `sim.crew` then walks a scripted freelancer in and out.

const RUNS = join(OUT, 'runs');
const PASS_CAP = 3;

/** Cuts `s` to at most `n` UTF-8 bytes without splitting a character. */
function cutBytes(s, n) {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= n) return s;
  let end = n;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString('utf8');
}

/** A report file as the bridge summarises it (contract §1.2). */
function readReport(run, name, mtime) {
  let v;
  try {
    v = JSON.parse(readFileSync(join(RUNS, run, name), 'utf8'));
  } catch {
    return { state: 'pending' };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { state: 'invalid', at: mtime, error: 'not a JSON object' };
  const r = { state: 'ready', at: mtime };
  if ('verdict' in v) {
    if (!['PASS', 'CHANGES_REQUIRED', 'INCOMPLETE'].includes(v.verdict)) return { state: 'invalid', at: mtime, error: `bad verdict ${JSON.stringify(v.verdict)}` };
    const issues = Array.isArray(v.issues_found) ? v.issues_found : [];
    r.verdict = v.verdict;
    r.blockers = issues.filter((i) => i && i.priority === 'BLOCKER').length;
    r.issues = issues.length;
  }
  r.input_required = typeof v.input_required === 'string' && v.input_required ? cutBytes(v.input_required, 8192) : null;
  if (r.input_required !== null) {
    if (Buffer.byteLength(v.input_required) > 8192) r.input_truncated = true; // #215: the bridge's cap, flagged
    const f = typeof v.input_for === 'string' ? v.input_for.trim().toLowerCase() : '';
    if (f === 'orchestrator' || f === 'user') r.input_for = f;
    // #215: the orchestrator's resolution, `<stem>.resolved.json` next to the report, naming it in `report`. (Fixtures have no
    // meaningful mtimes: a valid sidecar resolves it; the bridge also needs the sidecar to be as new as the report.)
    // A name ending `.resolved.json` is reserved for sidecars (no report, no sidecar).
    const side = name.endsWith('.resolved.json') ? null : `${name.replace(/\.json$/, '')}.resolved.json`;
    if (side) {
      try {
        const x = JSON.parse(readFileSync(join(RUNS, run, side), 'utf8'));
        if (typeof x === 'object' && x !== null && !Array.isArray(x) && x.report === name && [x.resolved_by, x.note].every((q) => q === undefined || typeof q === 'string')) {
          r.input_resolved = { by: cutBytes((x.resolved_by ?? '').trim(), 40) || 'orchestrator', ...(x.note?.trim() ? { note: cutBytes(x.note.trim(), 300) } : {}), at: mtime };
        }
      } catch {
        // no sidecar, or an invalid one: the request stands
      }
    }
  }
  if (typeof v.summary === 'string') r.summary = cutBytes(v.summary, 300);
  return r;
}

function demoM6() {
  const [base] = demoM5();
  const snap = structuredClone(base);
  const w = snap.world;
  const r = rng(66);
  const session = 'lab';
  const cwd = '/home/dev/devel/lab';
  const work = w.buildings.find((b) => b.name === 'Work');
  work.floors = [session, ...work.floors];
  work.floors.forEach((s, index) => {
    const f = w.floors.find((x) => x.session === s);
    if (f) f.index = index;
  });
  const floor = {
    session, state: 'running', building: work.id, index: 0, desks: 14,
    settings: { repo: 'JeffreyVdb/lab' }, suggested: { repo: 'JeffreyVdb/lab', default_cwd: cwd },
  };
  w.floors.splice(0, 0, floor);
  const names = ['Sprout', 'Clementine', 'Fig', 'Pretzel', 'Juniper', 'Walnut', 'Basil', 'Maple', 'Cashew', 'Poppy', 'Radish', 'Saffron', 'Turnip'];
  let k = 0;
  const workers = [];
  // Desks the bridge would give: each run's freelancers nearest their orchestrator (pods of 4).
  const seats = { '20260928-1400-overcap': [0, 1, 2, 3], '20260928-1500-lobby': [4, 5, 6, 7, 8, 9, 10, 11] };
  for (const run of Object.keys(seats)) {
    const spec = JSON.parse(readFileSync(join(RUNS, run, 'workspaces.json'), 'utf8'));
    const issue = { repo: spec.repo, number: spec.issue };
    let orch = null;
    spec.workspaces.forEach((ws, i) => {
      const t = ws.tokens;
      const x = worker({
        r, session, i: k, name: names[k], desk: seats[run][i], status: ws.status, title: ws.title || undefined,
        label: ws.label, model: ws.agent ? ws.model : undefined, cwd,
      });
      k++;
      // No agent yet (just hired): the bridge knows the harness from the tokens, not the pane.
      if (!ws.agent) Object.assign(x, { harness: ws.model[0], model: ws.model[1], effort: ws.model[2] });
      x.tokens = t;
      x.role = t.h3d_role;
      x.run = t.h3d_run;
      const round = t.h3d_round ?? /\|r(\d+)$/.exec(ws.label)?.[1];
      if (round) x.round = Number(round);
      const parts = ws.label.split('|');
      if (parts.length === 4) x.ticket = parts[2];
      x.issue = issue;
      if (t.h3d_role === 'orch') {
        orch = x;
        x.phase = t.h3d_phase;
        x.pass = Number(t.h3d_pass);
        if (x.pass > PASS_CAP || (x.pass === PASS_CAP && x.phase === 'waiting_user')) x.over_cap = true;
      } else {
        x.orch_id = orch.id;
        x.report = t.h3d_report ? readReport(run, t.h3d_report, T0 - 600_000 + i * 45_000) : undefined;
      }
      workers.push(x);
    });
  }
  // A plain employee on the floor too (no run, no role).
  workers.push(worker({ r, session, i: k, name: names[k], desk: 12, status: 'working', title: 'Tidy the README', label: 'readme', model: MODELS[0], cwd }));
  w.workers.push(...workers);
  return [snap];
}

// ---- demo-m118: demo-m6 with the floor overview's lines (#118) -----------------
// The lab floor's runs with their issues' titles and pages (from the board, as the bridge fills them), and every agent
// with a digest: a one-off worker's task (Claude's ai-title, a cut prompt), a now line (a recap, else the title).

const ISSUE_TITLES = { 3: 'Port picker in the settings dialog', 4: 'Lobby directory with a floor map' };
const RECAPS = {
  Sprout: 'Pass 3 still has two blockers in the port picker; waiting for you to decide on the cap.',
  Juniper: 'Round 1 of the lobby directory is out to code, review and UX; Walnut finished the map research.',
};

function demoM118() {
  const [base] = demoM6();
  const snap = structuredClone(base);
  for (const w of snap.world.workers) {
    if (w.issue && ISSUE_TITLES[w.issue.number]) {
      const url = `https://github.com/${w.issue.repo}/issues/${w.issue.number}`;
      w.issue = { ...w.issue, title: ISSUE_TITLES[w.issue.number], url };
      w.work_item = { provider: 'github', id: `${w.issue.repo}#${w.issue.number}`, title: ISSUE_TITLES[w.issue.number], url };
    }
    if (!w.agent_kind && !w.title) continue;
    const recap = RECAPS[w.name];
    const d = recap ? { now: recap, now_source: 'recap', now_at: T0 - 120_000 } : { now_source: 'title' };
    if (!w.role) {
      d.task = w.name === 'Turnip' ? 'Tidy the README and the quick start' : (w.title ?? '').split(/[.:]/)[0].slice(0, 80) || undefined;
      d.task_source = w.harness === 'codex' ? 'prompt' : 'ai_title';
      if (!d.task) delete d.task, delete d.task_source;
    }
    w.digest = d;
  }
  return [snap];
}

// ---- demo-m188: demo-m118 with a run across two floors (#188) ------------------
// Poppy, Juniper's working coder, sits on pastry (desk 15) while Juniper orchestrates on lab: the all-floors overview
// lists Poppy once, under Juniper, tagged with its floor. And a reviewer in the scratchpad whose orchestrator is gone
// (Unlinked there).

function demoM188() {
  const [base] = demoM118();
  const snap = structuredClone(base);
  const w = snap.world.workers;
  const poppy = w.find((x) => x.name === 'Poppy');
  Object.assign(poppy, { session: 'pastry', desk_index: 15, workspace_id: 'wz', pane_id: 'wz:p1', cwd: '/home/dev/devel/lab-wt/lobby-api' });
  const sprout = w.find((x) => x.name === 'Sprout');
  w.push({
    ...structuredClone(w.find((x) => x.name === 'Fig')),
    id: 'f188a0c1-5e2d-4b7a-9c31-0d6e8a4b2f17',
    session: 'scratchpad',
    workspace_id: 'w4',
    pane_id: 'w4:p1',
    name: 'Quince',
    desk_index: 3,
    status: 'idle',
    orch_id: '00000000-0000-4000-8000-000000000188', // an orchestrator sent home
    cwd: sprout.cwd,
  });
  return [snap];
}

// ---- demo-h171: demo-m5's world, for its transcript of code changes (#171) ------
// The world is demo-m5's; what makes it the code-changes demo is its transcript: with `sim=1` every watch gets the
// timeline named after the fixture (tools/fixture-transcript.ts `h171Timeline`).

function demoH171() {
  return demoM5();
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

// ---- perf (M7): the busy floor linked to a repo whose simulated boards hold 100 issues and 20 pull requests ------
// Served with `sim=1` (tools/fixture-boards.ts: `JeffreyVdb/bench`).

function perfBoards() {
  const [snap] = perfFloor60();
  const world = snap.world;
  const f = world.floors[0];
  f.settings = { repo: 'JeffreyVdb/bench' };
  f.suggested = { repo: 'JeffreyVdb/bench', default_cwd: '/srv/perf-floor' };
  return [snap];
}

// ---- perf: the corner office's worst case (#20): 96 desks, everyone needs you ---
// From your desk up on the mezzanine every one of these cards shows (no cap there).

function perfFloor96() {
  const r = rng(96);
  const b = 'b_perf00000096';
  const workers = floorOf(r, 'perf-floor96', 96, 0).map((w) => ({ ...w, status: 'blocked' }));
  return [
    {
      t: 'world.snapshot',
      seq: 1,
      world: {
        buildings: [{ id: b, name: 'Perf 96', sort: 0, floors: ['perf-floor96'] }],
        unassigned: [],
        floors: [{ session: 'perf-floor96', state: 'running', building: b, index: 0, desks: 96 }],
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

const FIXTURES = { demo, 'demo-m3': demoM3, 'demo-m3b': demoM3b, 'demo-m4': demoM4, 'perf-floor60': perfFloor60, 'perf-boards': perfBoards, 'perf-floor96': perfFloor96, 'perf-city240': perfCity240 };
// M5 panels
FIXTURES['demo-m5'] = demoM5;
// M6 crew
FIXTURES['demo-m6'] = demoM6;
// #118 floor overview
FIXTURES['demo-m118'] = demoM118;
// #188 all-floors overview
FIXTURES['demo-m188'] = demoM188;
// #171 code changes in the transcript
FIXTURES['demo-h171'] = demoH171;
// #58 virtual floors
FIXTURES['demo-h58'] = demoH58;

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
