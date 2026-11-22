'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../src/neuro.js');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol,
    `${msg || ''} expected ${a} within ${tol} of ${b}`);

/* =============================================================== *
 * Microcircuit structure and determinism
 * =============================================================== */

test('stdpExperiment returns one presynaptic train per synapse', () => {
  const r = N.stdpExperiment({ nPre: 10, duration: 200, seed: 1 });
  assert.equal(r.preTrains.length, 10);
  assert.equal(r.params.nPre, 10);
});

test('each presynaptic train is sorted and bounded by the duration', () => {
  const r = N.stdpExperiment({ nPre: 8, duration: 400, seed: 2 });
  r.preTrains.forEach((ts) => {
    for (let i = 1; i < ts.length; i += 1) {
      assert.ok(ts[i] >= ts[i - 1], 'train not sorted');
    }
    ts.forEach((t) => assert.ok(t >= 0 && t < 400));
  });
});

test('preSpikes carry a time and a valid synapse index', () => {
  const r = N.stdpExperiment({ nPre: 6, duration: 300, seed: 3 });
  assert.equal(r.stats.preSpikeCount, r.preSpikes.length);
  r.preSpikes.forEach((s) => {
    assert.ok(Number.isFinite(s.t));
    assert.ok(s.neuron >= 0 && s.neuron < 6);
  });
});

test('stdpExperiment is bit reproducible for the same seed', () => {
  const a = N.stdpExperiment({ nPre: 8, duration: 400, seed: 11 });
  const b = N.stdpExperiment({ nPre: 8, duration: 400, seed: 11 });
  assert.deepEqual(a.weights.final, b.weights.final);
  assert.deepEqual(a.pairs, b.pairs);
  assert.deepEqual(a.postSpikes, b.postSpikes);
});

test('different seeds give different presynaptic trains', () => {
  const a = N.stdpExperiment({ nPre: 6, duration: 300, seed: 1 });
  const b = N.stdpExperiment({ nPre: 6, duration: 300, seed: 2 });
  assert.notDeepEqual(a.preTrains, b.preTrains);
});

test('params echo the resolved configuration', () => {
  const r = N.stdpExperiment({
    nPre: 5, duration: 200, seed: 9, drive: 'poisson', rate: 15,
    stdp: { aPlus: 0.02 }, dt: 0.5,
  });
  assert.equal(r.params.rate, 15);
  assert.equal(r.params.drive, 'poisson');
  assert.equal(r.params.stdp.aPlus, 0.02);
  assert.equal(r.params.stdp.aMinus, N.STDP_DEFAULTS.aMinus);
  assert.equal(r.params.postModel, 'lif');
});

/* =============================================================== *
 * Weight bounds and trajectory
 * =============================================================== */

test('weights stay inside the hard bounds for the whole run', () => {
  const r = N.stdpExperiment({
    nPre: 8, duration: 600, seed: 4,
    stdp: { wMin: 0, wMax: 6 },
  });
  for (const snap of r.weights.trajectory) {
    snap.weights.forEach((w) => {
      assert.ok(w >= -1e-9 && w <= 6 + 1e-9, `weight ${w}`);
    });
  }
});

test('weight trajectory snapshots cover the run with ascending times', () => {
  const r = N.stdpExperiment({ nPre: 5, duration: 400, seed: 6, recordEvery: 4 });
  assert.ok(r.weights.trajectory.length >= 50);
  for (let i = 1; i < r.weights.trajectory.length; i += 1) {
    assert.ok(r.weights.trajectory[i].t > r.weights.trajectory[i - 1].t);
    assert.equal(r.weights.trajectory[i].weights.length, 5);
  }
});

test('meanTrajectory equals the per synapse mean of each snapshot', () => {
  const r = N.stdpExperiment({ nPre: 4, duration: 300, seed: 7 });
  assert.equal(r.weights.meanTrajectory.length, r.weights.trajectory.length);
  const last = r.weights.trajectory[r.weights.trajectory.length - 1];
  const mean = last.weights.reduce((a, x) => a + x, 0) / last.weights.length;
  near(r.weights.meanTrajectory[r.weights.meanTrajectory.length - 1].mean,
    mean, 1e-9);
});

test('w0 scalar initializes every weight and array form sets each synapse', () => {
  const a = N.stdpExperiment({ nPre: 4, duration: 5, w0: 1.5, seed: 1 });
  assert.ok(a.weights.initial.every((w) => w === 1.5));
  const b = N.stdpExperiment({ nPre: 3, duration: 5, w0: [1, 2, 3], seed: 1 });
  assert.deepEqual(b.weights.initial, [1, 2, 3]);
});

