import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/simops.mjs', import.meta.url));
const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-start-'));
  try {
    const state = path.join(dir, 'state');
    fs.mkdirSync(path.join(state, 'leases'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'serve-sim'));
    const leaseFile = path.join(state, 'leases', `${udid}.json`);
    const helperFile = path.join(dir, 'serve-sim', `server-${udid}.json`);
    const preload = path.join(dir, 'fake-host.mjs');
    fs.writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      process.kill = (pid, signal) => {
        assert.equal(signal, 0, 'must not send a real signal');
        if (JSON.parse(process.env.FAKE_ALIVE).includes(pid)) return true;
        throw Object.assign(new Error('fake exited'), { code: 'ESRCH' });
      };
      cp.execFileSync = (command, args) => {
        if (command === 'ps') {
          const pid = Number(args[1]);
          if (!JSON.parse(process.env.FAKE_ALIVE).includes(pid)) throw new Error('no such process');
          return JSON.parse(process.env.FAKE_ARGS ?? '{}')[pid] ?? 'node /fixture/serve-sim/dist/serve-sim.js --detach';
        }
        assert.equal(command, 'xcrun');
        assert.deepEqual(args, ['simctl', 'list', 'devices', 'booted', '-j']);
        return JSON.stringify({ devices: { fixture: [{ udid: '${udid}', state: 'Booted' }] } });
      };
      cp.spawnSync = () => assert.fail('must not launch or discover another helper');
      syncBuiltinESMExports();
      globalThis.fetch = async () => ({ ok: true });
    `);
    const run = (lease, helper, alive = [123, 456], owner = 'test') => {
      fs.writeFileSync(leaseFile, JSON.stringify(lease));
      if (helper) fs.writeFileSync(helperFile, JSON.stringify(helper));
      else fs.rmSync(helperFile, { force: true });
      const before = fs.readFileSync(leaseFile, 'utf8');
      const result = spawnSync(process.execPath, ['--import', preload, script, 'start', '--udid', udid, '--owner', owner], {
        env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, SIMOPS_STATE_DIR: state, FAKE_ALIVE: JSON.stringify(alive) },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(fs.existsSync(path.join(state, 'locks', udid)), false, 'command lock must be released');
      return { ...result, before, after: fs.readFileSync(leaseFile, 'utf8') };
    };
    fn(run);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const lease = { owner: 'test', udid, acquired_at: 'fixture', started_helper: true, helper_pid: 123 };
const helper = pid => ({ device: udid, pid, wsUrl: 'ws://127.0.0.1:12345/ws', url: 'http://127.0.0.1:12345' });

test('start preserves ownership when a live owned helper is replaced or loses metadata', () => fixture(run => {
  for (const metadata of [helper(456), null, { ...helper(123), device: 'OTHER' }]) {
    const result = run(lease, metadata);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /identity changed|metadata is missing/);
    assert.equal(result.after, result.before, 'must retain the original helper cleanup responsibility');
  }
}));

test('start reuses its unchanged helper and does not claim a replacement after its PID exited', () => fixture(run => {
  const same = run(lease, helper(123));
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.equal(JSON.parse(same.after).helper_pid, 123);
  assert.equal(JSON.parse(same.after).started_helper, true);
  const replacement = run(lease, helper(456), [456]);
  assert.equal(replacement.status, 0, replacement.stdout + replacement.stderr);
  assert.equal(JSON.parse(replacement.after).helper_pid, null);
  assert.equal(JSON.parse(replacement.after).started_helper, false);
}));

test('start does not steal another owner or retry an unknown start', () => fixture(run => {
  const other = run({ ...lease, owner: 'other' }, helper(123));
  assert.equal(other.status, 4);
  assert.equal(other.after, other.before);
  const pending = run({ ...lease, start_pending: true }, helper(123));
  assert.equal(pending.status, 1);
  assert.match(pending.stdout, /outcome is unknown/);
  assert.equal(pending.after, pending.before);
  const invalid = run({ ...lease, helper_pid: 0 }, helper(123));
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /invalid owned helper PID/);
  assert.equal(invalid.after, invalid.before);
}));
