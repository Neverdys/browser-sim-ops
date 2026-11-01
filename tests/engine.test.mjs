// node --test tests/   (no simulator needed: transport is faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlan, validatePlan, findOne, flattenAx } from '../scripts/lib/engine.mjs';

const node = (label, extra = {}) => ({ AXLabel: label, AXUniqueId: extra.id ?? null, AXValue: extra.value ?? null,
  type: extra.type ?? 'Button', enabled: extra.enabled ?? true, frame: extra.frame ?? { x: 0, y: 100, width: 100, height: 40 }, children: [] });
const tree = (...kids) => [{ AXLabel: 'App', type: 'Application', frame: { x: 0, y: 0, width: 400, height: 800 }, children: kids }];

/** Fake device: screens[name] -> tree; taps on a label move to another screen. */
function fakeDevice({ screens, start, onTap = {}, fg = 'com.test.app', pauseAfter = Infinity }) {
  let cur = start, clock = 0, actions = 0;
  const log = [];
  return {
    log,
    readAx: async () => { clock += 5; return screens[cur]; },
    foreground: async () => fg,
    tap: async (x, y) => {
      actions++;
      const flat = flattenAx(screens[cur]).elements;
      const hit = flat.find(e => e.path !== '0' && e.frame && Math.abs((e.frame.x + e.frame.width / 2) / 400 - x) < 1e-6 && Math.abs((e.frame.y + e.frame.height / 2) / 800 - y) < 1e-6);
      log.push(['tap', hit?.label]);
      if (hit && onTap[hit.label]) cur = onTap[hit.label];
    },
    swipe: async () => { actions++; log.push(['swipe']); },
    typeText: async s => { actions++; log.push(['type', s]); },
    key: async k => { actions++; log.push(['key', k]); },
    button: async b => { actions++; log.push(['button', b]); },
    paused: () => actions >= pauseAfter,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  };
}

const screens = {
  home: tree(node('Next', { frame: { x: 0, y: 100, width: 100, height: 40 } }), node('Submit', { id: 'submit', frame: { x: 0, y: 200, width: 100, height: 40 } })),
  detail: tree(node('Detail title', { type: 'Heading' }), node('Back', { frame: { x: 0, y: 300, width: 100, height: 40 } })),
};

test('runs known steps and observes once at the end', async () => {
  const d = fakeDevice({ screens, start: 'home', onTap: { Next: 'detail', Back: 'home' } });
  const r = await runPlan({ udid: 'U', bundle: 'com.test.app', steps: [
    { tap: { label: 'Next' }, expect: { label: 'Detail title' } },
    { tap: { label: 'Back' }, expect: { label: 'Next' } },
  ] }, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(d.log, [['tap', 'Next'], ['tap', 'Back']]);
  assert.equal(r.actions, 2);
  assert.equal(r.actions_attempted, 2);
  assert.ok(r.final.elements.some(l => l.startsWith('Button|Next')));
});

test('first failure stops; later steps never run and nothing is retried', async () => {
  const d = fakeDevice({ screens, start: 'home', onTap: {} });
  const r = await runPlan({ udid: 'U', steps: [
    { tap: { label: 'Next' }, expect: { label: 'Detail title' }, timeout_ms: 200 },
    { tap: { label: 'Submit' }, expect: { label: 'Done' } },
  ] }, d);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'expect_timeout');
  assert.equal(r.error.step, 0);
  assert.deepEqual(d.log, [['tap', 'Next']]); // one tap, no retry, step 1 untouched
});

test('commit without observed result is unknown and is sent exactly once', async () => {
  const d = fakeDevice({ screens, start: 'home' });
  const r = await runPlan({ udid: 'U', steps: [
    { tap: { id: 'submit' }, expect: { label: 'Success' }, commit: true, timeout_ms: 300 },
  ] }, d);
  assert.equal(r.status, 'unknown');
  assert.match(r.error.message, /do NOT resend/);
  assert.equal(d.log.filter(x => x[1] === 'Submit').length, 1);
});

test('pause is checked before every step', async () => {
  const d = fakeDevice({ screens, start: 'home', onTap: { Next: 'detail' }, pauseAfter: 1 });
  const r = await runPlan({ udid: 'U', steps: [
    { tap: { label: 'Next' }, expect: { label: 'Detail title' } },
    { tap: { label: 'Back' }, expect: { label: 'Next' } },
  ] }, d);
  assert.equal(r.status, 'paused');
  assert.equal(r.stopped_before, 1);
  assert.equal(d.log.length, 1);
});