test('w0 values outside the bounds are clamped', () => {
  const r = N.stdpExperiment({
    nPre: 3, duration: 5, w0: [-5, 999, 2], seed: 1,
  });
  assert.deepEqual(r.weights.initial, [0, N.STDP_DEFAULTS.wMax, 2]);
});

test('final weights equal the last trajectory snapshot', () => {
  const r = N.stdpExperiment({ nPre: 5, duration: 400, seed: 8 });
  const last = r.weights.trajectory[r.weights.trajectory.length - 1];
  assert.deepEqual(r.weights.final, last.weights);
});

/* =============================================================== *
 * Pair events and the spike timing correlation record
 * =============================================================== */

test('every recorded pair respects the STDP window horizon', () => {
  const win = 25;
  const r = N.stdpExperiment({
    nPre: 6, duration: 400, seed: 9, stdp: { window: win },
  });
  r.pairs.forEach((p) => assert.ok(Math.abs(p.deltaT) <= win + 1e-9));
});

test('pair kind matches the sign of deltaT', () => {
  const r = N.stdpExperiment({ nPre: 8, duration: 500, seed: 10 });
  assert.ok(r.pairs.length > 0);
  r.pairs.forEach((p) => {
    assert.equal(p.kind, p.deltaT >= 0 ? 'ltp' : 'ltd');
  });
});

test('pair weight update equals clamp(before + dw)', () => {
  const r = N.stdpExperiment({ nPre: 6, duration: 500, seed: 12 });
  r.pairs.forEach((p) => {
    const want = N.clamp(p.wBefore + p.dw, r.params.stdp.wMin, r.params.stdp.wMax);
    near(p.wAfter, want, 1e-9);
  });
});

test('pair dw equals stdpDeltaW at the recorded deltaT', () => {
  const r = N.stdpExperiment({ nPre: 6, duration: 500, seed: 13 });
  r.pairs.forEach((p) => {
    near(p.dw, N.stdpDeltaW(p.deltaT, r.params.stdp), 1e-12);
  });
});

test('ltp and ltd event counters match the pair list', () => {
  const r = N.stdpExperiment({ nPre: 8, duration: 500, seed: 14 });
  const ltp = r.pairs.filter((p) => p.dw >= 0).length;
  const ltd = r.pairs.filter((p) => p.dw < 0).length;
  assert.equal(r.stats.ltpEvents, ltp);
  assert.equal(r.stats.ltdEvents, ltd);
  assert.equal(r.stats.totalPairEvents, r.pairs.length);
});

test('burst drive produces causal pairings: LTP outnumbers LTD', () => {
  const r = N.stdpExperiment({ nPre: 16, duration: 1000, drive: 'burst', seed: 5 });
  assert.ok(r.stats.postSpikeCount > 0);
  assert.ok(r.stats.ltpEvents > r.stats.ltdEvents,
    `ltp ${r.stats.ltpEvents} ltd ${r.stats.ltdEvents}`);
  assert.ok(r.stats.deltaMeanWeight > 0);
});

test('causal LTP pairs cluster at small positive deltaT under bursts', () => {
  const r = N.stdpExperiment({ nPre: 16, duration: 1000, drive: 'burst', seed: 5 });
  const ltpDts = r.pairs.filter((p) => p.deltaT > 0).map((p) => p.deltaT);
  assert.ok(ltpDts.length > 0);
  const small = ltpDts.filter((d) => d <= 15).length;
  assert.ok(small / ltpDts.length > 0.5,
    `causal cluster ${small}/${ltpDts.length}`);
});

test('pair timestamps sit inside the simulation window', () => {
  const r = N.stdpExperiment({ nPre: 6, duration: 300, seed: 15 });
  r.pairs.forEach((p) => assert.ok(p.t >= 0 && p.t <= 300 + 1e-9));
});

test('custom STDP amplitudes scale the recorded dw', () => {
  const r = N.stdpExperiment({
    nPre: 6, duration: 400, seed: 16, stdp: { aPlus: 0.05, aMinus: 0.04 },
  });
  const ltpMax = Math.max(...r.pairs.filter((p) => p.dw > 0).map((p) => p.dw));
  assert.ok(ltpMax <= 0.05 + 1e-9);
  const ltdMin = Math.min(...r.pairs.filter((p) => p.dw < 0).map((p) => p.dw));
  assert.ok(ltdMin >= -0.04 - 1e-9);
});

/* =============================================================== *
 * Postsynaptic cell and both backends
 * =============================================================== */

