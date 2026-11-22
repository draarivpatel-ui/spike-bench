'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../src/neuro.js');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol,
    `${msg || ''} expected ${a} within ${tol} of ${b}`);

/* =============================================================== *
 * LIF parameter resolution
 * =============================================================== */

test('LIF_DEFAULTS exposes the leaky integrate and fire constants', () => {
  const d = N.LIF_DEFAULTS;
  assert.equal(d.tauM, 20);
  assert.equal(d.vRest, -65);
  assert.equal(d.vTh, -50);
  assert.equal(d.vReset, -65);
  assert.equal(d.rIn, 3);
  assert.equal(d.refracMs, 2);
  assert.equal(d.tauSyn, 5);
});

test('resolveLIF returns a copy of the defaults for empty input', () => {
  const lif = N.resolveLIF();
  assert.deepEqual(lif, Object.assign({}, N.LIF_DEFAULTS));
  assert.notEqual(lif, N.LIF_DEFAULTS);
});

test('resolveLIF rejects non positive time constants', () => {
  const lif = N.resolveLIF({ tauM: -5, tauSyn: 0, rIn: 0 });
  assert.equal(lif.tauM, N.LIF_DEFAULTS.tauM);
  assert.equal(lif.tauSyn, N.LIF_DEFAULTS.tauSyn);
  assert.equal(lif.rIn, N.LIF_DEFAULTS.rIn);
});

test('resolveLIF accepts a nested lif options block', () => {
  const lif = N.resolveLIF({ lif: { tauM: 12, vTh: -55 } });
  assert.equal(lif.tauM, 12);
  assert.equal(lif.vTh, -55);
});

test('resolveLIF clamps refractory to nonnegative', () => {
  assert.equal(N.resolveLIF({ refracMs: -2 }).refracMs, 0);
  assert.equal(N.resolveLIF({ refracMs: 3 }).refracMs, 3);
});

/* =============================================================== *
 * LIF subthreshold integration
 * =============================================================== */

test('LIF rests stably with no input', () => {
  const tr = N.simulateLIF({ totalDuration: 100 });
  assert.equal(tr.spikes.length, 0);
  tr.V.forEach((v) => near(v, -65, 1e-9));
});

test('LIF charging follows the analytic exponential toward vInf', () => {
  const dt = 0.05;
  const tr = N.simulateLIF({
    amplitude: 2, stimStart: 0, stimDuration: 50, totalDuration: 50, dt,
  });
  const k = Math.round(10 / dt);
  const expected = -65 + 2 * 3 * (1 - Math.exp(-10 / 20));
  near(tr.V[k], expected, 0.05, `V at 10 ms`);
});

test('LIF relaxes back to rest when the stimulus ends', () => {
  const tr = N.simulateLIF({
    amplitude: 3, stimStart: 5, stimDuration: 10, totalDuration: 100, postTime: 0,
  });
  const end = tr.V[tr.V.length - 1];
  near(end, -65, 0.5);
});

test('LIF never fires for subthreshold sustained current', () => {
  const tr = N.simulateLIF({ amplitude: 4, totalDuration: 400 });
  assert.equal(tr.spikes.length, 0);
});

/* =============================================================== *
 * LIF spiking, reset and refractory
 * =============================================================== */

test('LIF fires repeatedly above rheobase', () => {
  const tr = N.simulateLIF({ amplitude: 8, totalDuration: 200 });
  assert.ok(tr.spikes.length >= 3, `spikes ${tr.spikes.length}`);
});

test('LIF spike times increase monotonically and sit inside the run', () => {
  const tr = N.simulateLIF({ amplitude: 10, totalDuration: 200 });
  for (let i = 1; i < tr.spikes.length; i += 1) {
    assert.ok(tr.spikes[i].time > tr.spikes[i - 1].time);
  }
  tr.spikes.forEach((s) => assert.ok(s.time > 0 && s.time <= 200.01));
});

test('LIF resets to vReset and honors the refractory hold', () => {
  const refracMs = 5;
  const tr = N.simulateLIF({ amplitude: 12, totalDuration: 120, refracMs, dt: 0.05 });
  const s0 = tr.spikes[0];
  const idx = Math.round(s0.time / tr.dt);
  near(tr.V[idx], -65, 1e-9);
  const holdEnd = Math.min(tr.t.length - 1, idx + Math.round(refracMs / tr.dt) - 1);
  for (let k = idx + 1; k <= holdEnd; k += 1) near(tr.V[k], -65, 1e-9);
});

test('LIF minimum inter spike interval covers the refractory period', () => {
  const tr = N.simulateLIF({ amplitude: 30, totalDuration: 200, refracMs: 4 });
  for (let i = 1; i < tr.spikes.length; i += 1) {
    assert.ok(tr.spikes[i].time - tr.spikes[i - 1].time >= 4 - 1e-6);
  }
});

test('LIF firing rate increases with injected current', () => {
  const rate = (I) => N.simulateLIF({ amplitude: I, totalDuration: 400 })
    .stats.meanRateHz;
  const r8 = rate(8);
  const r12 = rate(12);
  const r20 = rate(20);
  assert.ok(r8 > 0);
  assert.ok(r12 > r8, `${r12} <= ${r8}`);
  assert.ok(r20 > r12, `${r20} <= ${r12}`);
});

