#!/usr/bin/env node
// simops: run confirmed iOS Simulator steps through one reused serve-sim
// connection (native HID + accessibility snapshot), with lease, pause and
// fail-stop rules. Requires Node >= 22 (global WebSocket/fetch) and macOS Xcode.
//
//   simops.mjs doctor  [--udid U]
//   simops.mjs start   --udid U --owner NAME
//   simops.mjs ax      --udid U [--limit N]
//   simops.mjs run     --udid U --owner NAME --plan FILE|- [--screenshot OUT.png] [--pause-file F]
//   simops.mjs pause|resume --udid U
//   simops.mjs stop    --udid U --owner NAME
//   simops.mjs unlock  --udid U --owner NAME   (only a lock whose holder process has exited)
//
// Exit codes: 0 ok, 1 failed, 2 usage/plan error, 3 unknown result (verify, do
// not resend), 4 device busy/lease mismatch, 5 paused.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlan, validatePlan, flattenAx, summarize, StepError } from './lib/engine.mjs';

import { withDeviceLock, stopOwnedHelper, unlockStale } from './lib/lifecycle.mjs';

const EXIT = { ok: 0, failed: 1, usage: 2, unknown: 3, busy: 4, paused: 5 };

// ---------- args / output ----------

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { _: cmd };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) throw usage(`unexpected argument ${k}`);
    const key = k.slice(2);
    if (!['udid', 'owner', 'plan', 'screenshot', 'pause-file', 'limit'].includes(key) || Object.hasOwn(o, key)) throw usage(`unknown or duplicate option ${k}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) throw usage(`${k} requires a value`);
    else { o[key] = next; i++; }
  }
  return o;
}
function usage(msg) { return Object.assign(new Error(msg), { exit: EXIT.usage }); }
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const need = (o, ...keys) => keys.forEach(k => { if (!o[k] || o[k] === true) throw usage(`--${k} is required`); });

// ---------- local state (outside any repo) ----------

function stateDir() {
  const base = process.env.SIMOPS_STATE_DIR ||
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'browser-sim-ops');
  fs.mkdirSync(path.join(base, 'leases'), { recursive: true, mode: 0o700 });
  return base;
}
const leaseFile = udid => path.join(stateDir(), 'leases', `${udid}.json`);
const pauseFile = udid => path.join(stateDir(), `pause-${udid}`);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function alive(pid) { if (!Number.isInteger(pid) || pid <= 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// ps output (notably lstart) depends on locale and time zone; pin both so two
// processes in different environments compare the same instance equally.
const PS_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' };
const START_CLOCK = 'ps-lstart/C/UTC0';
function psField(pid, field) {
  try { return String(execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8', timeout: 2000, env: PS_ENV })).trim() || null; }
  catch { return null; }
}
/** Only the executable or a supported interpreter's immediate script counts.
 * ps does not provide structured argv: flags/quoting in that position are not guessed. */
function processIdentity(pid, udid, custom = process.env.SIMOPS_SERVE_SIM) {
  if (!alive(pid)) return 'gone';
  const args = psField(pid, 'args');
  if (!args) return alive(pid) ? 'unknown' : 'gone';
  const argv = args.split(/\s+/);
  const interpreter = /^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|sh|bash|zsh)$/.test(path.basename(argv[0]));
  const command = argv[interpreter ? 1 : 0];
  if (!command || command.startsWith('-') || /["'\\]/.test(command)) return 'unknown';
  if (custom && udid && command === path.resolve(custom) && argv.some(arg => arg.toUpperCase() === udid)) return 'serve-sim';
  if (/^(?:\/(?:\S*\/)?)?serve-sim(?:\.js)?$/.test(command)) return 'serve-sim';
  return 'other';
}
/** Process start time; with the PID it identifies one process instance. */
const processStart = pid => (alive(pid) ? psField(pid, 'lstart') : null);

// ---------- interruption ----------
// SIGINT/SIGTERM while a device lock is held must never kill the process
// outright: the flag is honoured at the next pause check and finally blocks
// release the lock. Before the lock is taken the default behaviour is kept.
const interrupt = { hit: false, waiters: new Set() };
let activeTransport = null; // for a best-effort touch release on a hard exit
function trapSignals(onSecond) {
  // A second signal means "exit now": release only our own lock and leave
  // every other record (lease, start_pending) for inspection.
  const on = () => {
    if (interrupt.hit) { try { activeTransport?.releaseTouch(); } catch {} onSecond(); return; }
    interrupt.hit = true; for (const f of interrupt.waiters) f();
  };
  process.on('SIGINT', on); process.on('SIGTERM', on);
  return () => { process.off('SIGINT', on); process.off('SIGTERM', on); };
}

// ---------- serve-sim discovery (reuse what is installed; never auto-download) ----------

function findServeSim() {
  const env = process.env.SIMOPS_SERVE_SIM ? path.resolve(process.env.SIMOPS_SERVE_SIM) : null;
  if (env) return env.endsWith('.js') ? { cmd: process.execPath, pre: [env], from: 'SIMOPS_SERVE_SIM' } : { cmd: env, pre: [], from: 'SIMOPS_SERVE_SIM' };
  const which = spawnSync('/usr/bin/which', ['serve-sim'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return { cmd: which.stdout.trim(), pre: [], from: 'PATH' };
  // npx cache: pick the highest installed version
  const npx = path.join(os.homedir(), '.npm', '_npx');
  let best = null;
  try {
    for (const d of fs.readdirSync(npx)) {
      const pkg = readJson(path.join(npx, d, 'node_modules', 'serve-sim', 'package.json'));
      if (!pkg) continue;
      const v = pkg.version.split('.').map(Number);
      if (!best || cmpVer(v, best.v) > 0)
        best = { v, cmd: process.execPath, pre: [path.join(npx, d, 'node_modules', 'serve-sim', 'dist', 'serve-sim.js')], from: `npx-cache@${pkg.version}` };
    }
  } catch { /* no cache */ }
  return best;
}
function cmpVer(a, b) { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; }
function serveSim(args, opts = {}) {
  const s = opts.source ?? findServeSim();
  if (!s) throw Object.assign(new Error('serve-sim not found. Install once (e.g. `npx --yes serve-sim@<version> --help`) or set SIMOPS_SERVE_SIM; this tool never downloads it.'), { exit: EXIT.failed });
  return spawnSync(s.cmd, [...s.pre, ...args], { encoding: 'utf8', timeout: opts.timeout ?? 60000, cwd: os.tmpdir() });
}

const helperState = udid => readJson(path.join(os.tmpdir(), 'serve-sim', `server-${udid}.json`));

/** Running serve-sim endpoint for this exact UDID, or null. */
async function helperFor(udid, command = readJson(leaseFile(udid))?.helper_command ?? process.env.SIMOPS_SERVE_SIM) {
  const st = helperState(udid);
  if (!st || st.device !== udid || !alive(st.pid)) return null;
  // A leftover state file whose PID now belongs to another program is stale.
  if (['gone', 'other'].includes(processIdentity(st.pid, udid, command))) return null;
  const endpoint = new URL(st.wsUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password)
    throw new Error('helper endpoint must be a local unauthenticated ws URL');
  const http = st.wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  try {
    const r = await fetch(`${http}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    if (interrupt.hit) throw Object.assign(new StepError('paused', 'paused while probing serve-sim health'), { exit: EXIT.paused });
    throw new Error(`helper pid ${st.pid} is alive but unhealthy (${e.message}); will not restart or release it automatically`);
  }
  return { ...st, http };
}

