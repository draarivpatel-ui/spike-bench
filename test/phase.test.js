'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../src/neuro.js');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol,
    `${msg || ''} expected ${a} within ${tol} of ${b}`);

/* =============================================================== *
 * simulateIzh trajectories
 * =============================================================== */

test('simulateIzh produces a spiking RS neuron at I=10', () => {
  const sim = N.simulateIzh({ I: 10, duration: 200 });
  assert.ok(sim.spikes.length > 0);
  assert.equal(sim.type, 'RS');
});

test('simulateIzh trajectory rows carry t, v, u and a spike flag', () => {
  const sim = N.simulateIzh({ I: 10, duration: 100 });
  sim.trajectory.forEach((p) => {
    assert.ok(Number.isFinite(p.t));
    assert.ok(Number.isFinite(p.v));
    assert.ok(Number.isFinite(p.u));
    assert.equal(typeof p.spike, 'boolean');
  });
});

test('simulateIzh records spike markers at the 30 mV apex', () => {
  const sim = N.simulateIzh({ I: 10, duration: 200 });
  const marks = sim.trajectory.filter((p) => p.spike);
  assert.equal(marks.length, sim.spikes.length);
  marks.forEach((m) => assert.equal(m.v, 30));
});

test('simulateIzh resets v to the phenotype reset potential after a spike', () => {
  const sim = N.simulateIzh({ I: 10, duration: 200, type: 'RS' });
  const marks = sim.trajectory.filter((p) => p.spike);
  const first = marks[0];
  const idx = sim.trajectory.indexOf(first);
  const after = sim.trajectory.slice(idx + 1).find((p) => !p.spike);
  assert.ok(after);
  near(after.v, N.IZH_TYPES.RS.c, 0.6);
});

test('simulateIzh stays silent at zero drive', () => {
  const sim = N.simulateIzh({ I: 0, duration: 150 });
  assert.equal(sim.spikes.length, 0);
});

test('simulateIzh honors each phenotype parameter set', () => {
  const sim = N.simulateIzh({ I: 15, duration: 300, type: 'CH' });
  assert.equal(sim.type, 'CH');
  assert.ok(sim.spikes.length > 0);
});

test('simulateIzh unknown type falls back to RS', () => {
  const sim = N.simulateIzh({ type: 'XX', duration: 20 });
  assert.equal(sim.type, 'RS');
});

test('simulateIzh is deterministic for identical options', () => {
  const a = N.simulateIzh({ I: 10, duration: 100, type: 'FS' });
  const b = N.simulateIzh({ I: 10, duration: 100, type: 'FS' });
  assert.deepEqual(a.spikes, b.spikes);
});

test('simulateIzh accepts a current waveform function', () => {
  const sim = N.simulateIzh({
    I: (t) => (t >= 20 && t < 80 ? 10 : 0), duration: 120,
  });
  assert.ok(sim.spikes.length > 0);
  assert.ok(sim.spikes.every((s) => s >= 20));
});

test('simulateIzh rejects non finite current', () => {
  assert.throws(() => N.simulateIzh({ I: () => NaN, duration: 10 }), RangeError);
});

test('simulateIzh honors a custom starting state', () => {
  const sim = N.simulateIzh({ I: 0, duration: 5, v0: -60, u0: -12 });
  assert.equal(sim.trajectory[0].v, -60);
  assert.equal(sim.trajectory[0].u, -12);
});

/* =============================================================== *
 * izhNullclines: exact fast slow decomposition
 * =============================================================== */

test('the u nullcline is the line u = b v', () => {
  const nc = N.izhNullclines(10, 'RS');
  nc.uNull.forEach((p) => near(p.u, N.IZH_TYPES.RS.b * p.v, 1e-9));
});

test('the v nullcline is the quadratic u = 0.04v^2 + 5v + 140 + I', () => {
  const I = 10;
  const nc = N.izhNullclines(I, 'RS');
  nc.vNull.forEach((p) =>
    near(p.u, 0.04 * p.v * p.v + 5 * p.v + 140 + I, 1e-9));
});

test('izhNullclines finds two equilibria below the bifurcation', () => {
  const nc = N.izhNullclines(0, 'RS');
  assert.equal(nc.equilibria.length, 2);
});

