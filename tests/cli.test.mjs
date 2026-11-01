import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/simops.mjs', import.meta.url));
const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
function isolated(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-cli-'));
  try {
    fs.mkdirSync(path.join(dir, 'leases'));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, SIMOPS_STATE_DIR: dir }, encoding: 'utf8', timeout: 5000 });
    fn(dir, run);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('CLI uses the same command lock for lowercase/uppercase UDID, before touching a device', () => isolated((dir, run) => {
  fs.mkdirSync(path.join(dir, 'locks', udid), { recursive: true });
  const plan = path.join(dir, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ steps: [{ assert: { label: 'Ready' } }] }));
  for (const command of ['start', 'run', 'stop']) {
    const extra = command === 'run' ? ['--plan', plan] : [];
    const r = run(command, '--udid', udid.toLowerCase(), '--owner', 'test', ...extra);
    assert.equal(r.status, 4, r.stdout + r.stderr);
  }
}));

test('CLI rejects a malformed later plan before connecting and releases command lock', () => isolated((dir, run) => {
  fs.writeFileSync(path.join(dir, 'leases', `${udid}.json`), JSON.stringify({ udid, owner: 'test' }));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ steps: [{ type: 'first' }, { type: 42 }] }));
  const r = run('run', '--udid', udid, '--owner', 'test', '--plan', file);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /type supports/);
  assert.equal(fs.existsSync(path.join(dir, 'locks', udid)), false);
}));

test('CLI stop does not erase an unreadable lease', () => isolated((dir, run) => {
  const file = path.join(dir, 'leases', `${udid}.json`);
  fs.writeFileSync(file, '{broken');
  const r = run('stop', '--udid', udid, '--owner', 'test');
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
}));
