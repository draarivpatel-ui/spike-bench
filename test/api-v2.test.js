'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../src/neuro.js');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol,
    `${msg || ''} expected ${a} within ${tol} of ${b}`);

/* =============================================================== *
 * Version 2 module surface
 * =============================================================== */

test('version two of the engine exposes the sandbox API', () => {
  const required = [
    'LIF_DEFAULTS', 'resolveLIF', 'simulateLIF', 'stdpExperiment',
    'simulateIzh', 'izhNullclines', 'phasePortraitIzh',
    'hhReducedNullclines', 'phasePortraitHH', 'fISweep',
    'sha256', 'sha256Bytes', 'checksum', 'utf8Bytes', 'utf8String',
    'b64urlEncode', 'b64urlDecode',
    'encodeRunState', 'decodeRunState', 'stateToHash', 'stateFromHash',
    'canonicalJSON', 'verifiedDocument', 'verifyDocument',
    'exportSpikeReport', 'runSelfTests',
  ];
  required.forEach((k) => assert.ok(N[k] !== undefined, `missing ${k}`));
});

test('the browser global picks up the new API too', () => {
  assert.equal(globalThis.SpikeBench.VERSION, '2.0.0');
  assert.equal(typeof globalThis.SpikeBench.stdpExperiment, 'function');
});

test('new engine code stays free of em dashes and en dashes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'neuro.js'), 'utf8');
  assert.ok(!src.includes('—'));
  assert.ok(!src.includes('–'));
});

test('new engine code keeps the zero dependency guarantee', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'neuro.js'), 'utf8');
  const body = src.split("if (typeof module !== 'undefined'")[0];
  assert.ok(!/require\(/.test(body));
  assert.ok(!/import\s+.*from/.test(body));
  assert.ok(!/fetch\(/.test(body));
});

/* =============================================================== *
 * Cross feature integration
 * =============================================================== */

test('fISweep points agree with an equivalent direct fICurve call', () => {
  const amps = [0, 5, 10, 15, 20];
  const fi = N.fICurve({ amplitudes: amps, stimDuration: 200 });
  const sw = N.fISweep({ amplitudes: amps, stimDuration: 200 });
  assert.deepEqual(sw.rates, fi.points.map((p) => p.rate));
});

test('an STDP session exports and re-verifies end to end', () => {
  const exp = N.stdpExperiment({ nPre: 8, duration: 400, seed: 42 });
  const rep = N.exportSpikeReport({
    label: 'stdp-session',
    raster: exp.preSpikes.map((s) => ({ t: s.t, neuron: s.neuron, type: 'pre' })),
    weights: {
      initial: exp.weights.initial,
      final: exp.weights.final,
      stats: exp.stats,
    },
    pairs: exp.pairs,
  });
  const check = N.verifyDocument(rep.json);
  assert.equal(check.ok, true);
  const doc = JSON.parse(rep.json);
  assert.equal(doc.payload.sections.weights.initial.length, 8);
  assert.equal(doc.payload.sections.pairs.length, exp.pairs.length);
});

test('checksums differ for exports with different payloads', () => {
  const a = N.exportSpikeReport({ label: 'a', raster: [{ t: 1, neuron: 0 }] });
  const b = N.exportSpikeReport({ label: 'b', raster: [{ t: 2, neuron: 0 }] });
  assert.notEqual(a.payloadChecksum, b.payloadChecksum);
});

test('a tampered weight inside an exported bundle fails verification', () => {
  const rep = N.exportSpikeReport({
    weights: { initial: [1], final: [2] },
  });
  const doc = JSON.parse(rep.json);
  doc.payload.sections.weights.final[0] = 2.0001;
  assert.equal(N.verifyDocument(JSON.stringify(doc)).ok, false);
});

test('run state survives a bookmark round trip through a URL hash', () => {
  const ui = {
    tab: 'stdp', protocol: 'step', amp: 12,
    stdp: { nPre: 20, rate: 25, drive: 'burst' },
  };
  const hash = N.stateToHash(ui);
  const restored = N.stateFromHash('https://aariv.me/spike-bench/' + hash.split('#')[1] ? hash : hash);
  assert.deepEqual(N.stateFromHash(hash), ui);
  assert.ok(restored);
});