test('LIF spike indices count upward from zero', () => {
  const tr = N.simulateLIF({ amplitude: 9, totalDuration: 150 });
  tr.spikes.forEach((s, i) => assert.equal(s.index, i));
});

/* =============================================================== *
 * LIF synaptic input
 * =============================================================== */

test('LIF synaptic pulses inject and decay exponentially', () => {
  const dt = 0.05;
  const tr = N.simulateLIF({
    totalDuration: 30, dt, tauSyn: 5,
    synapses: [{ times: [5], weight: 4 }],
  });
  const at = (t) => tr.iSyn[Math.round(t / dt)];
  assert.equal(at(4), 0);
  near(at(5), 4, 0.05);
  near(at(10), 4 * Math.exp(-1), 0.1);
});

test('LIF multiple synapses sum their contributions', () => {
  const tr = N.simulateLIF({
    totalDuration: 20, dt: 0.05,
    synapses: [
      { times: [5], weight: 2 },
      { times: [5], weight: 3 },
    ],
  });
  const at = (t) => tr.iSyn[Math.round(t / tr.dt)];
  near(at(5), 5, 0.05);
});

test('LIF synaptic barrage can drive the cell over threshold', () => {
  const tr = N.simulateLIF({
    totalDuration: 40, dt: 0.05, rIn: 4, tauM: 8,
    synapses: [{ times: [10, 10.5, 11, 11.5, 12], weight: 3 }],
  });
  assert.ok(tr.spikes.length >= 1);
});

test('LIF synapses with unsorted times still deliver in order', () => {
  const tr = N.simulateLIF({
    totalDuration: 30, dt: 0.05, tauSyn: 1000,
    synapses: [{ times: [15, 5], weight: 1 }],
  });
  const at = (t) => tr.iSyn[Math.round(t / tr.dt)];
  near(at(6), 1, 0.05);
  near(at(16), 2, 0.05);
});

test('LIF non finite synapse times are dropped', () => {
  const tr = N.simulateLIF({
    totalDuration: 20, dt: 0.05, tauSyn: 1000,
    synapses: [{ times: [NaN, Infinity, 5], weight: 2 }],
  });
  near(tr.iSyn[Math.round(6 / tr.dt)], 2, 0.01);
});

/* =============================================================== *
 * LIF trace structure and robustness
 * =============================================================== */

test('LIF trace arrays share one common length', () => {
  const tr = N.simulateLIF({ amplitude: 6, totalDuration: 30 });
  const L = tr.t.length;
  ['V', 'I', 'iSyn'].forEach((k) => assert.equal(tr[k].length, L));
  assert.ok(L >= 3);
});

test('LIF trace records stimulus and metadata', () => {
  const tr = N.simulateLIF({ amplitude: 7, stimStart: 5, stimDuration: 10, totalDuration: 30 });
  assert.equal(tr.meta.mode, 'lif');
  assert.equal(tr.meta.vTh, -50);
  assert.equal(tr.meta.lif.tauM, 20);
  const at = (t) => tr.I[Math.round(t / tr.dt)];
  assert.equal(at(4), 0);
  assert.equal(at(6), 7);
});

test('LIF stats count and rate agree with the spike list', () => {
  const tr = N.simulateLIF({ amplitude: 9, totalDuration: 200 });
  assert.equal(tr.stats.count, tr.spikes.length);
  near(tr.stats.meanRateHz, tr.spikes.length * 1000 / 200, 1e-9);
});

test('LIF custom stimulus functions drive the cell', () => {
  const tr = N.simulateLIF({
    totalDuration: 100, stimulus: (t) => (t >= 10 && t < 60 ? 9 : 0),
  });
  assert.ok(tr.spikes.length > 0);
  assert.ok(tr.spikes.every((s) => s.time >= 10));
});

test('LIF rejects non finite injected current loudly', () => {
  assert.throws(
    () => N.simulateLIF({ totalDuration: 10, stimulus: () => NaN }),
    RangeError);
  assert.throws(
    () => N.simulateLIF({ totalDuration: 10, stimulus: () => Infinity }),
    RangeError);
});

test('LIF initialV option starts the membrane away from rest', () => {
  const tr = N.simulateLIF({ totalDuration: 5, initialV: -60 });
  assert.equal(tr.V[0], -60);
});

test('LIF zero duration produces only the initial sample', () => {
  const tr = N.simulateLIF({ totalDuration: 0.01, dt: 0.5 });
  assert.equal(tr.spikes.length, 0);
  assert.ok(tr.t.length >= 1);
});

test('LIF negative threshold crossing still fires from a raised baseline', () => {
  const tr = N.simulateLIF({ amplitude: 8, totalDuration: 100, vRest: -55, vReset: -55 });
  assert.ok(tr.spikes.length > 0);
});

test('LIF larger dt keeps the same spike count for tonic drive', () => {
  const a = N.simulateLIF({ amplitude: 10, totalDuration: 200, dt: 0.02 });
  const b = N.simulateLIF({ amplitude: 10, totalDuration: 200, dt: 0.1 });
  assert.ok(Math.abs(a.spikes.length - b.spikes.length) <= 1);
});
