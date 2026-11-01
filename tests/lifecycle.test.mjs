import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withDeviceLock, stopOwnedHelper, unlockStale } from '../scripts/lib/lifecycle.mjs';

async function temp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-test-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('same owner cannot overlap run, stop or start; lock is removed on normal and failed exits', async () => temp(async dir => {
  let release; const pending = new Promise(r => { release = r; });
  const first = withDeviceLock(dir, 'U', 'run', 'same', () => pending);
  for (const cmd of ['run', 'stop', 'start'])
    await assert.rejects(withDeviceLock(dir, 'U', cmd, 'same', () => assert.fail('must not enter')), e => e.exit === 4);
  release(); await first;
  await assert.rejects(withDeviceLock(dir, 'U', 'run', 'other', () => { throw new Error('failure'); }), /failure/);
  await withDeviceLock(dir, 'U', 'run', 'other', async () => {});
  assert.equal(fs.existsSync(path.join(dir, 'locks', 'U')), false);
}));

test('stale or incomplete lock is never stolen', async () => temp(async dir => {
  fs.mkdirSync(path.join(dir, 'locks', 'U'), { recursive: true });
  await assert.rejects(withDeviceLock(dir, 'U', 'run', 'same', () => {}), e => e.exit === 4);
}));

const lease = { udid: 'U', started_helper: true, helper_pid: 123 };
const base = { readState: () => ({ device: 'U', pid: 123 }), identity: () => 'serve-sim', sleep: async () => {} };

test('owned unhealthy but alive helper must actually exit before release', async () => {
  let living = true; let killed = null;
  const result = await stopOwnedHelper(lease, { ...base, alive: () => living, terminate: pid => { killed = pid; living = false; } });
  assert.equal(killed, 123);
  assert.match(result, /verified exited/);
  await assert.rejects(stopOwnedHelper(lease, { ...base, alive: () => true, terminate: () => {} }), /still running/);
});

test('changed helper identity, unknown startup and malformed PID do not release or kill', async () => {
  const deps = { ...base, alive: () => true, terminate: () => assert.fail('must not kill') };
  await assert.rejects(stopOwnedHelper(lease, { ...deps, readState: () => ({ device: 'U', pid: 456 }) }), /identity changed/);
  await assert.rejects(stopOwnedHelper({ ...lease, start_pending: true }, deps), /unknown/);
  await assert.rejects(stopOwnedHelper({ ...lease, helper_pid: 0 }, deps), /invalid/);
});

test('borrowed helper is kept and an exited owned PID needs no health request', async () => {
  const deps = { ...base, alive: () => false, readState: () => assert.fail('no metadata needed'), terminate: () => assert.fail('must not kill') };
  assert.match(await stopOwnedHelper({ started_helper: false }, deps), /kept/);
  assert.match(await stopOwnedHelper(lease, deps), /already exited/);
});

test('a recorded helper start time that no longer matches is never signalled; a matching one is', async () => {
  const owned = { ...lease, helper_started: 'A', start_clock: 'C' };
  const deps = { ...base, alive: () => true, clock: 'C', terminate: () => assert.fail('must not kill a recycled PID') };
  assert.match(await stopOwnedHelper(owned, { ...deps, startOf: () => 'B' }), /newer process/);
  let living = true;
  const r = await stopOwnedHelper(owned, { ...base, clock: 'C', startOf: () => 'A', alive: () => living, terminate: () => { living = false; } });
  assert.match(r, /verified exited/);
  // A non-comparable recorded clock cannot prove ownership of this instance.
  await assert.rejects(stopOwnedHelper({ ...owned, start_clock: 'other' }, { ...deps, startOf: () => 'B' }), /lease retained/);
});


test('recorded start time unavailable or incomparable retains the lease without signalling', async () => {
  const owned = { ...lease, helper_started: 'A', start_clock: 'C' };
  for (const clock of ['C', 'other']) {
    await assert.rejects(stopOwnedHelper(owned, { ...base, clock, alive: () => true, startOf: () => null,
      terminate: () => assert.fail('must not signal an unverified instance') }), /lease retained/);
  }
});

test('finally never removes a replacement lock, even with the same PID and owner', async () => temp(async dir => {
  const lock = path.join(dir, 'locks', 'U');
  await withDeviceLock(dir, 'U', 'run', 'same', async () => {
    const holder = JSON.parse(fs.readFileSync(path.join(lock, 'holder.json')));
    fs.rmSync(lock, { recursive: true });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify({ ...holder, token: 'replacement' }));
  });
  assert.equal(fs.existsSync(lock), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'holder.json'))).token, 'replacement');
}));


for (const finish of ['exit', 'SIGKILL']) test(`independent unlock and acquire cannot cross a stale-holder check (${finish})`, async () => temp(async dir => {
  const module = new URL('../scripts/lib/lifecycle.mjs', import.meta.url).href;
  const lock = path.join(dir, 'locks', 'U');
  const checked = path.join(dir, 'checked');
  const resume = path.join(dir, 'resume');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify({ pid: 999999, owner: 'same', command: 'run' }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { unlockStale } from ${JSON.stringify(module)};
    unlockStale(${JSON.stringify(dir)}, 'U', 'same', { alive: () => {
      fs.writeFileSync(${JSON.stringify(checked)}, '');
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(${JSON.stringify(resume)})) {
        if (Date.now() > deadline) throw new Error('parent timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return false;
    } });
  `], { stdio: 'ignore' });
  const done = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(checked)) {
      assert.ok(Date.now() < deadline, 'unlock child reached the stale check');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const contender = body => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { unlockStale, withDeviceLock } from ${JSON.stringify(module)};
      try { ${body}; process.exitCode = 9; } catch (e) { process.exitCode = e.exit === 4 ? 0 : 8; }
    `], { timeout: 3000, encoding: 'utf8' });
    assert.equal(contender(`unlockStale(${JSON.stringify(dir)}, 'U', 'same', { alive: () => false })`).status, 0,
      'second unlock must not remove the checked lock');
    assert.equal(contender(`await withDeviceLock(${JSON.stringify(dir)}, 'U', 'run', 'same', () => {})`).status, 0,
      'acquire must not enter during recovery');
    if (finish === 'SIGKILL') {
      child.kill('SIGKILL');
      assert.deepEqual(await done, { code: null, signal: 'SIGKILL' });
      await assert.rejects(withDeviceLock(dir, 'U', 'run', 'same', () => assert.fail('must not enter')), /transition.*interrupted/);
      assert.throws(() => unlockStale(dir, 'U', 'same', { alive: () => false }), /transition.*interrupted/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'holder.json'))).pid, 999999);
      return;
    }
    fs.writeFileSync(resume, '');
    assert.deepEqual(await done, { code: 0, signal: null });
    await withDeviceLock(dir, 'U', 'run', 'same', async () => {});
    assert.deepEqual(fs.readdirSync(path.join(dir, 'locks')), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
  }
}));