test('wrong foreground app blocks before any action', async () => {
  const d = fakeDevice({ screens, start: 'home', fg: 'com.other' });
  const r = await runPlan({ udid: 'U', bundle: 'com.test.app', bundle_timeout_ms: 100, steps: [{ tap: { label: 'Next' }, expect: { label: 'x' } }] }, d);
  assert.equal(r.error.code, 'wrong_app');
  assert.equal(d.log.length, 0);
});

test('ambiguous or missing targets are errors, never guesses', () => {
  const s = flattenAx(tree(node('OK'), node('OK', { frame: { x: 0, y: 300, width: 10, height: 10 } })));
  assert.throws(() => findOne(s, { label: 'OK' }), e => e.code === 'ambiguous');
  assert.throws(() => findOne(s, { label: 'Nope' }), e => e.code === 'not_found');
  assert.equal(findOne(s, { label: 'OK', nth: 1 }).frame.y, 300);
});

test('disabled and off-screen targets are refused', async () => {
  const sc = { home: tree(node('Off', { frame: { x: 0, y: 900, width: 50, height: 40 } }), node('Dis', { enabled: false })) };
  for (const label of ['Off', 'Dis']) {
    const d = fakeDevice({ screens: sc, start: 'home' });
    const r = await runPlan({ udid: 'U', steps: [{ tap: { label }, expect: { label: 'x' } }] }, d);
    assert.equal(r.status, 'failed');
    assert.equal(d.log.length, 0);
  }
});

test('plan validation: explicit udid, expect on navigation, commit last', () => {
  assert.throws(() => validatePlan({ steps: [{ type: 'a' }] }), /udid/);
  assert.throws(() => validatePlan({ udid: 'U', steps: [{ tap: { label: 'a' } }] }), /expect/);
  assert.throws(() => validatePlan({ udid: 'U', steps: [
    { tap: { label: 'a' }, expect: { label: 'b' }, commit: true },
    { tap: { label: 'b' }, expect: { label: 'c' } }] }), /last action/);
  assert.throws(() => validatePlan({ udid: 'U', steps: Array.from({ length: 21 }, () => ({ type: 'a' })) }), /1–20/);
  assert.doesNotThrow(() => validatePlan({ udid: 'U', steps: [
    { tap: { label: 'a' }, expect: { label: 'b' }, commit: true }, { wait: { label: 'b' } }] }));
});

test('a target that keeps moving is never tapped', async () => {
  let y = 100;
  const moving = () => tree(node('Go', { frame: { x: 0, y: (y += 30), width: 100, height: 40 } }));
  const d = fakeDevice({ screens: {}, start: 'x' });
  d.readAx = async () => { await d.sleep(5); return moving(); };
  const r = await runPlan({ udid: 'U', steps: [{ tap: { label: 'Go' }, expect: { label: 'x' }, settle_ms: 200 }] }, d);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'unstable');
  assert.equal(d.log.length, 0);
});

test('conditions with typos, no anchor or empty objects are rejected (review #1)', () => {
  const plan = expect => ({ udid: 'U', steps: [{ tap: { label: 'a' }, expect, commit: true }] });
  for (const bad of [{}, { lable: 'x' }, { type: 'Button' }, { gone: true }, 'x'])
    assert.throws(() => validatePlan(plan(bad)), e => e.code === 'bad_plan', JSON.stringify(bad));
  assert.throws(() => validatePlan({ udid: 'U', steps: [{ wait: { lable: 'x' } }] }), /unknown key/);
  assert.throws(() => validatePlan({ udid: 'U', steps: [{ key: 'enter' }] }), /expect/);
  assert.throws(() => validatePlan({ udid: 'U', steps: [{ tap: { type: 'Button' }, expect: { label: 'x' } }] }), /tap needs/);
  assert.doesNotThrow(() => validatePlan(plan({ label: 'x', gone: true })));
});

test('commit sent and then a tool error is unknown, not failed (review #2)', async () => {
  const d = fakeDevice({ screens, start: 'home' });
  const orig = d.readAx; let tapped = false;
  const tap = d.tap; d.tap = async (...a) => { tapped = true; return tap(...a); };
  d.readAx = async () => { if (tapped) throw new Error('HTTP 500'); return orig(); };
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Success' }, commit: true }] }, d);
  assert.equal(r.status, 'unknown');
  assert.match(r.error.message, /do NOT resend/);
  assert.equal(d.log.length, 1);
});

test('a commit that fails before sending stays failed', async () => {
  const d = fakeDevice({ screens, start: 'home' });
  const r = await runPlan({ udid: 'U', steps: [{ tap: { label: 'Missing' }, expect: { label: 'Success' }, commit: true }] }, d);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'not_found');
  assert.equal(d.log.length, 0);
});

