// Plan runner for iOS Simulator steps. Pure logic: transport is injected,
// so the same rules are unit-tested without a simulator.
//
// Rules enforced here (not just documented):
// - every step re-checks pause before it starts;
// - first failure stops the run, nothing is retried;
// - a step marked commit (submit/save/send) must be the last action and must
//   declare `expect`; if the expectation times out the result is "unknown",
//   and the caller must verify instead of sending it again;
// - an invalid AX snapshot (no screen frame, e.g. during cold start) is never
//   used to locate, tap or prove absence; read-only waits for a valid one are
//   bounded and honour pause;
// - optional stable_ms makes a step's conditions hold across consecutive reads.

export const MAX_STEPS = 20;
const ACTIONS = ['tap', 'type', 'key', 'button', 'swipe', 'wait', 'assert'];
const NEEDS_EXPECT = new Set(['tap', 'button', 'swipe', 'key']);
const COND_KEYS = new Set(['id', 'label', 'labelContains', 'value', 'type', 'nth', 'gone', 'foreground']);
const COND_ANCHORS = ['id', 'label', 'labelContains', 'value', 'foreground'];

/** A condition must name something concrete; typos would otherwise match anything. */
function checkCond(cond, where) {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond))
    throw new StepError('bad_plan', `${where}: condition must be an object`);
  const unknown = Object.keys(cond).filter(k => !COND_KEYS.has(k));
  if (unknown.length) throw new StepError('bad_plan', `${where}: unknown key(s) ${unknown.join(', ')}`);
  if (!COND_ANCHORS.some(k => cond[k] != null))
    throw new StepError('bad_plan', `${where}: needs one of ${COND_ANCHORS.join('/')}`);
  for (const k of ['id', 'label', 'labelContains', 'value', 'type', 'foreground']) {
    if (cond[k] !== undefined && (typeof cond[k] !== 'string' || (k !== 'value' && !cond[k].length)))
      throw new StepError('bad_plan', `${where}: ${k} must be a nonempty string (value may be empty)`);
  }
  if (cond.foreground !== undefined && Object.keys(cond).length !== 1)
    throw new StepError('bad_plan', `${where}: foreground must be a separate condition; use an additional assert/wait`);
  if (cond.nth !== undefined && (!Number.isInteger(cond.nth) || cond.nth < 0))
    throw new StepError('bad_plan', `${where}: nth must be a nonnegative integer`);
  if (cond.gone !== undefined && typeof cond.gone !== 'boolean')
    throw new StepError('bad_plan', `${where}: gone must be boolean`);
}

/** expect / wait / assert accept one condition or an array (all must hold). */
function checkConds(c, where) {
  if (Array.isArray(c)) {
    if (c.length < 1 || c.length > 8) throw new StepError('bad_plan', `${where}: condition list must have 1–8 items`);
    c.forEach((x, i) => checkCond(x, `${where}[${i}]`));
  } else checkCond(c, where);
}
const condList = c => (Array.isArray(c) ? c : [c]);

/** How strongly a set of conditions can show an outcome: presence > absence > foreground. */
export function verificationOf(c) {
  const list = condList(c);
  if (list.some(x => x.foreground == null && !x.gone)) return 'presence';
  if (list.some(x => x.foreground == null)) return 'absence_only';
  return 'foreground_only';
}

export class StepError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------- AX tree helpers ----------

export function flattenAx(raw) {
  const roots = Array.isArray(raw) ? raw : [raw];
  const screen = roots[0]?.frame;
  if (!screen || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(screen[k])) || screen.width <= 0 || screen.height <= 0)
    throw new StepError('bad_snapshot', 'AX response has no valid screen frame; cannot verify presence or absence');
  const out = [];
  const visit = (n, path) => {
    if (!n || typeof n !== 'object') return;
    out.push({
      path,
      id: n.AXUniqueId ?? null,
      label: n.AXLabel ?? '',
      value: n.AXValue ?? '',
      type: n.type ?? n.role_description ?? '',
      enabled: n.enabled !== false,
      frame: n.frame ?? null,
    });
    (n.children ?? []).forEach((c, i) => visit(c, `${path}.${i}`));
  };
  roots.forEach((r, i) => visit(r, String(i)));
  return { screen, elements: out };
}

