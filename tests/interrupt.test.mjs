// Interruption, pause latency and PID-identity checks through the real CLI.
// The host is faked: WebSocket, fetch, process.kill(pid !== self) and
// child_process are replaced, so no simulator, helper or network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/simops.mjs', import.meta.url));
const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

const PRELOAD = `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const cfg = JSON.parse(process.env.FAKE_CFG);
const log = m => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\\n');
const realKill = process.kill.bind(process);
const dead = new Set();
process.kill = (pid, sig) => {
  if (pid === process.pid) return realKill(pid, sig);
  if (sig === 0) {
    if (dead.has(pid) || !(cfg.alive ?? []).includes(pid)) throw Object.assign(new Error('x'), { code: 'ESRCH' });
    return true;
  }
  log({ signal: sig ?? 'SIGTERM', pid }); dead.add(pid); return true;
};
cp.execFileSync = (cmd, args, opts = {}) => {
  if (cmd === 'ps') {
    const pid = Number(args[1]);
    if (cfg.psFails) throw new Error('ps unavailable');
    if (dead.has(pid) || !(cfg.alive ?? []).includes(pid)) throw new Error('no such process');
    if (args[3] === 'lstart=') {
      // Like real ps: the text depends on locale and time zone of the call.
      const t = (cfg.lstart ?? {})[pid] ?? 'Thu Jan  1 00:00:00 2026';
      const env = opts.env ?? process.env;
      return env.LC_ALL === 'C' && env.TZ === 'UTC0' ? t : 'localized(' + (env.TZ ?? '') + ',' + (env.LC_ALL ?? env.LANG ?? '') + ') ' + t;
    }
    return (cfg.args ?? {})[pid] ?? 'node /x/serve-sim/dist/serve-sim.js --detach';
  }
  if (cmd === 'xcrun' && cfg.booted) return JSON.stringify({ devices: { r: [{ udid: cfg.udid, state: 'Booted' }] } });
  throw new Error('no host tools in this fixture: ' + cmd);
};
cp.spawnSync = (cmd, args) => {
  log({ spawnSync: cmd, args });
  if (cfg.slowSpawn) { log({ phase: 'spawn' }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cfg.slowSpawn); }
  if (cfg.spawnHelper) fs.writeFileSync(cfg.spawnHelper.file, JSON.stringify(cfg.spawnHelper.state)); // the new helper appears
  return { status: 0, stdout: '', stderr: '' };
};
syncBuiltinESMExports();
if (cfg.noWebSocket) delete globalThis.WebSocket;
const ax = [{ AXLabel: 'App', type: 'Application', frame: { x: 0, y: 0, width: 400, height: 800 },
  children: [{ AXLabel: 'Field', type: 'TextField', AXValue: '', frame: { x: 10, y: 10, width: 100, height: 40 }, children: [] }] }];
globalThis.fetch = async (url, opts = {}) => {
  log({ fetch: url.replace(/^.*\\//, '/') });
  if (url.endsWith('/health') && cfg.hangHealth) {
    log({ phase: 'health' });
    // A real hung request keeps a socket open (the loop stays alive) until its
    // AbortSignal timeout fires; emulate both.
    const keep = setInterval(() => {}, 1000);
    await new Promise((_, reject) => opts.signal?.addEventListener('abort', () => { clearInterval(keep); reject(new Error('aborted')); }));
  }
  if (url.endsWith('/health') && cfg.healthFail) return { ok: false, status: 503 };
  if (url.endsWith('/ax')) return { ok: true, json: async () => ax };
  return { ok: true, json: async () => ({ bundleId: 'com.example.app' }) };
};
if (!cfg.noWebSocket) globalThis.WebSocket = class { static OPEN = 1;
  constructor() { this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen(); }); }
  send(m) { const b = Buffer.from(m); log({ send: b[0], body: JSON.parse(b.subarray(1).toString()), at: Date.now() }); }
  close() { this.readyState = 3; }
};
`;

