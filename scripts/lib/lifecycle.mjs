import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const readHolder = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'holder.json'), 'utf8')); } catch { return null; } };

// All changes to a device's lock name share this short, synchronous gate.
// Hard interruption leaves it closed; do not recursively invent stale-gate recovery.
function transition(base, udid, fn) {
  const dir = path.join(base, 'locks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gate = path.join(dir, `${udid}.transition`);
  try { fs.mkdirSync(gate, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw Object.assign(new Error(`lock transition in progress or interrupted: ${gate}; retry after the command exits. If it persists, confirm all device commands have stopped before manually removing this gate`), { exit: 4 });
  }
  try { return fn(path.join(dir, udid)); }
  finally { fs.rmdirSync(gate); }
}

// Cooperative lock for every mutating CLI command, including the same owner.
// A crash leaves a visible lock: never infer permission to take over from age.
export async function withDeviceLock(base, udid, command, owner, fn, instance = {}) {
  const token = randomUUID();
  transition(base, udid, lock => {
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw Object.assign(new Error(`device command in progress or stale lock: ${lock}; if its holder process has exited, run "unlock" as the same owner (it checks the holder first)`), { exit: 4 });
    }
    try {
      fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify({ token, pid: process.pid, started: instance.started ?? null, start_clock: instance.start_clock ?? null, command, owner, at: new Date().toISOString() }), { mode: 0o600 });
    } catch (e) { fs.rmSync(lock, { recursive: true, force: true }); throw e; }
  });
  const release = () => transition(base, udid, lock => {
    if (readHolder(lock)?.token === token) fs.rmSync(lock, { recursive: true, force: true });
  });
  try { return await fn(release); }
  finally { release(); }
}

// Only the recorded owner may remove a stale lock, after proving the holder
// instance exited. Acquisition and release cannot change it during this check.
export function unlockStale(base, udid, owner, { alive, startOf, clock }) {
  return transition(base, udid, lock => {
    if (!fs.existsSync(lock)) return { status: 'ok', note: 'no lock present' };
    const holder = readHolder(lock);
    if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 1)
      throw Object.assign(new Error('lock has no readable holder; inspect it manually and confirm no command is running before removing it'), { exit: 4 });
    if (holder.owner !== owner)
      throw Object.assign(new Error(`lock belongs to "${holder.owner}"; only that owner may unlock it`), { exit: 4, holder });
    if (holder.pid === process.pid) throw Object.assign(new Error('lock is held by this process'), { exit: 4 });
    if (alive(holder.pid)) {
      const now = holder.start_clock === clock ? startOf(holder.pid) : null;
      if (!holder.started || !now || now === holder.started)
        throw Object.assign(new Error(`holder pid ${holder.pid} is ${holder.started && now ? 'still the same running process' : 'alive and its start time cannot be compared'}; not unlocking`), { exit: 4, holder });
    }
    fs.rmSync(lock, { recursive: true, force: true });
    return {
      status: 'ok', removed: holder,
      note: `previous "${holder.command}" was interrupted; if it was a run, verify the outcome of its last action before running again (do not resend a commit)`,
    };
  });
}

// A failed health request is not process-exit evidence. Terminate only the
// recorded PID, only while it is still serve-sim with matching device
// metadata; a recycled PID or a replacement helper is never signalled.
// identity(pid) -> 'gone' | 'serve-sim' | 'other' | 'unknown'.
export async function stopOwnedHelper(lease, { alive, identity, readState, terminate, sleep, startOf = () => null, clock = null }) {
  if (lease.start_pending) throw new Error('previous helper start outcome is unknown; inspect helper state/process before releasing the lease');
  if (!lease.started_helper) return 'kept (not started by this owner)';
  const pid = lease.helper_pid;
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid owned helper PID; lease retained');
  if (!alive(pid)) return `already exited; pid ${pid}`;
  // Compare start times only when both were read the same way (see START_CLOCK).
  const nowStarted = lease.helper_started && lease.start_clock === clock ? startOf(pid) : null;
  if (lease.helper_started && !nowStarted)
    throw new Error(`cannot compare the start time of owned helper pid ${pid}; lease retained`);
  if (nowStarted && nowStarted !== lease.helper_started)
    return `already exited; pid ${pid} now belongs to a newer process and was not signalled`;
  const who = identity(pid);
  if (who === 'gone') return `already exited; pid ${pid}`;
  if (who !== 'serve-sim') throw new Error(`cannot confirm pid ${pid} is still serve-sim; lease retained`);
  const current = readState();
  if (current?.pid !== pid || current?.device !== lease.udid)
    throw new Error('owned PID is still alive but helper identity changed or metadata is missing; lease retained');
  terminate(pid);
  for (let i = 0; i < 50; i++) {
    if (!alive(pid) || identity(pid) === 'gone') return `stopped; pid ${pid} verified exited`;
    const after = nowStarted ? startOf(pid) : null;
    if (after && after !== nowStarted) return `stopped; pid ${pid} verified exited`;
    await sleep(100);
  }
  throw new Error(`helper pid ${pid} is still running; lease retained`);
}