test('the LIF backend produces postsynaptic spikes and a voltage trace', () => {
  const r = N.stdpExperiment({ nPre: 12, duration: 600, seed: 17 });
  assert.ok(r.stats.postSpikeCount > 0);
  assert.equal(r.vTrace.t.length, r.vTrace.V.length);
  assert.equal(r.vTrace.t.length, r.vTrace.iSyn.length);
  r.vTrace.V.forEach((v) => assert.ok(Number.isFinite(v)));
});

test('mean postsynaptic rate is reported in Hz', () => {
  const r = N.stdpExperiment({ nPre: 12, duration: 600, seed: 18 });
  near(r.stats.meanPostRateHz, r.stats.postSpikeCount * 1000 / 600, 1e-9);
});

test('the Hodgkin-Huxley backend integrates with RK4', () => {
  const r = N.stdpExperiment({
    nPre: 10, duration: 400, seed: 19, postModel: 'hh', bias: 5,
  });
  assert.equal(r.params.postModel, 'hh');
  r.vTrace.V.forEach((v) => {
    assert.ok(Number.isFinite(v));
    assert.ok(v > -120 && v < 80, `V ${v}`);
  });
});

test('hh backend postsynaptic spikes register as pair partners', () => {
  const r = N.stdpExperiment({
    nPre: 12, duration: 600, seed: 20, postModel: 'hh', bias: 6,
  });
  assert.ok(r.postSpikes.length > 0, `posts ${r.postSpikes.length}`);
  if (r.postSpikes.length > 0) assert.ok(r.pairs.length > 0);
});

test('postSpikes only occur inside the STDP window check', () => {
  const r = N.stdpExperiment({ nPre: 10, duration: 400, seed: 21 });
  r.postSpikes.forEach((t) => assert.ok(t >= 0 && t <= 400 + 1e-9));
});

/* =============================================================== *
 * Edge cases and statistics
 * =============================================================== */

test('a minimal one synapse experiment still runs cleanly', () => {
  const r = N.stdpExperiment({ nPre: 1, duration: 200, seed: 22, rate: 30 });
  assert.equal(r.preTrains.length, 1);
  assert.equal(r.weights.initial.length, 1);
  assert.equal(r.weights.final.length, 1);
});

test('nPre is clamped into the supported range', () => {
  assert.equal(N.stdpExperiment({ nPre: 0.4, duration: 20 }).preTrains.length, 1);
  assert.equal(N.stdpExperiment({ nPre: 9999, duration: 5 }).preTrains.length, 400);
});

test('a very short duration produces a valid empty-ish result', () => {
  const r = N.stdpExperiment({ nPre: 4, duration: 1, seed: 23 });
  assert.equal(r.params.duration, 1);
  assert.ok(Number.isFinite(r.stats.deltaMeanWeight));
});

test('stats fields are all finite numbers', () => {
  const r = N.stdpExperiment({ nPre: 8, duration: 400, seed: 24 });
  ['preSpikeCount', 'postSpikeCount', 'meanPostRateHz', 'ltpEvents',
    'ltdEvents', 'meanWeightInitial', 'meanWeightFinal',
    'deltaMeanWeight', 'totalPairEvents'].forEach((k) =>
    assert.ok(Number.isFinite(r.stats[k]), `${k}`));
});

test('stats deltaMeanWeight equals final minus initial mean', () => {
  const r = N.stdpExperiment({ nPre: 6, duration: 300, seed: 25 });
  near(r.stats.deltaMeanWeight,
    r.stats.meanWeightFinal - r.stats.meanWeightInitial, 1e-9);
});

test('drive option falls back to burst for unknown values', () => {
  const r = N.stdpExperiment({ nPre: 4, duration: 100, drive: 'nonsense' });
  assert.equal(r.params.drive, 'burst');
});

test('poisson drive leaves synchrony out of the presynaptic trains', () => {
  const r = N.stdpExperiment({ nPre: 12, duration: 1000, drive: 'poisson', seed: 26 });
  // Independent trains: inter event gaps are roughly exponential, so the
  // coefficient of variation of each train's ISIs stays near 1.
  const cv = (ts) => {
    const isis = ts.slice(1).map((t, i) => t - ts[i]);
    const m = isis.reduce((a, x) => a + x, 0) / isis.length;
    const v = isis.reduce((a, x) => a + (x - m) * (x - m), 0) / isis.length;
    return Math.sqrt(v) / m;
  };
  const train = r.preTrains.find((t) => t.length > 10);
  assert.ok(train, 'no train long enough');
  assert.ok(cv(train) > 0.5, `cv ${cv(train)}`);
});

test('pairsAll aliases the pairs list for export code', () => {
  const r = N.stdpExperiment({ nPre: 4, duration: 200, seed: 27 });
  assert.equal(r.pairsAll, r.pairs);
});