test('equilibria sit exactly at both nullcline intersections', () => {
  const I = 0;
  const p = N.IZH_TYPES.RS;
  const nc = N.izhNullclines(I, 'RS');
  nc.equilibria.forEach((eq) => {
    near(eq.u, p.b * eq.v, 1e-9);
    near(eq.u, 0.04 * eq.v * eq.v + 5 * eq.v + 140 + I, 1e-9);
  });
});

test('no equilibria exist once the drive kills the rest state', () => {
  const nc = N.izhNullclines(10, 'RS');
  assert.equal(nc.equilibria.length, 0);
});

test('izhNullclines honors the requested voltage grid', () => {
  const nc = N.izhNullclines(0, 'FS', { vMin: -80, vMax: -40, step: 10 });
  assert.equal(nc.vNull.length, 5);
  assert.equal(nc.uNull.length, 5);
  assert.equal(nc.vNull[0].v, -80);
  assert.equal(nc.type, 'FS');
});

test('izhNullclines u nullcline slope matches the phenotype b', () => {
  const fs = N.izhNullclines(0, 'FS');
  near(fs.uNull[1].u - fs.uNull[0].u,
    N.IZH_TYPES.FS.b * (fs.uNull[1].v - fs.uNull[0].v), 1e-9);
});

/* =============================================================== *
 * phasePortraitIzh bundle
 * =============================================================== */

test('phasePortraitIzh reports a limit cycle at I=10', () => {
  const pp = N.phasePortraitIzh({ I: 10, duration: 200 });
  assert.equal(pp.isLimitCycle, true);
  assert.equal(pp.model, 'izhikevich');
  assert.ok(pp.spikeCount > 0);
  assert.equal(pp.spikes.length, pp.spikeCount);
});

test('phasePortraitIzh reports rest, not a limit cycle, at I=0', () => {
  const pp = N.phasePortraitIzh({ I: 0, duration: 150 });
  assert.equal(pp.isLimitCycle, false);
  assert.equal(pp.spikeCount, 0);
});

test('phasePortraitIzh bundles trajectory and both nullclines', () => {
  const pp = N.phasePortraitIzh({ I: 10, duration: 150 });
  assert.ok(pp.trajectory.length > 100);
  assert.ok(pp.vNullcline.length > 10);
  assert.ok(pp.uNullcline.length > 10);
  assert.equal(pp.I, 10);
});

test('phasePortraitIzh spike times match the marked samples', () => {
  const pp = N.phasePortraitIzh({ I: 10, duration: 200 });
  const marks = pp.trajectory.filter((p) => p.spike).map((p) => p.t);
  assert.deepEqual(marks, pp.spikes);
});

/* =============================================================== *
 * Hodgkin-Huxley reduced nullclines
 * =============================================================== */

test('hhReducedNullclines returns V and n nullcline arrays', () => {
  const nc = N.hhReducedNullclines(10);
  assert.ok(nc.vNull.length > 10);
  assert.ok(nc.nNull.length > 10);
  assert.equal(nc.I, 10);
});

test('n nullcline equals nInf at every sampled voltage', () => {
  const nc = N.hhReducedNullclines(0);
  nc.nNull.slice(0, 200).forEach((p) => {
    near(p.n, N.steadyStateGates(p.V).nInf, 1e-9);
  });
});

test('every V nullcline point solves the reduced dV/dt = 0 balance', () => {
  const I = 10;
  const hh = N.resolveHH({});
  const nc = N.hhReducedNullclines(I);
  nc.vNull.slice(0, 200).forEach((p) => {
    const g = N.steadyStateGates(p.V, hh);
    const iNa = hh.gNaEff * g.mInf * g.mInf * g.mInf * g.hInf * (p.V - hh.eNa);
    const iK = hh.gKEff * p.n * p.n * p.n * p.n * (p.V - hh.eK);
    const iL = hh.gL * (p.V - hh.eL);
    near(iNa + iK + iL, I, 0.5, `balance at V=${p.V}`);
  });
});

test('V nullcline only reports physically reachable n', () => {
  const nc = N.hhReducedNullclines(10);
  nc.vNull.forEach((p) => assert.ok(p.n >= 0 && p.n <= 1));
});