function fixture({ lease = { udid: UDID, owner: 't' }, helper = { device: UDID, pid: 4242, wsUrl: 'ws://127.0.0.1:1/ws' }, cfg = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-interrupt-'));
  fs.mkdirSync(path.join(dir, 'leases'));
  fs.mkdirSync(path.join(dir, 'serve-sim'));
  if (lease) fs.writeFileSync(path.join(dir, 'leases', `${UDID}.json`), JSON.stringify(lease));
  if (helper) fs.writeFileSync(path.join(dir, 'serve-sim', `server-${UDID}.json`), JSON.stringify(helper));
  fs.writeFileSync(path.join(dir, 'pre.mjs'), PRELOAD);
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(log, '');
  const env = { ...process.env, TMPDIR: dir, SIMOPS_STATE_DIR: dir, FAKE_LOG: log, FAKE_CFG: JSON.stringify({ alive: [4242], udid: UDID, ...cfg }) };
  const children = new Set();
  const f = {
    dir, env, lock: path.join(dir, 'locks', UDID), leaseFile: path.join(dir, 'leases', `${UDID}.json`),
    entries: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    plan: steps => { const p = path.join(dir, 'plan.json'); fs.writeFileSync(p, JSON.stringify({ steps })); return p; },
    launch: args => {
      const child = spawn(process.execPath, ['--import', path.join(dir, 'pre.mjs'), script, ...args], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      const done = new Promise(r => child.on('exit', (code, signal) => r({ code, signal, out, json: () => JSON.parse(out) })));
      const running = { child, done };
      children.add(running);
      return running;
    },
    cleanup: async () => {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all([...children].map(({ done }) => done));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return f;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(10); } throw new Error('condition not reached'); }
async function withFixture(opts, fn) { const f = fixture(opts); try { await fn(f); } finally { await f.cleanup(); } }
const run = (f, plan, extra = []) => f.launch(['run', '--udid', UDID, '--owner', 't', '--plan', plan, ...extra]);

test('signal while the plan is still being read leaves no lock (plan is read before locking)', () => withFixture({}, async f => {
  const p = f.launch(['run', '--udid', UDID, '--owner', 't', '--plan', '-']);
  await sleep(150);
  assert.equal(fs.existsSync(f.lock), false, 'no lock while reading stdin');
  p.child.kill('SIGTERM');
  await p.done;
  assert.equal(fs.existsSync(f.lock), false);
}));

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} during the pre-connect health probe unwinds and releases the lock`, () => withFixture({ cfg: { hangHealth: true } }, async f => {
    const p = run(f, f.plan([{ assert: { label: 'Field' } }]));
    await until(() => f.entries().some(e => e.phase === 'health'));
    p.child.kill(signal);
    const r = await p.done;
    assert.equal(r.signal, null, 'not killed by the signal');
    assert.equal(r.code, 5);
    assert.match(r.json().error, /paused while probing/);
    assert.equal(fs.existsSync(f.lock), false);
    assert.equal(f.entries().some(e => e.send !== undefined), false, 'no input sent');
  }));
}

test('signal during --screenshot still prints the result and releases the lock', () => withFixture({ cfg: { slowSpawn: 600 } }, async f => {
  const p = run(f, f.plan([{ assert: { label: 'Field' } }]), ['--screenshot', path.join(f.dir, 'x.png')]);
  await until(() => f.entries().some(e => e.phase === 'spawn'));
  p.child.kill('SIGTERM');
  const r = await p.done;
  assert.equal(r.signal, null);
  assert.equal(r.json().status, 'ok');
  assert.equal(fs.existsSync(f.lock), false);
  assert.ok(fs.readFileSync(path.join(f.dir, 'runs.jsonl'), 'utf8').length > 0, 'run log written');
}));

test('pause during a long type stops within one batch and reports partial input', () => withFixture({}, async f => {
  const p = run(f, f.plan([{ type: 'a'.repeat(2000) }, { type: 'b' }]));
  await until(() => f.entries().some(e => e.send === 6));
  fs.writeFileSync(path.join(f.dir, `pause-${UDID}`), 'x');
  const pausedAt = Date.now();
  const r = await p.done;
  const out = r.json();
  const keys = f.entries().filter(e => e.send === 6);
  assert.equal(out.status, 'paused');
  assert.equal(out.error.action_sent, true);
  assert.match(out.error.message, /partial/);
  assert.ok(keys.filter(e => e.at > pausedAt + 5).length <= 2 * 16, `at most one batch after pause, got ${keys.filter(e => e.at > pausedAt + 5).length}`);
  assert.ok(keys.length < 2 * 2000, 'did not type the whole text');
  assert.equal(out.actions, 0);
  assert.equal(out.actions_attempted, 1);
  // whole key strokes only: every down has its up
  const downs = keys.filter(e => e.body.type === 'down').length, ups = keys.filter(e => e.body.type === 'up').length;
  assert.equal(downs, ups);
  assert.equal(fs.existsSync(f.lock), false);
}));

test('SIGTERM during a long type behaves like pause and releases the lock', () => withFixture({}, async f => {
  const p = run(f, f.plan([{ type: 'a'.repeat(2000) }]));
  await until(() => f.entries().some(e => e.send === 6));
  p.child.kill('SIGTERM');
  const r = await p.done;
  assert.equal(r.signal, null);
  assert.equal(r.json().status, 'paused');
  assert.equal(fs.existsSync(f.lock), false);
}));

test('pause during a swipe lifts the finger and stops', () => withFixture({}, async f => {
  const p = run(f, f.plan([{ swipe: { from: [100, 600], to: [100, 100], ms: 3000 }, expect: { label: 'Field' } }]));
  await until(() => f.entries().some(e => e.send === 3 && e.body.type === 'move'));
  fs.writeFileSync(path.join(f.dir, `pause-${UDID}`), 'x');
  const r = await p.done;
  const touches = f.entries().filter(e => e.send === 3);
  assert.equal(r.json().status, 'paused');
  assert.equal(touches.at(-1).body.type, 'end', 'finger lifted');
  assert.ok(touches.length < 150, 'did not finish the swipe');
}));

test('commit interrupted mid-input is unknown, not paused', () => withFixture({}, async f => {
  const p = run(f, f.plan([{ type: 'x'.repeat(2000), expect: { label: 'Done' }, commit: true }]));
  await until(() => f.entries().some(e => e.send === 6));
  p.child.kill('SIGTERM');
  const out = (await p.done).json();
  assert.equal(out.status, 'unknown');
  assert.equal(out.commit.verification, 'unknown');
}));

test('stop retains a legacy lease when a live PID runs an unrecognised program', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242 }, cfg: { args: { 4242: '/usr/bin/some-other-tool' } },
}, async f => {
  const r = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 1, r.out);
  assert.match(r.json().error, /lease retained/);
  assert.equal(f.entries().some(e => e.signal), false);
  assert.equal(fs.existsSync(f.leaseFile), true);
}));

test('stop keeps the lease when the PID identity cannot be read', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242 }, cfg: { psFails: true },
}, async f => {
  const r = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 1);
  assert.equal(f.entries().some(e => e.signal), false);
  assert.equal(fs.existsSync(f.leaseFile), true);
}));

test('stop still stops its own live serve-sim helper and verifies exit', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242 },
}, async f => {
  const r = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(f.entries().filter(e => e.signal).map(e => e.pid), [4242]);
  assert.match(r.json().helper, /verified exited/);
}));

test('a leftover state file whose PID was recycled is treated as no helper (no health request)', () => withFixture({
  cfg: { args: { 4242: '/usr/bin/some-other-tool' } },
}, async f => {
  const r = await run(f, f.plan([{ assert: { label: 'Field' } }])).done;
  assert.equal(r.code, 1);
  assert.match(r.json().error, /helper not running/);
  assert.equal(f.entries().some(e => e.fetch), false);
}));

test('unlock decides by process instance (PID + start time), never by command-line names', () => withFixture({}, async f => {
  const holder = h => { fs.rmSync(f.lock, { recursive: true, force: true }); fs.mkdirSync(f.lock, { recursive: true }); fs.writeFileSync(path.join(f.lock, 'holder.json'), JSON.stringify(h)); };
  const setCfg = patch => { f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), ...patch }); };
  const unlock = owner => f.launch(['unlock', '--udid', UDID, '--owner', owner]).done;
  const started = 'Thu Jan  1 00:00:00 2026';
  const start_clock = 'ps-lstart/C/UTC0';

  // Same live process, even if its command line mentions serve-sim or uses a bin name.
  for (const args of ['node /x/scripts/simops.mjs run --plan /work/serve-sim-plans/p.json', '/usr/local/bin/simops run --plan p.json']) {
    setCfg({ alive: [4242], args: { 4242: args }, lstart: { 4242: started } });
    holder({ pid: 4242, started, start_clock, owner: 't', command: 'run', at: 'x' });
    assert.equal((await unlock('t')).code, 4, args);
    assert.equal(fs.existsSync(f.lock), true);
  }
  // Live PID without a recorded start time, or ps unavailable: refuse.
  holder({ pid: 4242, started: null, start_clock, owner: 't', command: 'run', at: 'x' });
  assert.equal((await unlock('t')).code, 4);
  setCfg({ psFails: true });
  holder({ pid: 4242, started, start_clock, owner: 't', command: 'run', at: 'x' });
  assert.equal((await unlock('t')).code, 4);
  setCfg({ psFails: false });

  assert.equal((await unlock('someone-else')).code, 4, 'other owner refused');

  // Same live process, unlock called from a different time zone / locale: still refused.
  setCfg({ alive: [4242], args: { 4242: 'node /x/scripts/simops.mjs run' }, lstart: { 4242: started } });
  holder({ pid: 4242, started, start_clock, owner: 't', command: 'run', at: 'x' });
  const saved = f.env;
  f.env = { ...saved, TZ: 'Asia/Shanghai', LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' };
  assert.equal((await unlock('t')).code, 4, 'locale/time zone must not make a live holder look recycled');
  f.env = saved;
  // A holder written without the pinned clock cannot be compared: refused.
  holder({ pid: 4242, started: 'localized(UTC,) ' + started, owner: 't', command: 'run', at: 'x' });
  assert.equal((await unlock('t')).code, 4);
  assert.equal(fs.existsSync(f.lock), true);

  // Recycled PID (different start time): removed.
  setCfg({ lstart: { 4242: 'Fri Jan  2 00:00:00 2026' } });
  holder({ pid: 4242, started, start_clock, owner: 't', command: 'run', at: 'x' });
  let ok = await unlock('t');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(fs.existsSync(f.lock), false);

  // Holder exited: removed, with a reminder to verify the last action.
  holder({ pid: 9999, started, start_clock, owner: 't', command: 'run', at: 'x' });
  ok = await unlock('t');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.json().note, /verify the outcome/);
  assert.equal(fs.readdirSync(path.join(f.dir, 'locks')).length, 0, 'no lock or transition leftovers');

  // No holder.json: refuse.
  fs.mkdirSync(f.lock, { recursive: true });
  assert.equal((await unlock('t')).code, 4);
  assert.equal(fs.existsSync(f.lock), true);
}));

test('run stops clearly on a Node without global WebSocket, before taking the lock', () => withFixture({ cfg: { noWebSocket: true } }, async f => {
  const r = await run(f, f.plan([{ assert: { label: 'Field' } }])).done;
  assert.equal(r.code, 1);
  assert.match(r.json().error, /Node 22 or newer/);
  assert.equal(fs.existsSync(f.lock), false);
}));

test('a second signal exits at once, releases only its own lock and reports an unknown outcome', () => withFixture({ cfg: { hangHealth: true } }, async f => {
  const p = run(f, f.plan([{ assert: { label: 'Field' } }]));
  await until(() => f.entries().some(e => e.phase === 'health'));
  const t0 = Date.now();
  p.child.kill('SIGTERM');
  await sleep(50);
  p.child.kill('SIGTERM');
  const r = await p.done;
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the bounded probe');
  assert.equal(r.code, 3);
  assert.match(r.json().error, /second interrupt.*verify/);
  assert.equal(fs.existsSync(f.lock), false);
}));

test('a second signal in the middle of a swipe lifts the finger before exiting', () => withFixture({}, async f => {
  const p = run(f, f.plan([{ swipe: { from: [100, 600], to: [100, 100], ms: 3000 }, expect: { label: 'Field' } }]));
  await until(() => f.entries().some(e => e.send === 3 && e.body.type === 'move'));
  p.child.kill('SIGTERM'); // first: becomes pause at the next move...
  p.child.kill('SIGTERM'); // ...second arrives before that check: exit now
  const r = await p.done;
  const touches = f.entries().filter(e => e.send === 3);
  assert.equal(touches.at(-1).body.type, 'end', 'finger lifted');
  assert.ok([3, 5].includes(r.code), `exit ${r.code}`);
  assert.equal(fs.existsSync(f.lock), false);
}));

test('start keeps responsibility for its live helper when ps cannot identify it', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242, acquired_at: 'x' }, helper: null, cfg: { psFails: true, booted: true },
}, async f => {
  const before = fs.readFileSync(f.leaseFile, 'utf8');
  const r = await f.launch(['start', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 1, r.out);
  assert.match(r.json().error, /lease retained/);
  assert.equal(fs.readFileSync(f.leaseFile, 'utf8'), before);
  assert.equal(f.entries().some(e => e.spawnSync), false, 'no second helper started');
}));

test('a failed start records the new helper start time, so stop still stops that helper', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242, helper_started: 'OLD', start_clock: 'ps-lstart/C/UTC0', acquired_at: 'x' },
  helper: null,
}, async f => {
  const state = { device: UDID, pid: 5555, wsUrl: 'ws://127.0.0.1:1/ws' };
  f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), booted: true, alive: [5555], healthFail: true,
    lstart: { 5555: 'NEW' }, spawnHelper: { file: path.join(f.dir, 'serve-sim', `server-${UDID}.json`), state } });
  const r = await f.launch(['start', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 1, r.out);
  const lease = JSON.parse(fs.readFileSync(f.leaseFile, 'utf8'));
  assert.equal(lease.helper_pid, 5555);
  assert.equal(lease.helper_started, 'NEW', 'not the crashed helper\'s start time');
  assert.equal(lease.start_pending, false);
  const s = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
  assert.equal(s.code, 0, s.out);
  assert.deepEqual(f.entries().filter(e => e.signal).map(e => e.pid), [5555], 'its own helper is stopped');
}));

test('stop does not signal an owned PID whose start time changed (recycled by another serve-sim)', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242, helper_started: 'OLD', start_clock: 'ps-lstart/C/UTC0' },
  cfg: { lstart: { 4242: 'NEWER' } },
}, async f => {
  const r = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.json().helper, /newer process and was not signalled/);
  assert.equal(f.entries().some(e => e.signal), false);
}));

test('a custom SIMOPS_SERVE_SIM helper is recognised only by its exact path plus the UDID', () => withFixture({}, async f => {
  const runOnce = async (args, custom) => {
    f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), args: { 4242: args } });
    f.env.SIMOPS_SERVE_SIM = custom;
    fs.writeFileSync(f.env.FAKE_LOG, '');
    await run(f, f.plan([{ assert: { label: 'Field' } }])).done;
    return f.entries().some(e => e.fetch === '/health');
  };
  assert.equal(await runOnce(`/opt/tools/sim-wrap --detach ${UDID}`, '/opt/tools/sim-wrap'), true, 'exact path + UDID: helper');
  assert.equal(await runOnce(`/usr/bin/sim-wrap --detach ${UDID}`, '/opt/tools/sim-wrap'), false, 'same basename elsewhere: not a helper');
  assert.equal(await runOnce(`/opt/tools/sim-wrap --detach OTHER`, '/opt/tools/sim-wrap'), false, 'no UDID: not a helper');
  assert.equal(await runOnce(`xcrun simctl boot ${UDID}`, '/opt/tools/sim-wrap'), false, 'other tool with the UDID: not a helper');
}));

test('start keeps ownership when the start time of its own helper cannot be read', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242, helper_started: 'A', start_clock: 'ps-lstart/C/UTC0', acquired_at: 'x' },
  cfg: { booted: true, lstart: { 4242: '' } },
}, async f => {
  const before = fs.readFileSync(f.leaseFile, 'utf8');
  const r = await f.launch(['start', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 1, r.out);
  assert.match(r.json().error, /lease retained/);
  assert.equal(fs.readFileSync(f.leaseFile, 'utf8'), before);
}));

test('a relative SIMOPS_SERVE_SIM path is matched after resolving it', () => withFixture({}, async f => {
  f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), args: { 4242: `${path.resolve('tools/sim-wrap')} --detach ${UDID}` } });
  f.env.SIMOPS_SERVE_SIM = 'tools/sim-wrap';
  await run(f, f.plan([{ assert: { label: 'Field' } }])).done;
  assert.equal(f.entries().some(e => e.fetch === '/health'), true);
}));


test('stop retains the lease when the recorded start time cannot be read', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242, helper_started: 'A', start_clock: 'ps-lstart/C/UTC0' },
  cfg: { lstart: { 4242: '' } },
}, async f => {
  const before = fs.readFileSync(f.leaseFile, 'utf8');
  const r = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
  assert.equal(r.code, 1, r.out);
  assert.equal(f.entries().some(e => e.signal), false);
  assert.equal(fs.readFileSync(f.leaseFile, 'utf8'), before);
}));

test('helper identity rejects path and UDID substrings', () => withFixture({}, async f => {
  f.env.SIMOPS_SERVE_SIM = '/opt/tools/sim-wrap';
  for (const args of [`/opt/tools/sim-wrap-unrelated ${UDID}`, `/opt/tools/sim-wrap ${UDID}-OTHER`,
    `/opt/tools/not-serve-sim ${UDID}`, `node /opt/serve-sim-backup.js ${UDID}`, `/opt/unrelated --log=/opt/serve-sim ${UDID}`]) {
    f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), args: { 4242: args } });
    fs.writeFileSync(f.env.FAKE_LOG, '');
    await run(f, f.plan([{ assert: { label: 'Field' } }])).done;
    assert.equal(f.entries().some(e => e.fetch), false, args);
  }
}));

test('custom helper startup identity survives an absent or changed environment', () => withFixture({ lease: null, helper: null }, async f => {
  const custom = '/opt/tools/sim-wrap';
  f.env.SIMOPS_SERVE_SIM = custom;
  f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), booted: true,
    args: { 4242: `${custom} --detach ${UDID}` },
    spawnHelper: { file: path.join(f.dir, 'serve-sim', `server-${UDID}.json`), state: { device: UDID, pid: 4242, wsUrl: 'ws://127.0.0.1:1/ws' } } });
  const started = await f.launch(['start', '--udid', UDID, '--owner', 't']).done;
  assert.equal(started.code, 0, started.out);
  const owned = fs.readFileSync(f.leaseFile, 'utf8');
  for (const env of [undefined, '/other/wrapper']) {
    fs.writeFileSync(f.leaseFile, owned);
    if (env) f.env.SIMOPS_SERVE_SIM = env; else delete f.env.SIMOPS_SERVE_SIM;
    fs.writeFileSync(f.env.FAKE_LOG, '');
    const stopped = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
    assert.equal(stopped.code, 0, stopped.out);
    assert.deepEqual(f.entries().filter(e => e.signal).map(e => e.pid), [4242]);
  }
}));

test('an unrecognised live helper instance retains legacy and current leases', () => withFixture({}, async f => {
  delete f.env.SIMOPS_SERVE_SIM;
  f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), booted: true, args: { 4242: `/opt/legacy-wrapper ${UDID}` }, lstart: { 4242: 'A' } });
  for (const extra of [{}, { helper_started: 'A', start_clock: 'ps-lstart/C/UTC0' }]) {
    const owned = JSON.stringify({ udid: UDID, owner: 't', started_helper: true, helper_pid: 4242, ...extra });
    for (const command of ['stop', 'start']) {
      fs.writeFileSync(f.leaseFile, owned);
      const r = await f.launch([command, '--udid', UDID, '--owner', 't']).done;
      assert.equal(r.code, 1, r.out);
      assert.equal(fs.readFileSync(f.leaseFile, 'utf8'), owned);
      assert.equal(f.entries().some(e => e.signal || e.spawnSync), false);
    }
  }
}));


test('second interrupt does not delete a replacement lock with the same PID', () => withFixture({ cfg: { hangHealth: true } }, async f => {
  const p = run(f, f.plan([{ assert: { label: 'Field' } }]));
  try {
    await until(() => f.entries().some(e => e.phase === 'health'));
    const holderFile = path.join(f.lock, 'holder.json');
    const holder = JSON.parse(fs.readFileSync(holderFile));
    fs.writeFileSync(holderFile, JSON.stringify({ ...holder, token: 'replacement' }));
    p.child.kill('SIGTERM');
    await sleep(50);
    p.child.kill('SIGTERM');
    const r = await p.done;
    assert.equal(r.code, 3, r.out);
    assert.equal(fs.existsSync(f.lock), true);
    assert.equal(JSON.parse(fs.readFileSync(holderFile)).token, 'replacement');
  } finally {
    if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
    await p.done;
  }
}));


for (const args of ['tail -f /tmp/serve-sim', `python /opt/audit.py /opt/tools/sim-wrap ${UDID}`]) {
  test(`stop does not mistake a data argument for a helper: ${args.split(' ')[0]}`, () => withFixture({
    lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242 }, cfg: { args: { 4242: args } },
  }, async f => {
    f.env.SIMOPS_SERVE_SIM = '/opt/tools/sim-wrap';
    const before = fs.readFileSync(f.leaseFile, 'utf8');
    const r = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
    assert.equal(r.code, 1, r.out);
    assert.equal(f.entries().some(e => e.signal), false, 'unrelated process is not signalled');
    assert.equal(fs.readFileSync(f.leaseFile, 'utf8'), before);
  }));
}

test('helper identity recognises direct executables and supported interpreter script positions', () => withFixture({
  lease: { udid: UDID, owner: 't', started_helper: true, helper_pid: 4242 },
}, async f => {
  const owned = fs.readFileSync(f.leaseFile, 'utf8');
  f.env.SIMOPS_SERVE_SIM = '/opt/tools/sim-wrap';
  for (const args of ['/usr/local/bin/serve-sim --detach', 'node /opt/serve-sim/dist/serve-sim.js --detach',
    `/opt/tools/sim-wrap ${UDID}`, `/bin/sh /opt/tools/sim-wrap ${UDID}`, `/usr/bin/python3 /opt/tools/sim-wrap ${UDID}`]) {
    fs.writeFileSync(f.leaseFile, owned);
    fs.writeFileSync(f.env.FAKE_LOG, '');
    f.env.FAKE_CFG = JSON.stringify({ ...JSON.parse(f.env.FAKE_CFG), args: { 4242: args } });
    const r = await f.launch(['stop', '--udid', UDID, '--owner', 't']).done;
    assert.equal(r.code, 0, `${args}: ${r.out}`);
    assert.deepEqual(f.entries().filter(e => e.signal).map(e => e.pid), [4242], args);
  }
}));