for (const [method, action] of [
  ['tap', { tap: { label: 'Before' } }],
  ['swipe', { swipe: { from: [20, 200], to: [20, 100] } }],
  ['typeText', { type: 'a' }], ['key', { key: 'enter' }], ['button', { button: 'home' }],
]) {
  for (const unreadable of [false, true]) {
    test(`${method} may change UI before throwing: final observation is fresh or unavailable (${unreadable})`, async () => {
      const d = fakeDevice({ screens: { home: tree(node('Before')) }, start: 'home' });
      let attempted = 0;
      const originalRead = d.readAx;
      d.readAx = async () => {
        if (!attempted) return originalRead();
        if (unreadable) throw new Error('AX unavailable after input');
        return tree(node('Current', { type: 'Alert' }), node('Before'));
      };
      d[method] = async () => { attempted++; throw new Error('connection lost after input'); };
      const r = await runPlan({ udid: 'U', summary_limit: 1, steps: [
        { assert: { label: 'Before' } },
        { ...action, commit: true, expect: { label: 'Done' } },
        { assert: { label: 'must not run' } },
      ] }, d);
      assert.equal(r.status, 'unknown');
      assert.match(r.error.message, /do NOT resend/);
      assert.equal(attempted, 1);
      assert.equal(r.steps.length, 2);
      if (unreadable) assert.deepEqual(r.final, { error: 'AX unavailable after input' });
      else assert.match(r.final.elements[0], /^Alert\|Current/);
      assert.equal(r.actions, 0);
      assert.equal(r.actions_attempted, 1);
    });
  }
}

test('mixed foreground and UI conditions are rejected before any input', async () => {
  for (const kind of ['expect', 'wait', 'assert']) {
    const d = fakeDevice({ screens, start: 'home' });
    const mixed = { foreground: 'com.test.app', label: 'Success' };
    const step = kind === 'expect' ? { tap: { id: 'submit' }, expect: mixed, commit: true } : { [kind]: mixed };
    await assert.rejects(runPlan({ udid: 'U', steps: [step] }, d), /foreground must be a separate/);
    assert.equal(d.log.length, 0);
  }
});

test('nth conditions use zero-based occurrence and gone means that occurrence is absent', async () => {
  for (const kind of ['wait', 'assert']) {
    const d = fakeDevice({ screens, start: 'home' });
    const r = await runPlan({ udid: 'U', steps: [{ [kind]: { label: 'Submit', nth: 99 }, timeout_ms: 0 }, { type: 'never' }] }, d);
    assert.equal(r.status, 'failed');
    assert.equal(d.log.length, 0);
  }
  const d = fakeDevice({ screens, start: 'home' });
  assert.equal((await runPlan({ udid: 'U', steps: [{ assert: { label: 'Submit', nth: 0 } }, { assert: { label: 'Submit', nth: 1, gone: true } }] }, d)).status, 'ok');
});

test('invalid later payloads reject the whole plan before any mutation', async () => {
  const bad = [
    { type: '中文' }, { type: 42 }, { key: 'typo', expect: { label: 'Next' } },
    { button: 'typo', expect: { label: 'Next' } },
    { tap: { label: 'Next', typo: 'x' }, expect: { label: 'Next' } },
    { swipe: { from: [0], to: [0, 1] }, expect: { label: 'Next' } },
    { wait: { label: 'Next' }, timeout_ms: 'forever' },
    { wait: { label: 'Next' }, timeout_ms: Infinity },
    { wait: { label: 'Next', nth: -1 } },
    { wait: { label: 'Next', gone: 'false' } },
    { tap: { x: NaN, y: 0 }, expect: { label: 'Next' } },
    { type: 'a', commmit: true },
  ];
  for (const step of bad) {
    const d = fakeDevice({ screens, start: 'home' });
    await assert.rejects(runPlan({ udid: 'U', steps: [{ type: 'first' }, step] }, d), e => e.code === 'bad_plan');
    assert.equal(d.log.length, 0);
  }
});

test('pause while settling target prevents the delayed tap', async () => {
  const d = fakeDevice({ screens, start: 'home' });
  let reads = 0; const original = d.readAx;
  d.readAx = async () => { reads++; return original(); };
  d.paused = () => reads >= 2;
  const r = await runPlan({ udid: 'U', steps: [{ tap: { label: 'Next' }, expect: { label: 'Next' } }] }, d);
  assert.equal(r.status, 'paused');
  assert.equal(d.log.length, 0);
});

test('invalid AX data cannot prove a gone condition after submitting', async () => {
  const d = fakeDevice({ screens, start: 'home' });
  const read = d.readAx;
  d.readAx = async () => d.log.length ? {} : read();
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Submit', gone: true }, commit: true }] }, d);
  assert.equal(r.status, 'unknown');
  assert.equal(d.log.length, 1);
});