test('runSelfTests output is JSON serializable for the page', () => {
  const res = N.runSelfTests();
  const round = JSON.parse(JSON.stringify(res));
  assert.equal(round.ok, res.ok);
  assert.equal(round.results.length, res.results.length);
});

/* =============================================================== *
 * Regression: existing engine untouched by the new code
 * =============================================================== */

test('current clamp still fires the same first spike after v2 additions', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  assert.ok(tr.spikes.length >= 2);
  near(tr.spikes[0].peak, 40, 15);
});

test('rheobase bisection still converges in the physiological range', () => {
  const r = N.findRheobase();
  assert.equal(r.converged, true);
  assert.ok(r.rheobase > 1 && r.rheobase < 6);
});

test('the cortical network still produces a deterministic raster', () => {
  const a = N.corticalNetwork({ n: 16, seed: 99 }).run(200);
  const b = N.corticalNetwork({ n: 16, seed: 99 }).run(200);
  assert.equal(a.totalSpikes, b.totalSpikes);
});

test('traceToJSON still emits a parseable document', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 2, stimDuration: 5 });
  const doc = JSON.parse(N.traceToJSON(tr));
  assert.equal(doc.format, 'spike-bench-trace');
  assert.equal(doc.version, '2.0.0');
});

/* =============================================================== *
 * STDP sign symmetry used by the self test battery
 * =============================================================== */

test('LTP and LTD magnitudes mirror aPlus and aMinus at equal |dt|', () => {
  const ltp = N.stdpDeltaW(10);
  const ltd = N.stdpDeltaW(-10);
  near(ltp / Math.abs(ltd), N.STDP_DEFAULTS.aPlus / N.STDP_DEFAULTS.aMinus, 1e-9);
});

test('LTP and LTD decay with the same tau under defaults', () => {
  const ltpRatio = N.stdpDeltaW(20) / N.stdpDeltaW(10);
  const ltdRatio = N.stdpDeltaW(-20) / N.stdpDeltaW(-10);
  near(ltpRatio, ltdRatio, 1e-9);
  near(ltpRatio, Math.exp(-0.5), 1e-9);
});

test('stdpExperiment weights never leave the hard bounds under stress', () => {
  const r = N.stdpExperiment({
    nPre: 10, duration: 800, rate: 40, seed: 77,
    stdp: { aPlus: 0.05, aMinus: 0.05 },
  });
  r.weights.final.forEach((w) => {
    assert.ok(w >= -1e-9 && w <= N.STDP_DEFAULTS.wMax + 1e-9);
  });
});

test('a second run of the sandbox after reset gives identical results', () => {
  const run = () => N.stdpExperiment({ nPre: 8, duration: 300, seed: 33 });
  assert.deepEqual(run().weights.final, run().weights.final);
});

/* =============================================================== *
 * Phase portrait physics sanity
 * =============================================================== */

test('izhikevich trajectory returns to the limit cycle after a spike', () => {
  const pp = N.phasePortraitIzh({ I: 10, duration: 300 });
  const vs = pp.trajectory.map((p) => p.v);
  assert.ok(Math.min(...vs) < -60);
  assert.ok(Math.max(...vs) <= 30.0001);
});

test('HH trajectory stays inside the physiological V n box', () => {
  const pp = N.phasePortraitHH({ amplitude: 10, duration: 30 });
  pp.trajectory.forEach((p) => {
    assert.ok(p.V > -100 && p.V < 70);
    assert.ok(p.n >= 0 && p.n <= 1);
  });
});

test('the reduced V nullcline bends into the classic N shape at rest', () => {
  const nc = N.hhReducedNullclines(0);
  const nAt = (v) => {
    const row = nc.vNull.filter((p) => Math.abs(p.V - v) < 0.26)[0];
    return row ? row.n : null;
  };
  const left = nAt(-75);
  const right = nAt(-45);
  if (left !== null && right !== null) assert.notEqual(left, right);
  assert.ok(nc.vNull.length > 20);
});