test('n nullcline is monotonically increasing in V', () => {
  const nc = N.hhReducedNullclines(0);
  for (let i = 1; i < nc.nNull.length; i += 1) {
    assert.ok(nc.nNull[i].n >= nc.nNull[i - 1].n - 1e-9);
  }
});

test('hhReducedNullclines honors a custom grid', () => {
  const nc = N.hhReducedNullclines(5, { vMin: -80, vMax: -40, step: 1 });
  assert.equal(nc.nNull.length, 41);
});

/* =============================================================== *
 * phasePortraitHH bundle
 * =============================================================== */

test('phasePortraitHH returns a (V, n) trajectory for a current step', () => {
  const pp = N.phasePortraitHH({ amplitude: 10, duration: 30 });
  assert.equal(pp.model, 'hodgkin-huxley');
  assert.ok(pp.trajectory.length > 100);
  pp.trajectory.forEach((p) => {
    assert.ok(Number.isFinite(p.V));
    assert.ok(p.n >= 0 && p.n <= 1);
  });
});

test('phasePortraitHH flags a limit cycle when the membrane fires', () => {
  const pp = N.phasePortraitHH({ amplitude: 10, duration: 50 });
  assert.equal(pp.isLimitCycle, true);
  assert.ok(pp.spikeCount >= 1);
});

test('phasePortraitHH is silent for subthreshold drive', () => {
  const pp = N.phasePortraitHH({ amplitude: 1, duration: 50 });
  assert.equal(pp.isLimitCycle, false);
  assert.equal(pp.spikeCount, 0);
});

test('phasePortraitHH includes the reduced nullclines at drive I', () => {
  const pp = N.phasePortraitHH({ amplitude: 12, duration: 20 });
  assert.equal(pp.I, 12);
  assert.ok(pp.vNullcline.length > 0);
  assert.ok(pp.nNullcline.length > 0);
});

test('phasePortraitHH spike times match the engine spike analysis', () => {
  const pp = N.phasePortraitHH({ amplitude: 10, duration: 40 });
  const tr = N.currentClamp({
    amplitude: 10, stimStart: 0, stimDuration: 40, postTime: 0,
  });
  assert.equal(pp.spikes.length, tr.spikes.length);
  near(pp.spikes[0], tr.spikes[0].time, 1e-9);
});

/* =============================================================== *
 * fISweep bundle
 * =============================================================== */

test('fISweep sweeps a uniform amplitude grid by default', () => {
  const sw = N.fISweep({ stimDuration: 100 });
  assert.deepEqual(sw.amplitudes, sw.points.map((p) => p.I));
  assert.ok(sw.points.length >= 10);
});

test('fISweep rates match the per point rate field', () => {
  const sw = N.fISweep({ maxI: 10, stepI: 5, stimDuration: 100 });
  assert.deepEqual(sw.rates, sw.points.map((p) => p.rate));
});

test('fISweep reports the bisection rheobase in the physiological range', () => {
  const sw = N.fISweep({ stimDuration: 200 });
  assert.ok(sw.rheobase > 1 && sw.rheobase < 6);
  assert.equal(sw.rheobaseDetail.converged, true);
});

test('firstSpikingI is the first amplitude with a nonzero rate', () => {
  const sw = N.fISweep({ maxI: 20, stepI: 2, stimDuration: 300 });
  const first = sw.points.find((p) => p.rate > 0);
  assert.equal(sw.firstSpikingI, first ? first.I : null);
  assert.ok(sw.firstSpikingI >= sw.rheobase - sw.points[1].I);
});

test('fISweep is monotonically nondecreasing on the default sweep', () => {
  const sw = N.fISweep();
  assert.equal(sw.monotonic, true);
});

test('fISweep honors a custom amplitude list', () => {
  const sw = N.fISweep({ amplitudes: [0, 7, 30], stimDuration: 100 });
  assert.deepEqual(sw.amplitudes, [0, 7, 30]);
});

test('fISweep filters non finite amplitudes out of the grid', () => {
  const sw = N.fISweep({ amplitudes: [NaN, 5, Infinity, 10], stimDuration: 80 });
  assert.deepEqual(sw.amplitudes, [5, 10]);
});

test('fISweep maxRate equals the largest sweep rate', () => {
  const sw = N.fISweep({ maxI: 15, stepI: 5, stimDuration: 200 });
  assert.equal(sw.maxRate, Math.max(...sw.rates));
});