function textMatch(el, sel) {
  if (sel.id != null && el.id !== sel.id) return false;
  if (sel.label != null && el.label !== sel.label) return false;
  if (sel.labelContains != null && !String(el.label).includes(sel.labelContains)) return false;
  if (sel.value != null && el.value !== sel.value) return false;
  if (sel.type != null && el.type !== sel.type) return false;
  return true;
}

function hasTextKey(sel) {
  return ['id', 'label', 'labelContains', 'value'].some(k => sel[k] != null);
}

export function onScreen(el, screen) {
  const f = el.frame;
  if (!f || f.width <= 0 || f.height <= 0) return false;
  const cx = f.x + f.width / 2, cy = f.y + f.height / 2;
  return cx >= screen.x && cy >= screen.y &&
    cx <= screen.x + screen.width && cy <= screen.y + screen.height;
}

/** Find exactly one element. Zero or several matches is an error, never a guess. */
export function findOne(snapshot, sel) {
  if (!sel || typeof sel !== 'object' || !hasTextKey(sel))
    throw new StepError('bad_selector', 'selector needs id, label, labelContains or value');
  let hits = snapshot.elements.filter(el => textMatch(el, sel) && el.frame);
  // The application root carries the app name; never treat it as a control.
  hits = hits.filter(el => el.path !== '0');
  if (sel.nth != null) hits = hits[sel.nth] ? [hits[sel.nth]] : [];
  if (hits.length === 0) throw new StepError('not_found', `no element matches ${JSON.stringify(sel)}`);
  if (hits.length > 1)
    throw new StepError('ambiguous', `${hits.length} elements match ${JSON.stringify(sel)}; add id/type/nth`,
      { candidates: hits.slice(0, 8).map(brief) });
  return hits[0];
}

export function matches(snapshot, cond) {
  if (cond.foreground != null) return true; // checked by caller with foreground()
  const sel = { ...cond };
  delete sel.gone;
  const n = snapshot.elements.filter(el => el.path !== '0' && textMatch(el, sel)).length;
  const exists = cond.nth !== undefined ? n > cond.nth : n > 0;
  return cond.gone ? !exists : exists;
}

export function brief(el) {
  const f = el.frame ? [el.frame.x, el.frame.y, el.frame.width, el.frame.height].map(v => Math.round(v)) : null;
  const o = { type: el.type, label: el.label };
  if (el.id) o.id = el.id;
  if (el.value) o.value = el.value;
  if (!el.enabled) o.enabled = false;
  if (f) o.frame = f;
  return o;
}

const OVERLAY = /alert|dialog|sheet|popover|toast|hud|banner|activity|progress|busy|loading/i;
const INTERACTIVE = /button|field|link|switch|toggle|slider|picker|segment|cell|tab|checkbox|menu|search|textview|stepper/i;
const OFFSCREEN_LINES = 10;

/**
 * Compact, model-friendly view of labelled or identified elements.
 * Order: elements matching the last satisfied conditions, overlay-like
 * elements (alerts, sheets, HUD, loading), interactive, then the rest.
 * Off-screen elements are grouped separately rather than silently dropped.
 * AX presence is not proof of visibility, occlusion or tappability.
 */
export function summarize(snapshot, limit = 40, focus = null, offscreenLimit = OFFSCREEN_LINES) {
  const keep = snapshot.elements.filter(el => el.path !== '0' && (el.label || el.id || el.value));
  const presence = (focus ?? []).filter(c => c.foreground == null && !c.gone);
  const focused = new Set();
  for (const c of presence) {
    // Use the same full-tree order as matches(), including unlabelled nodes.
    const hits = snapshot.elements.filter(el => el.path !== '0' && textMatch(el, c));
    for (const el of c.nth === undefined ? hits : hits.slice(c.nth, c.nth + 1)) focused.add(el);
  }
  const isMatch = el => focused.has(el);
  const rank = el => (isMatch(el) ? 0 : OVERLAY.test(el.type) || OVERLAY.test(el.id ?? '') ? 1 : INTERACTIVE.test(el.type) ? 2 : 3);
  const on = [], off = [];
  keep.forEach((el, i) => (onScreen(el, snapshot.screen) ? on : off).push({ el, i, r: rank(el) }));
  on.sort((a, b) => a.r - b.r || a.i - b.i);
  off.sort((a, b) => a.r - b.r || a.i - b.i);
  const shownOn = on.slice(0, limit), shownOff = off.slice(0, offscreenLimit);
  const out = {
    count: keep.length,
    elements: shownOn.map(x => line(x.el)),
    offscreen: { count: off.length, elements: shownOff.map(x => line(x.el)) },
    truncated: on.length > limit || off.length > offscreenLimit,
  };
  if (presence.length) {
    out.matched = shownOn.concat(shownOff).filter(x => x.r === 0).slice(0, limit).map(x => line(x.el));
    out.matched_count = keep.filter(isMatch).length;
    out.matched_omitted = out.matched_count - out.matched.length;
  }
  if (out.truncated) out.omitted = Math.max(0, on.length - limit) + Math.max(0, off.length - offscreenLimit);
  return out;
}