function bootedDevices() {
  const j = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8', timeout: 10000 }));
  return Object.entries(j.devices).flatMap(([rt, ds]) => ds.map(d => ({ udid: d.udid, name: d.name, runtime: rt.split('.').pop(), state: d.state })));
}

// ---------- transport over one WebSocket ----------

const HID = (() => {
  const m = {};
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => { m[c] = { u: 4 + i }; m[c.toUpperCase()] = { u: 4 + i, s: true }; });
  '1234567890'.split('').forEach((c, i) => { m[c] = { u: 30 + i }; });
  '!@#$%^&*()'.split('').forEach((c, i) => { m[c] = { u: 30 + i, s: true }; });
  const pairs = [['\n', 40], [' ', 44], ['-', 45], ['=', 46], ['[', 47], [']', 48], ['\\', 49], [';', 51], ["'", 52], ['`', 53], [',', 54], ['.', 55], ['/', 56], ['\t', 43]];
  const shifted = [['_', 45], ['+', 46], ['{', 47], ['}', 48], ['|', 49], [':', 51], ['"', 52], ['~', 53], ['<', 54], ['>', 55], ['?', 56]];
  pairs.forEach(([c, u]) => { m[c] = { u }; });
  shifted.forEach(([c, u]) => { m[c] = { u, s: true }; });
  return m;
})();
const KEYS = { enter: 40, return: 40, escape: 41, backspace: 42, delete: 42, tab: 43, space: 44 };

