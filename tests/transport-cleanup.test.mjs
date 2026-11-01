import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/simops.mjs', import.meta.url));
const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

function execute(command, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-transport-'));
  try {
    fs.mkdirSync(path.join(dir, 'leases'));
    fs.mkdirSync(path.join(dir, 'serve-sim'));
    fs.writeFileSync(path.join(dir, 'leases', `${udid}.json`), JSON.stringify({ udid, owner: 'test' }));
    fs.writeFileSync(path.join(dir, 'serve-sim', `server-${udid}.json`), JSON.stringify({
      device: udid, pid: 123, wsUrl: 'ws://127.0.0.1:12345/ws',
    }));
    const plan = path.join(dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify({ steps: [{ assert: { label: 'Ready' } }, { assert: { label: 'Ready' } }] }));
    const probe = path.join(dir, 'probe.json');
    const preload = path.join(dir, 'fake-transport.mjs');
    fs.writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const mode = process.env.FAKE_MODE;
      const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const state = { sockets: 0, closes: 0, ax: 0 };
      const sockets = [], timers = new Set();
      const originalTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const originalKill = process.kill;
      globalThis.setTimeout = (fn, ms, ...args) => {
        const timer = originalTimeout(() => { timers.delete(timer); fn(...args); }, mode === 'timeout' && ms === 5000 ? 5 : ms);
        timers.add(timer);
        return timer;
      };
      globalThis.clearTimeout = timer => { timers.delete(timer); originalClearTimeout(timer); };
      process.kill = (pid, signal) => { assert.equal(pid, 123); assert.equal(signal, 0); return true; };
      cp.spawnSync = cp.execFileSync = () => assert.fail('must not run a host tool');
      syncBuiltinESMExports();
      globalThis.WebSocket = class {
        static OPEN = 1;
        constructor() {
          if (mode === 'constructor-error') throw new Error('fixture WebSocket constructor failure');
          state.sockets++; this.readyState = 0;
          sockets.push(this);
          if (mode.startsWith('connect-signal-')) {
            originalTimeout(() => originalKill(process.pid, mode.slice('connect-signal-'.length)), 20);
          } else if (mode !== 'timeout') queueMicrotask(() => {
            if (mode === 'connect-error') this.onerror();
            else if (mode === 'connect-close') { this.readyState = 3; this.onclose?.(); }
            else { this.readyState = 1; this.onopen(); }
          });
        }
        close() { state.closes++; this.readyState = 3; this.onclose?.(); }
        send() { assert.fail('read-only fixture must not send input'); }
      };
      globalThis.fetch = async url => {
        if (url.endsWith('/ax')) {
          state.ax++;
          if (mode === 'read-error') throw new Error('fixture AX failure');
          if (mode === 'signal' && state.ax === 1) process.emit('SIGTERM');
          return { ok: true, json: async () => [{ AXLabel: 'App', type: 'Application',
            frame: { x: 0, y: 0, width: 400, height: 800 }, children: [{ AXLabel: 'Ready', type: 'StaticText',
              frame: { x: 10, y: 10, width: 100, height: 40 }, children: [] }] }] };
        }
        return { ok: true, json: async () => ({ bundleId: 'com.example.app' }) };
      };
      process.on('exit', () => fs.writeFileSync(process.env.FAKE_PROBE, JSON.stringify({ ...state, before,
        timers: timers.size, handlers: sockets.filter(ws => ws.onopen || ws.onerror || ws.onclose).length,
        after: [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')] })));
    `);
    const args = [command, '--udid', udid];
    if (command === 'run') args.push('--owner', 'test', '--plan', plan);
    const result = spawnSync(process.execPath, ['--import', preload, script, ...args], {
      env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, SIMOPS_STATE_DIR: dir, FAKE_MODE: mode, FAKE_PROBE: probe },
      encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.error, undefined);
    assert.equal(fs.existsSync(path.join(dir, 'locks', udid)), false);
    const observation = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.equal(observation.timers, 0);
    assert.equal(observation.handlers, 0);
    return { ...result, probe: observation };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('run closes its one WebSocket and removes signal listeners on completion, read failure and interruption', () => {
  for (const [mode, exit] of [['ok', 0], ['read-error', 1], ['signal', 5]]) {
    const result = execute('run', mode);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    assert.equal(result.probe.sockets, 1);
    assert.equal(result.probe.closes, 1);
    assert.deepEqual(result.probe.after, result.probe.before);
  }
});

test('connection failures release sockets, timers, listeners and command locks', () => {
  for (const mode of ['connect-error', 'timeout', 'connect-close', 'constructor-error']) {
    const result = execute('run', mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.probe.closes, mode === 'constructor-error' ? 0 : 1);
    assert.deepEqual(result.probe.after, result.probe.before);
    assert.equal(result.probe.ax, 0);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during pending connection releases socket, listeners and command lock`, () => {
    const result = execute('run', `connect-signal-${signal}`);
    assert.equal(result.status, 5, result.stdout + result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.probe.closes, 1);
    assert.deepEqual(result.probe.after, result.probe.before);
    assert.equal(result.probe.ax, 0);
    assert.match(JSON.parse(result.stdout).error, /paused.*connect/);
  });
}

test('read-only ax uses bounded HTTP reads without opening a WebSocket', () => {
  for (const [mode, exit] of [['ok', 0], ['read-error', 1]]) {
    const result = execute('ax', mode);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    assert.equal(result.probe.sockets, 0);
    assert.equal(result.probe.closes, 0);
    assert.deepEqual(result.probe.after, result.probe.before);
  }
});