/** One element per line: type|label|id=..|value=..|x,y,w,h — cheap for a model to read. */
export function line(el) {
  const b = brief(el);
  return [b.type, b.label, b.id ? `id=${b.id}` : '', b.value && b.value !== b.label ? `value=${b.value}` : '',
    b.enabled === false ? 'disabled' : '', b.frame ? b.frame.join(',') : ''].filter(Boolean).join('|');
}

// ---------- plan validation ----------

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new StepError('bad_plan', 'plan must be an object');
  if (!plan.udid) throw new StepError('bad_plan', 'plan.udid is required (use one explicit simulator)');
  const bounded = (v, name, max = 60000) => {
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > max))
      throw new StepError('bad_plan', `${name} must be a finite number from 0 to ${max}`);
  };
  bounded(plan.bundle_timeout_ms, 'bundle_timeout_ms');
  bounded(plan.ax_ready_ms, 'ax_ready_ms');
  if (plan.strict_commit !== undefined && typeof plan.strict_commit !== 'boolean')
    throw new StepError('bad_plan', 'strict_commit must be boolean');
  if (plan.bundle !== undefined && (typeof plan.bundle !== 'string' || !plan.bundle))
    throw new StepError('bad_plan', 'bundle must be a nonempty string');
  if (plan.summary_limit !== undefined && (!Number.isInteger(plan.summary_limit) || plan.summary_limit < 1 || plan.summary_limit > 200))
    throw new StepError('bad_plan', 'summary_limit must be an integer from 1 to 200');
  const steps = plan.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS)
    throw new StepError('bad_plan', `steps must be 1–${MAX_STEPS} items`);
  let lastAction = -1;
  steps.forEach((s, i) => {
    const kinds = ACTIONS.filter(k => s && s[k] !== undefined);
    if (kinds.length !== 1) throw new StepError('bad_plan', `step ${i}: exactly one of ${ACTIONS.join('/')}`);
    const kind = kinds[0];
    if (Array.isArray(s) || typeof s !== 'object') throw new StepError('bad_plan', `step ${i}: object required`);
    const allowed = [kind, 'expect', 'commit', 'timeout_ms', 'settle_ms', 'stable_ms', 'label'];
    if (Object.keys(s).some(k => !allowed.includes(k))) throw new StepError('bad_plan', `step ${i}: unknown step key`);
    bounded(s.timeout_ms, `step ${i} timeout_ms`);
    bounded(s.settle_ms, `step ${i} settle_ms`);
    bounded(s.stable_ms, `step ${i} stable_ms`, 10000);
    if (s.stable_ms !== undefined) {
      if (!s.expect && kind !== 'wait') throw new StepError('bad_plan', `step ${i}: stable_ms needs expect or wait`);
      if (s.stable_ms > (s.timeout_ms ?? 5000)) throw new StepError('bad_plan', `step ${i}: stable_ms must not exceed timeout_ms`);
    }
    if (s.commit !== undefined && typeof s.commit !== 'boolean') throw new StepError('bad_plan', `step ${i}: commit must be boolean`);
    if (s.commit && ['wait', 'assert'].includes(kind)) throw new StepError('bad_plan', `step ${i}: commit must mark an action`);
    if (kind === 'type' && (typeof s.type !== 'string' || /[^\x20-\x7e\n\t]/.test(s.type) || s.type.length > 2000))
      throw new StepError('bad_plan', `step ${i}: type supports at most 2000 US ASCII characters, newline and tab`);
    if (kind === 'key' && (typeof s.key !== 'string' || !['enter', 'return', 'escape', 'backspace', 'delete', 'tab', 'space'].includes(s.key.toLowerCase())))
      throw new StepError('bad_plan', `step ${i}: unsupported key`);
    if (kind === 'button' && s.button !== 'home') throw new StepError('bad_plan', `step ${i}: only button home is supported`);
    if (kind === 'swipe') {
      const v = s.swipe;
      if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['from', 'to', 'ms'].includes(k)) ||
          ![v.from, v.to].every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
        throw new StepError('bad_plan', `step ${i}: swipe requires numeric from/to point pairs`);
      bounded(v.ms, `step ${i} swipe.ms`, 5000);
    }
    if (NEEDS_EXPECT.has(kind) && !s.expect)
      throw new StepError('bad_plan', `step ${i}: ${kind} must declare expect (the state change to wait for)`);
    if (kind !== 'wait' && kind !== 'assert') lastAction = i;
    if (kind === 'wait' || kind === 'assert') checkConds(s[kind], `step ${i} ${kind}`);
    if (s.expect !== undefined) checkConds(s.expect, `step ${i} expect`);
    if (kind === 'tap') {
      const sel = s.tap, hasText = sel && ['id', 'label', 'labelContains', 'value'].some(k => sel[k] != null);
      if (!hasText && !(sel && sel.x != null && sel.y != null))
        throw new StepError('bad_plan', `step ${i}: tap needs id/label/labelContains/value or x+y`);
      if (hasText) {
        checkCond(sel, `step ${i} tap`);
        if ('gone' in sel || 'foreground' in sel) throw new StepError('bad_plan', `step ${i}: tap needs an element selector`);
      } else if (Object.keys(sel).some(k => !['x', 'y'].includes(k)) || !Number.isFinite(sel.x) || !Number.isFinite(sel.y)) {
        throw new StepError('bad_plan', `step ${i}: tap coordinates must be finite x/y numbers`);
      }
    }
  });
  steps.forEach((s, i) => {
    if (!s.commit) return;
    if (!s.expect) throw new StepError('bad_plan', `step ${i}: commit step must declare expect`);
    if (i !== lastAction) throw new StepError('bad_plan', `step ${i}: commit must be the last action in a plan`);
    if (plan.strict_commit && verificationOf(s.expect) !== 'presence')
      throw new StepError('bad_plan', `step ${i}: strict_commit needs an expect that observes a result element (not only foreground or gone)`);
  });
  return steps.map((s, i) => ({ ...s, kind: ACTIONS.find(k => s[k] !== undefined), index: i }));
}