async function openTransport(h, pausePath) {
  let ws, timer, rejectConnect;
  let closed = false;
  const onSig = () => {
    rejectConnect?.(Object.assign(new StepError('paused', 'paused while connecting to serve-sim'), { exit: EXIT.paused }));
  };
  const close = () => {
    interrupt.waiters.delete(onSig);
    if (ws) {
      ws.onopen = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch {}
    }
  };
  // Interruption must unwind the enclosing command lock even before the
  // socket opens. A hard process kill still leaves the conservative lock.
  interrupt.waiters.add(onSig);
  try {
    if (interrupt.hit) throw Object.assign(new StepError('paused', 'paused before connecting to serve-sim'), { exit: EXIT.paused });
    ws = new WebSocket(h.wsUrl);
    ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => {
      rejectConnect = rej;
      timer = setTimeout(() => rej(new Error('websocket connect timeout')), 5000);
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`websocket connect failed: ${h.wsUrl}`));
      ws.onclose = () => {
        closed = true;
        rejectConnect?.(new Error('websocket closed while connecting'));
      };
    });
  } catch (e) {
    close();
    throw e;
  } finally {
    clearTimeout(timer);
    rejectConnect = null;
    interrupt.waiters.delete(onSig);
    if (ws) ws.onopen = ws.onerror = null;
  }
  let down = null; // a touch that has begun but not ended
  const paused = () => interrupt.hit || fs.existsSync(pausePath) || (process.env.SIMOPS_PAUSE_FILE ? fs.existsSync(process.env.SIMOPS_PAUSE_FILE) : false);
  const partial = (what, done, total) => new StepError('paused', `paused during ${what}: ${done} of ${total} sent; the input is partial and cannot be undone`, { partial: true });
  const send = (type, obj) => {
    if (closed || ws.readyState !== WebSocket.OPEN) throw new StepError('connection_lost', 'serve-sim connection closed');
    const b = new TextEncoder().encode(JSON.stringify(obj));
    const msg = new Uint8Array(1 + b.length); msg[0] = type; msg.set(b, 1);
    ws.send(msg);
  };
  const getJson = async p => {
    const r = await fetch(`${h.http}${p}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new StepError('tool_error', `${p} HTTP ${r.status}`);
    return r.json();
  };
  const key = async (u, shift) => {
    if (shift) send(6, { type: 'down', usage: 225 });
    send(6, { type: 'down', usage: u }); send(6, { type: 'up', usage: u });
    if (shift) send(6, { type: 'up', usage: 225 });
    await sleep(4);
  };
  return {
    readAx: () => getJson('/ax'),
    foreground: async () => { try { return (await getJson('/foreground')).bundleId ?? null; } catch { return null; } },
    tap: async (x, y) => { down = { x, y }; send(3, { type: 'begin', x, y }); await sleep(40); send(3, { type: 'end', x, y }); down = null; await sleep(10); },
    releaseTouch: () => { if (down) { const d = down; down = null; send(3, { type: 'end', x: d.x, y: d.y }); } },
    swipe: async (from, to, ms) => {
      const n = Math.max(4, Math.round(ms / 16));
      let x = from[0], y = from[1];
      down = { x, y };
      send(3, { type: 'begin', x, y });
      for (let i = 1; i <= n; i++) {
        if (paused()) { send(3, { type: 'end', x, y }); down = null; throw partial('swipe', i - 1, n); } // lift the finger first
        await sleep(ms / n);
        x = from[0] + (to[0] - from[0]) * i / n; y = from[1] + (to[1] - from[1]) * i / n;
        down = { x, y };
        send(3, { type: 'move', x, y });
      }
      send(3, { type: 'end', x: to[0], y: to[1] }); down = null; await sleep(10);
    },
    typeText: async text => {
      const chars = [...text];
      for (const c of chars) if (!HID[c]) throw new StepError('unsupported_text', `character ${JSON.stringify(c)} not on US keyboard; use the platform text tool instead`);
      for (let i = 0; i < chars.length; i++) {
        if (i > 0 && i % 16 === 0 && paused()) throw partial('typing', i, chars.length); // whole key strokes only
        await key(HID[chars[i]].u, HID[chars[i]].s);
      }
    },
    key: async name => { const u = KEYS[name.toLowerCase()]; if (!u) throw new StepError('bad_key', `unknown key ${name}`); await key(u); },
    button: async name => { send(4, { button: name }); await sleep(60); },
    paused,
    now: () => performance.now(),
    sleep,
    close,
  };
}

// ---------- commands ----------

async function cmdDoctor(o) {
  const ss = findServeSim();
  const report = {
    node: process.version,
    node_ok: Number(process.versions.node.split('.')[0]) >= 22,
    xcode: (() => { try { return execFileSync('xcodebuild', ['-version'], { encoding: 'utf8', timeout: 10000 }).split('\n')[0]; } catch { return null; } })(),
    booted: (() => { try { return bootedDevices(); } catch { return []; } })(),
    serve_sim: ss ? { from: ss.from } : null,
    state_dir: '$SIMOPS_STATE_DIR or $XDG_STATE_HOME/browser-sim-ops',
  };
  if (o.udid) {
    // Separate facts: helper process/health, AX readability, lease, pause.
    // Whether a user's client actually shows the mirror is not observable here.
    let h = null, helper;
    try { h = await helperFor(o.udid); helper = h ? { state: 'healthy', pid: h.pid, url: h.url } : { state: 'absent' }; }
    catch (e) { helper = { state: 'unhealthy', error: e.message }; }
    let ax = { state: 'not_checked' };
    if (h) {
      const a = performance.now();
      try {
        const r = await fetch(`${h.http}/ax`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const snap = flattenAx(await r.json());
        ax = { state: 'readable', elements: snap.elements.length };
      } catch (e) { ax = { state: e.code === 'bad_snapshot' ? 'no_valid_screen' : 'unreadable', error: e.message }; }
      ax.ms = Math.round(performance.now() - a);
    }
    report.device = {
      udid: o.udid, helper, ax, lease: readJson(leaseFile(o.udid)), paused: fs.existsSync(pauseFile(o.udid)),
      client_view: { state: 'unknown', note: 'helper health and AX do not show what a client displays; check the mirror or panel with that client\'s own screenshot tool' },
    };
  }
  report.ready = report.node_ok && !!report.xcode && !!ss;
  out(report);
  if (!report.ready) process.exitCode = EXIT.failed;
}

async function cmdStart(o) {
  need(o, 'udid', 'owner');
  if (!bootedDevices().some(d => d.udid === o.udid)) throw Object.assign(new Error(`simulator ${o.udid} is not booted`), { exit: EXIT.failed });
  const lf = leaseFile(o.udid);
  const busy = l => Object.assign(new Error(`device leased by "${l.owner}" since ${l.acquired_at}; ask that owner to stop, do not take over`), { exit: EXIT.busy, holder: l });
  let lease = readJson(lf), created = false;
  if (!lease && fs.existsSync(lf)) throw new Error('lease file is unreadable or invalid; inspect it before proceeding');
  if (lease && lease.owner !== o.owner) throw busy(lease);
  if (lease?.start_pending) throw new Error('previous helper start outcome is unknown; inspect state before starting again');
  if (!lease) {
    // Claim atomically before touching the device; a concurrent start loses here.
    lease = { owner: o.owner, udid: o.udid, acquired_at: new Date().toISOString(), started_helper: false, helper_pid: null };
    try { fs.writeFileSync(lf, JSON.stringify(lease, null, 2), { flag: 'wx', mode: 0o600 }); created = true; }
    catch (e) { if (e.code !== 'EEXIST') throw e; const other = readJson(lf); if (other?.owner !== o.owner) throw busy(other ?? { owner: 'unknown' }); lease = other; }
  }
  const t0 = performance.now();
  let h, startedNow = false, attempted = false, helperCommand = lease.helper_command;
  try {
    if (lease.started_helper && (!Number.isInteger(lease.helper_pid) || lease.helper_pid <= 1))
      throw new Error('invalid owned helper PID; lease retained');
    if (lease.started_helper && alive(lease.helper_pid)) {
      const currentStart = lease.helper_started && lease.start_clock === START_CLOCK ? processStart(lease.helper_pid) : null;
      if (lease.helper_started && !currentStart) throw new Error('cannot compare owned helper start time; lease retained');
      if ((!currentStart || currentStart === lease.helper_started) && processIdentity(lease.helper_pid, o.udid, helperCommand) !== 'serve-sim')
        throw new Error('owned PID is still alive but cannot be identified; lease retained');
    }
    h = await helperFor(o.udid, helperCommand);
    if (lease.started_helper && !['gone', 'other'].includes(processIdentity(lease.helper_pid, o.udid, helperCommand)) && (!h || h.pid !== lease.helper_pid))
      throw new Error('owned PID is still alive but helper identity changed or metadata is missing; lease retained');
    if (!h) {
      const source = findServeSim();
      helperCommand = source ? path.resolve(source.pre[0] ?? source.cmd) : null;
      attempted = true;
      fs.writeFileSync(lf, JSON.stringify({ ...lease, start_pending: true, helper_command: helperCommand }), { mode: 0o600 });
      const r = serveSim(['--detach', '-q', o.udid], { source });
      if (r.status !== 0) throw Object.assign(new Error(`serve-sim start failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`), { exit: EXIT.failed });
      for (let i = 0; i < 50 && !(h = await helperFor(o.udid, helperCommand)); i++) await sleep(100);
      if (!h) throw Object.assign(new Error('serve-sim helper did not become healthy'), { exit: EXIT.failed });
      startedNow = true;
    }
  } catch (e) {
    if (attempted) {
      const st = helperState(o.udid);
      const known = st?.device === o.udid && !['gone', 'other'].includes(processIdentity(st.pid, o.udid, helperCommand));
      fs.writeFileSync(lf, JSON.stringify({ ...lease, start_pending: !known, started_helper: known, helper_pid: known ? st.pid : null,
        helper_started: known ? processStart(st.pid) : null, start_clock: START_CLOCK, helper_command: helperCommand }), { mode: 0o600 });
    } else if (created) fs.rmSync(lf, { force: true });
    throw e;
  }
  // We own the helper only if we started it, or it is still the very process we started earlier.
  // Same PID is not enough when a start time was recorded: it must be the same process instance.
  const hStarted = processStart(h.pid);
  if (!startedNow && lease.started_helper && lease.helper_pid === h.pid && lease.helper_started && lease.start_clock === START_CLOCK && !hStarted)
    throw new Error(`cannot read the start time of owned helper pid ${h.pid}; lease retained`);
  const sameInstance = lease.started_helper && lease.helper_pid === h.pid &&
    (!lease.helper_started || lease.start_clock !== START_CLOCK || lease.helper_started === hStarted);
  const owns = startedNow || sameInstance;
  if (lease.start_pending) throw new Error('previous start outcome remains unknown; inspect it before reusing this lease');
  const rec = { ...lease, start_pending: false, started_helper: owns, helper_pid: owns ? h.pid : null,
    helper_started: owns ? hStarted : null, start_clock: START_CLOCK, helper_command: owns ? helperCommand : null };
  fs.writeFileSync(lf, JSON.stringify(rec, null, 2));
  out({ status: 'ok', reused_helper: !startedNow, started_helper: owns, helper_pid: h.pid, url: h.url, start_ms: Math.round(performance.now() - t0) });
}

async function cmdAx(o) {
  need(o, 'udid');
  const limit = o.limit === undefined ? 60 : Number(o.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw usage('--limit must be a positive safe integer');
  const h = await helperFor(o.udid);
  if (!h) throw Object.assign(new Error('no serve-sim helper for this UDID; run start first'), { exit: EXIT.failed });
  const t0 = performance.now();
  const raw = await (await fetch(`${h.http}/ax`, { signal: AbortSignal.timeout(10000) })).json();
  const fg = await (await fetch(`${h.http}/foreground`, { signal: AbortSignal.timeout(5000) })).json().catch(() => ({}));
  out({ foreground: fg.bundleId ?? null, ax_ms: Math.round(performance.now() - t0), ...summarize(flattenAx(raw), limit, null, limit) });
}

/** Read and validate the plan before any lock is taken (stdin may block). */
function preparePlan(o) {
  need(o, 'udid', 'owner', 'plan');
  if (typeof WebSocket !== 'function')
    throw Object.assign(new Error(`Node ${process.version} has no global WebSocket; Node 22 or newer is required`), { exit: EXIT.failed });
  let plan;
  try { plan = JSON.parse(o.plan === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(o.plan, 'utf8')); }
  catch (e) { throw usage(`cannot read plan: ${e.message}`); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw usage('plan must be an object');
  if (plan.udid && String(plan.udid).toUpperCase() !== o.udid) throw usage('plan.udid differs from --udid');
  plan.udid = o.udid;
  try { validatePlan(plan); } catch (e) { throw usage(e.message); }
  return plan;
}

async function cmdRun(o, plan) {
  const lease = readJson(leaseFile(o.udid));
  if (!lease || lease.owner !== o.owner)
    throw Object.assign(new Error(lease ? `device leased by "${lease.owner}", not "${o.owner}"` : 'no lease for this device; run start first'), { exit: EXIT.busy });
  if (o['pause-file']) process.env.SIMOPS_PAUSE_FILE = o['pause-file'];
  const h = await helperFor(o.udid);
  if (!h) throw Object.assign(new Error('serve-sim helper not running for this UDID; run start again'), { exit: EXIT.failed });
  const t = await openTransport(h, pauseFile(o.udid));
  activeTransport = t;
  let result;
  try { result = await runPlan(plan, t); }
  catch (e) { if (e.code === 'bad_plan') throw usage(e.message); throw e; }
  finally { activeTransport = null; t.close(); }
  if (o.screenshot && interrupt.hit) result.screenshot = { skipped: 'interrupted' };
  else if (o.screenshot && o.screenshot !== true) {
    const a = performance.now();
    const r = spawnSync('xcrun', ['simctl', 'io', o.udid, 'screenshot', o.screenshot], { encoding: 'utf8', timeout: 10000 });
    result.screenshot = r.status === 0 ? { path: o.screenshot, ms: Math.round(performance.now() - a) } : { error: r.stderr.trim() };
  }
  try {
    fs.appendFileSync(path.join(stateDir(), 'runs.jsonl'), JSON.stringify({
      at: new Date().toISOString(), udid: o.udid, owner: o.owner, status: result.status, total_ms: result.total_ms,
      ax_reads: result.ax_reads, actions: result.actions, actions_attempted: result.actions_attempted, error: result.error?.code ?? null,
      steps: result.steps.map(s => ({ i: s.i, kind: s.kind, ms: s.ms })),
    }) + '\n', { mode: 0o600 });
  } catch { /* logging is best effort */ }
  out(result);
  process.exitCode = EXIT[result.status] ?? EXIT.failed;
}

function cmdPause(o, on) {
  need(o, 'udid');
  const f = pauseFile(o.udid);
  if (on) fs.writeFileSync(f, new Date().toISOString()); else fs.rmSync(f, { force: true });
  out({ status: 'ok', paused: on });
}

async function cmdStop(o) {
  need(o, 'udid', 'owner');
  const lf = leaseFile(o.udid);
  const lease = readJson(lf);
  if (!lease) {
    if (fs.existsSync(lf)) throw new Error('invalid lease file; not releasing');
    out({ status: 'ok', note: 'no lease held; nothing released' }); return;
  }
  if (lease.owner !== o.owner) throw Object.assign(new Error(`lease belongs to "${lease.owner}"; not releasing`), { exit: EXIT.busy });
  const helper = await stopOwnedHelper(lease, {
    alive, identity: pid => processIdentity(pid, o.udid, lease.helper_command), startOf: processStart, clock: START_CLOCK, readState: () => helperState(o.udid),
    terminate: pid => process.kill(pid, 'SIGTERM'), sleep,
  });
  const res = { status: 'ok', helper };
  fs.rmSync(lf, { force: true });
  // A user pause is deliberately left in place; only the user lifts it (resume).
  res.lease = 'released';
  if (fs.existsSync(pauseFile(o.udid))) res.note = 'device is still paused by the user';
  out(res);
}

// ---------- main ----------

const o = (() => { try { return parseArgs(process.argv.slice(2)); } catch (e) { return { _: 'error', err: e }; } })();
function cmdUnlock(o) {
  need(o, 'udid', 'owner');
  out(unlockStale(stateDir(), o.udid, o.owner, { alive, startOf: processStart, clock: START_CLOCK }));
}

const table = { doctor: cmdDoctor, start: cmdStart, ax: cmdAx, run: cmdRun, stop: cmdStop, unlock: cmdUnlock, pause: x => cmdPause(x, true), resume: x => cmdPause(x, false) };
let untrap = null, releaseLock = null;
try {
  if (o.err) throw o.err;
  if (o.udid !== undefined && !/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(String(o.udid)))
    throw usage('--udid must be a simulator UDID (8-4-4-4-12 hex)');
  if (o.udid) o.udid = String(o.udid).toUpperCase();
  const fn = table[o._];
  if (!fn) throw usage(`usage: simops.mjs <${Object.keys(table).join('|')}> [--udid U] [--owner NAME] [--plan FILE|-]`);
  if (['start', 'run', 'stop'].includes(o._)) {
    need(o, 'udid', 'owner');
    const plan = o._ === 'run' ? preparePlan(o) : null;
    untrap = trapSignals(() => {
      let cleanupError;
      try { releaseLock?.(); } catch (e) { cleanupError = e.message; }
      out({ status: 'error', ...(cleanupError ? { lock_cleanup_error: cleanupError } : {}), error: `second interrupt during ${o._}; exited before it finished. ${o._ === 'run'
        ? 'The outcome of the last action is unknown: verify it, do not resend.' : 'Inspect the lease and helper before continuing.'}` });
      process.exit(o._ === 'run' ? EXIT.unknown : EXIT.failed);
    });
    await withDeviceLock(stateDir(), o.udid, o._, o.owner, release => { releaseLock = release; return fn(o, plan); }, { started: processStart(process.pid), start_clock: START_CLOCK });
  } else await fn(o);
} catch (e) {
  out({ status: 'error', error: e.message, ...(e.holder ? { holder: e.holder } : {}) });
  process.exitCode = e.exit ?? EXIT.failed;
} finally { untrap?.(); }