// ---------- runner ----------

/**
 * transport: {
 *   readAx(): Promise<rawTree>,          // one AX snapshot
 *   foreground(): Promise<string|null>,  // bundle id
 *   tap(nx, ny), swipe(from, to, ms), key(name), typeText(text), button(name),
 *   paused(): boolean,                   // pause file / signal
 *   now(): number, sleep(ms)
 * }
 */
export async function runPlan(plan, t) {
  const steps = validatePlan(plan);
  const started = t.now();
  const record = { status: 'ok', steps: [], ax_reads: 0, ax_invalid_reads: 0, ax_ms: 0, actions: 0, actions_attempted: 0, warnings: [] };
  const axReadyMs = plan.ax_ready_ms ?? 5000;
  let snap = null; // latest VALID snapshot, reused until something acts
  let sent = false; // an input event of the current step may have reached the device
  let focus = null; // conditions last observed as satisfied; shown first in the summary
  const beginInput = () => {
    sent = true;
    record.actions_attempted++;
    // Transport may send only part of an input before throwing. Neither the
    // old screen nor its satisfied conditions remain current in that case.
    snap = null;
    focus = null;
  };

  // One AX read. An invalid tree (no screen frame) throws bad_snapshot and
  // never replaces the last valid snapshot.
  const readOnce = async () => {
    const a = t.now();
    const raw = await t.readAx();
    record.ax_reads++; record.ax_ms += t.now() - a;
    try { snap = flattenAx(raw); } catch (e) { if (e.code === 'bad_snapshot') { record.ax_invalid_reads++; snap = null; } throw e; }
    return snap;
  };
  // Read-only wait for a valid tree (cold start): bounded, honours pause,
  // and only retries the known transient bad_snapshot case.
  const read = async () => {
    const deadline = t.now() + axReadyMs;
    for (;;) {
      try { return await readOnce(); }
      catch (e) { if (e.code !== 'bad_snapshot' || t.now() >= deadline) throw e; }
      if (t.paused()) throw new StepError('paused', 'paused while waiting for a valid AX snapshot');
      await t.sleep(100);
    }
  };
  const fresh = async () => snap ?? read();

  // All conditions in one observation. Foreground and AX are read only if needed.
  const evaluate = async (list, readFn) => {
    const needAx = list.some(c => c.foreground == null);
    const s = needAx ? await readFn() : null;
    const fg = list.some(c => c.foreground != null) ? await t.foreground() : null;
    return list.every(c => (c.foreground != null ? fg === c.foreground : matches(s, c)));
  };

  // Poll until all conditions hold (for stableMs across consecutive valid reads).
  const waitFor = async (cond, timeoutMs, stableMs = 0) => {
    const list = condList(cond);
    const deadline = t.now() + timeoutMs;
    let since = null, everMatched = false, lastInvalid = false;
    for (;;) {
      if (t.paused()) throw new StepError('paused', 'paused while waiting for a condition');
      let ok = false;
      try { ok = await evaluate(list, readOnce); lastInvalid = false; }
      catch (e) { if (e.code !== 'bad_snapshot') throw e; lastInvalid = true; }
      const now = t.now();
      if (ok) {
        everMatched = true;
        if (since == null) since = now;
        if (now - since >= stableMs) return { ok: true, stable_ms: Math.round(now - since) };
      } else since = null;
      if (now >= deadline) return { ok: false, everMatched, invalid: lastInvalid };
      await t.sleep(list.every(c => c.foreground != null) ? 150 : 50);
    }
  };
  const failWait = (w, cond, code) => {
    if (w.invalid) return new StepError('bad_snapshot', 'no valid AX snapshot before timeout; presence or absence not verified');
    if (w.everMatched) return new StepError('unstable_result', `${JSON.stringify(cond)} appeared but did not hold for stable_ms`);
    return new StepError(code, `${code === 'wait_timeout' ? 'condition not met' : 'expected'}: ${JSON.stringify(cond)}`);
  };

  try {
    if (plan.bundle) {
      // Wait briefly for the app to come forward (launch animation), then insist.
      let w;
      try { w = await waitFor({ foreground: plan.bundle }, plan.bundle_timeout_ms ?? 3000); }
      catch (e) { e.step = e.code === 'paused' ? 0 : -1; throw e; }
      if (!w.ok) {
        const fg = await t.foreground();
        throw new StepError('wrong_app', `foreground is ${fg ?? 'unknown'}, plan expects ${plan.bundle}`, { step: -1 });
      }
    }
    for (const s of steps) {
      if (t.paused()) { record.status = 'paused'; record.stopped_before = s.index; break; }
      const a = t.now();
      const entry = { i: s.index, kind: s.kind, label: s.label ?? null };
      sent = false;
      try {
        await act(s, entry);
        if (s.expect) {
          const w = await waitFor(s.expect, s.timeout_ms ?? 5000, s.stable_ms ?? 0);
          if (!w.ok) {
            const e = failWait(w, s.expect, 'expect_timeout');
            if (s.commit) throw new StepError('unknown_result',
              `commit sent but expected result not observed (${e.code}); verify the original action, do NOT resend`);
            throw e;
          }
          entry.observed = { verification: verificationOf(s.expect), ...(s.stable_ms ? { stable_ms: w.stable_ms } : {}) };
          focus = condList(s.expect);
        }
        if (s.commit) {
          record.commit = { step: s.index, sent: true, verification: verificationOf(s.expect) };
          if (record.commit.verification !== 'presence')
            record.warnings.push(`step ${s.index}: commit was sent but only ${record.commit.verification === 'foreground_only'
              ? 'the app staying in foreground' : 'an element disappearing'} was observed; no result element was seen, so the business outcome is NOT verified`);
        }
      } catch (e) {
        // Once a commit action may have reached the device, any later error
        // (lost connection, AX read failure, pause) leaves its outcome unknown.
        if (s.commit && sent) record.commit = { step: s.index, sent: true, verification: 'unknown' };
        if (s.commit && sent && e.code !== 'unknown_result') {
          const u = new StepError('unknown_result',
            `commit sent, then ${e.code ?? 'error'}: ${e.message}; verify the original action, do NOT resend`);
          u.step = s.index;
          throw u;
        }
        e.step = s.index;
        if (sent) e.action_sent = true;
        throw e;
      } finally {
        entry.ms = Math.round(t.now() - a);
        record.steps.push(entry);
      }
    }
  } catch (e) {
    record.status = e.code === 'unknown_result' ? 'unknown' : e.code === 'paused' ? 'paused' : 'failed';
    if (e.code === 'paused') record.stopped_before = e.action_sent ? e.step + 1 : e.step;
    record.error = { code: e.code ?? 'tool_error', message: e.message, step: e.step ?? null };
    if (e.action_sent) record.error.action_sent = true;
    if (e.partial) record.error.partial = true; // only part of the input was sent
    if (e.candidates) record.error.candidates = e.candidates;
  }

  // One final observation for the model; reuse the last valid snapshot if it is current.
  try {
    if (!snap) await read();
    record.final = { foreground: await t.foreground(), ...summarize(snap, plan.summary_limit ?? 40, focus) };
  } catch (e) {
    record.final = { error: e.message };
    if (record.status === 'ok') {
      record.status = 'failed';
      record.error = { code: 'final_observation_failed', message: e.message, step: null };
    }
  }
  if (!record.warnings.length) delete record.warnings;
  record.ax_ms = Math.round(record.ax_ms);
  record.total_ms = Math.round(t.now() - started);
  return record;

  async function act(s, entry) {
    switch (s.kind) {
      case 'tap': {
        let nx, ny;
        if (s.tap.x != null && s.tap.y != null && !hasTextKey(s.tap)) {
          const sc = (await fresh()).screen;
          nx = (s.tap.x - sc.x) / sc.width; ny = (s.tap.y - sc.y) / sc.height;
        } else {
          // Locate, then re-read until the target's frame holds still: taps
          // during layout or push animations land on whatever moved underneath.
          let cur = await fresh();
          let el = findOne(cur, s.tap);
          const deadline = t.now() + (s.settle_ms ?? 3000);
          for (;;) {
            if (t.paused()) throw new StepError('paused', 'paused while locating target');
            const next = await read();
            const el2 = findOne(next, s.tap);
            const same = ['x', 'y', 'width', 'height'].every(k => Math.abs(el.frame[k] - el2.frame[k]) < 1);
            cur = next; el = el2;
            if (same) break;
            if (t.now() >= deadline) throw new StepError('unstable', `target still moving: ${el.label}`);
          }
          if (!el.enabled) throw new StepError('disabled', `target is disabled: ${el.label}`);
          if (!onScreen(el, cur.screen)) throw new StepError('offscreen', `target is off screen; scroll first: ${el.label}`);
          const f = el.frame;
          nx = (f.x + f.width / 2 - cur.screen.x) / cur.screen.width;
          ny = (f.y + f.height / 2 - cur.screen.y) / cur.screen.height;
        }
        if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) throw new StepError('offscreen', 'tap point outside screen');
        if (t.paused()) throw new StepError('paused', 'paused before tap was sent');
        beginInput();
        await t.tap(nx, ny);
        break;
      }
      case 'swipe': {
        const sc = (await fresh()).screen;
        const norm = p => [(p[0] - sc.x) / sc.width, (p[1] - sc.y) / sc.height];
        const pts = [norm(s.swipe.from), norm(s.swipe.to)];
        if (pts.flat().some(v => !(v >= 0 && v <= 1))) throw new StepError('offscreen', 'swipe point outside screen');
        if (t.paused()) throw new StepError('paused', 'paused before swipe was sent');
        beginInput();
        await t.swipe(pts[0], pts[1], s.swipe.ms ?? 300);
        break;
      }
      case 'type':
      case 'key':
      case 'button':
        if (t.paused()) throw new StepError('paused', `paused before ${s.kind} was sent`);
        beginInput();
        if (s.kind === 'type') await t.typeText(String(s.type));
        else if (s.kind === 'key') await t.key(String(s.key));
        else await t.button(String(s.button));
        break;
      case 'wait': {
        const w = await waitFor(s.wait, s.timeout_ms ?? 5000, s.stable_ms ?? 0);
        if (!w.ok) throw failWait(w, s.wait, 'wait_timeout');
        entry.observed = { verification: verificationOf(s.wait), ...(s.stable_ms ? { stable_ms: w.stable_ms } : {}) };
        focus = condList(s.wait);
        return; // no action happened, snapshot stays valid
      }
      case 'assert': {
        const list = condList(s.assert);
        if (!(await evaluate(list, read))) throw new StepError('assert_failed', `assertion failed: ${JSON.stringify(s.assert)}`);
        focus = list;
        return;
      }
    }
    record.actions++; // transport completed; business outcome still needs observation
  }
}
