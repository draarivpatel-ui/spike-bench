'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../src/neuro.js');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol,
    `${msg || ''} expected ${a} within ${tol} of ${b}`);

/* =============================================================== *
 * 1. Module surface and versioning
 * =============================================================== */

test('module exports a semantic version string', () => {
  assert.equal(N.VERSION, '1.0.0');
  assert.match(N.VERSION, /^\d+\.\d+\.\d+$/);
});

test('module exposes the full public API', () => {
  const required = [
    'HH_DEFAULTS', 'IZH_TYPES', 'STDP_DEFAULTS', 'FREQ_BANDS',
    'rateFunctions', 'steadyStateGates', 'hhCurrents', 'rk4Step',
    'simulateHH', 'HodgkinHuxley', 'currentClamp', 'fICurve',
    'findRheobase', 'refractoryPeriod', 'voltageClamp',
    'familyVoltageClamp', 'stdpDeltaW', 'applySTDP', 'stdpCurve',
    'CorticalNetwork', 'corticalNetwork', 'powerSpectrum',
    'lfpPowerSpectrum', 'traceToCSV', 'traceToJSON', 'mulberry32',
  ];
  required.forEach((k) => assert.ok(N[k] !== undefined, `missing ${k}`));
});

test('default constants match the classic squid giant axon', () => {
  assert.equal(N.HH_DEFAULTS.gNa, 120);
  assert.equal(N.HH_DEFAULTS.gK, 36);
  assert.equal(N.HH_DEFAULTS.gL, 0.3);
  assert.equal(N.HH_DEFAULTS.vRest, -65);
  assert.equal(N.HH_DEFAULTS.cM, 1);
  assert.equal(N.HH_DEFAULTS.q10, 3);
});

test('cortical neuron type table contains all four phenotypes', () => {
  ['RS', 'IB', 'FS', 'CH'].forEach((k) => assert.ok(N.IZH_TYPES[k]));
  assert.equal(N.IZH_TYPES.RS.excitatory, true);
  assert.equal(N.IZH_TYPES.IB.excitatory, true);
  assert.equal(N.IZH_TYPES.CH.excitatory, true);
  assert.equal(N.IZH_TYPES.FS.excitatory, false);
});

/* =============================================================== *
 * 2. Helpers, parameter resolution and temperature
 * =============================================================== */

test('clamp keeps values inside bounds and handles non finite input', () => {
  assert.equal(N.clamp(5, 0, 1), 1);
  assert.equal(N.clamp(-5, 0, 1), 0);
  assert.equal(N.clamp(0.5, 0, 1), 0.5);
  // Positive infinity is clamped to the upper bound; a NaN falls back to lo.
  assert.equal(N.clamp(Infinity, 0, 1), 1);
  assert.equal(N.clamp(-Infinity, 0, 1), 0);
  assert.equal(N.clamp(NaN, 0, 1), 0);
});

test('Q10 temperature factor is one at reference and scales by powers of three', () => {
  near(N.temperatureFactor(6.3), 1, 1e-9);
  near(N.temperatureFactor(16.3), 3, 1e-9);
  near(N.temperatureFactor(26.3), 9, 1e-9);
  near(N.temperatureFactor(-3.7), 1 / 3, 1e-9);
});

test('resolveHH clamps blocker fractions into the unit interval', () => {
  assert.equal(N.resolveHH({ ttx: 2 }).ttx, 1);
  assert.equal(N.resolveHH({ ttx: -3 }).ttx, 0);
  assert.equal(N.resolveHH({ tea: 5 }).tea, 1);
  assert.equal(N.resolveHH({ tea: -1 }).tea, 0);
});

test('resolveHH computes effective conductances from channel blockers', () => {
  const hh = N.resolveHH({ ttx: 0.25, tea: 0.5 });
  near(hh.gNaEff, 90, 1e-9);
  near(hh.gKEff, 18, 1e-9);
  assert.equal(N.resolveHH({ ttx: 1 }).gNaEff, 0);
  assert.equal(N.resolveHH({ tea: 1 }).gKEff, 0);
});

test('mulberry32 is deterministic and bounded', () => {
  const a = N.mulberry32(42);
  const b = N.mulberry32(42);
  for (let k = 0; k < 20; k += 1) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(N.mulberry32(1)(), N.mulberry32(2)());
});

/* =============================================================== *
 * 3. Rate functions and steady state gating
 * =============================================================== */

test('rate functions return six finite nonnegative rates', () => {
  const r = N.rateFunctions(-65);
  ['alphaM', 'betaM', 'alphaH', 'betaH', 'alphaN', 'betaN'].forEach((k) => {
    assert.ok(Number.isFinite(r[k]), `${k} finite`);
    assert.ok(r[k] >= 0, `${k} nonnegative`);
  });
});

test('rate functions reproduce the classic values at rest', () => {
  const r = N.rateFunctions(-65);
  near(r.alphaM, 0.2236, 1e-3);
  near(r.betaM, 4, 1e-9);
  near(r.alphaH, 0.07, 1e-9);
  near(r.betaH, 0.0474, 1e-3);
  near(r.alphaN, 0.0582, 1e-3);
  near(r.betaN, 0.125, 1e-9);
});

test('rate functions handle the removable singularity without NaN', () => {
  // V - vRest = 10 gives un = 0, V - vRest = 25 gives um = 0.
  const a = N.rateFunctions(-55);
  const b = N.rateFunctions(-40);
  assert.ok(Number.isFinite(a.alphaN));
  assert.ok(Number.isFinite(b.alphaM));
  // lim un/expm1(un) -> 1, so alphaN -> 0.1
  near(a.alphaN, 0.1, 1e-6);
  near(b.alphaM, 1, 1e-6);
});

test('steady state gates at rest give the textbook m h n values', () => {
  const g = N.steadyStateGates(-65);
  near(g.mInf, 0.0529, 1e-3);
  near(g.hInf, 0.5961, 1e-3);
  near(g.nInf, 0.3177, 1e-3);
  assert.equal(g.m, g.mInf);
  assert.equal(g.h, g.hInf);
  assert.equal(g.n, g.nInf);
});

test('depolarization increases m and n but decreases h', () => {
  const rest = N.steadyStateGates(-65);
  const dep = N.steadyStateGates(-20);
  assert.ok(dep.mInf > rest.mInf);
  assert.ok(dep.nInf > rest.nInf);
  assert.ok(dep.hInf < rest.hInf);
});

test('gate time constants are positive and m is fastest at rest', () => {
  const g = N.steadyStateGates(-65);
  assert.ok(g.tauM > 0 && g.tauH > 0 && g.tauN > 0);
  assert.ok(g.tauM < g.tauN);
  assert.ok(g.tauM < g.tauH);
});

test('warmth shortens every gate time constant through Q10', () => {
  const cold = N.steadyStateGates(-65, { temperature: 6.3 });
  const warm = N.steadyStateGates(-65, { temperature: 16.3 });
  near(warm.tauM * 3, cold.tauM, 1e-6);
  near(warm.tauH * 3, cold.tauH, 1e-6);
  near(warm.tauN * 3, cold.tauN, 1e-6);
});

/* =============================================================== *
 * 4. Ionic currents
 * =============================================================== */

test('hhCurrents returns sodium, potassium, leak and total currents', () => {
  const g = N.steadyStateGates(-65);
  const c = N.hhCurrents(-65, g);
  ['iNa', 'iK', 'iL', 'iIonic', 'gNaEff', 'gKEff'].forEach((k) =>
    assert.ok(Number.isFinite(c[k]), `${k} finite`));
  near(c.iIonic, c.iNa + c.iK + c.iL, 1e-9);
});

test('at rest sodium and potassium currents are small and leak balances them', () => {
  const g = N.steadyStateGates(-65);
  const c = N.hhCurrents(-65, g);
  assert.ok(Math.abs(c.iNa) < 10);
  assert.ok(Math.abs(c.iK) < 10);
  assert.ok(Math.abs(c.iIonic) < 1);
});

test('sodium current is inward and potassium outward during strong depolarization', () => {
  const c = N.hhCurrents(-20, { m: 1, h: 0.5, n: 0.8 });
  assert.ok(c.iNa < 0, 'sodium inward');
  assert.ok(c.iK > 0, 'potassium outward');
  assert.ok(c.iL > 0, 'leak outward');
});

test('sodium current vanishes at its reversal potential', () => {
  const c = N.hhCurrents(50, { m: 1, h: 1, n: 0 });
  near(c.iNa, 0, 1e-9);
});

test('potassium current vanishes at its reversal potential', () => {
  const c = N.hhCurrents(-77, { m: 0, h: 0, n: 1 });
  near(c.iK, 0, 1e-9);
});

test('TTX scales sodium current without touching potassium current', () => {
  const g = { m: 1, h: 1, n: 1 };
  const base = N.hhCurrents(-20, g);
  const ttx = N.hhCurrents(-20, g, { ttx: 0.5 });
  near(ttx.iNa, base.iNa * 0.5, 1e-6);
  near(ttx.iK, base.iK, 1e-9);
  assert.equal(N.hhCurrents(-20, g, { ttx: 1 }).iNa, 0);
});

test('TEA scales potassium current without touching sodium current', () => {
  const g = { m: 1, h: 1, n: 1 };
  const base = N.hhCurrents(-20, g);
  const tea = N.hhCurrents(-20, g, { tea: 0.5 });
  near(tea.iK, base.iK * 0.5, 1e-6);
  near(tea.iNa, base.iNa, 1e-9);
  assert.equal(N.hhCurrents(-20, g, { tea: 1 }).iK, 0);
});

/* =============================================================== *
 * 5. RK4 solver correctness
 * =============================================================== */

test('a single RK4 step keeps gates inside the physical range', () => {
  const g = N.steadyStateGates(-65);
  const s = { V: -65, m: g.m, h: g.h, n: g.n };
  const next = N.rk4Step(s, 0, 0.01);
  [next.m, next.h, next.n].forEach((x) => assert.ok(x >= 0 && x <= 1));
  assert.ok(Number.isFinite(next.V));
});

test('zero current RK4 step preserves resting potential', () => {
  const g = N.steadyStateGates(-65);
  const s = { V: -65, m: g.m, h: g.h, n: g.n };
  const next = N.rk4Step(s, 0, 0.05);
  near(next.V, -65, 0.01);
});

test('rk4Step accepts a waveform function for the injected current', () => {
  const g = N.steadyStateGates(-65);
  const s = { V: -65, m: g.m, h: g.h, n: g.n };
  const a = N.rk4Step(s, (off) => 10, 0.05);
  const b = N.rk4Step(s, 10, 0.05);
  near(a.V, b.V, 1e-9);
});

test('RK4 with half the step still converges to the same spike peak', () => {
  const common = { amplitude: 10, stimStart: 5, stimDuration: 20, postTime: 5 };
  const a = N.currentClamp(Object.assign({}, common, { dt: 0.02 }));
  const b = N.currentClamp(Object.assign({}, common, { dt: 0.01 }));
  assert.ok(a.spikes.length > 0 && b.spikes.length > 0);
  near(a.spikes[0].peak, b.spikes[0].peak, 1.5);
});

test('makeStep and makeRamp produce the expected waveforms', () => {
  const s = N.makeStep(7, 5, 10);
  assert.equal(s(4), 0);
  assert.equal(s(5), 7);
  assert.equal(s(14), 7);
  assert.equal(s(15), 0);
  const r = N.makeRamp(10, 5, 10);
  assert.equal(r(4), 0);
  near(r(10), 5, 1e-9);
  assert.equal(r(15), 0);
});

/* =============================================================== *
 * 6. Resting potential stability
 * =============================================================== */

test('resting membrane is stable over 50 ms with no injected current', () => {
  const tr = N.simulateHH({ totalDuration: 50, dt: 0.01 });
  const drift = tr.V[tr.V.length - 1] - tr.V[0];
  assert.ok(Math.abs(drift) < 0.05, `drift ${drift}`);
  assert.equal(tr.spikes.length, 0);
});

test('resting membrane stays stable over a long 500 ms free run', () => {
  const tr = N.simulateHH({ totalDuration: 500, dt: 0.02 });
  const drift = tr.V[tr.V.length - 1] - tr.V[0];
  assert.ok(Math.abs(drift) < 0.1);
  assert.equal(tr.spikes.length, 0);
});

test('every resting sample sits within a narrow band around vRest', () => {
  const tr = N.simulateHH({ totalDuration: 100, dt: 0.01 });
  tr.V.forEach((v) => assert.ok(v > -65.1 && v < -64.9));
});

test('resting state gates are stationary under a free run', () => {
  const tr = N.simulateHH({ totalDuration: 50, dt: 0.01 });
  near(tr.m[0], tr.m[tr.m.length - 1], 1e-3);
  near(tr.h[0], tr.h[tr.h.length - 1], 1e-3);
  near(tr.n[0], tr.n[tr.n.length - 1], 1e-3);
});

test('the trace arrays all share one common length', () => {
  const tr = N.simulateHH({ totalDuration: 30, dt: 0.01 });
  const L = tr.t.length;
  ['V', 'I', 'iNa', 'iK', 'iL', 'm', 'h', 'n'].forEach((k) =>
    assert.equal(tr[k].length, L, `${k} length`));
});

/* =============================================================== *
 * 7. Action potentials, spike detection and shape
 * =============================================================== */

test('a suprathreshold current step evokes action potentials', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  assert.ok(tr.spikes.length >= 2, `spikes ${tr.spikes.length}`);
});

test('action potential overshoots zero millivolts', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  assert.ok(tr.spikes[0].peak > 0, `peak ${tr.spikes[0].peak}`);
  assert.ok(tr.spikes[0].peak < 60, `peak ${tr.spikes[0].peak}`);
});

test('spike foot threshold is well below the overshoot', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  const s = tr.spikes[0];
  assert.ok(s.thresholdV < 0, `foot ${s.thresholdV}`);
  assert.ok(s.thresholdV > -65);
  assert.ok(s.thresholdV < s.peak - 50);
});

test('spike amplitude and overshoot fields are consistent', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  const s = tr.spikes[0];
  near(s.amplitude, s.peak - tr.meta.vRest, 1e-9);
  assert.equal(s.overshoot, s.peak);
});

test('spike half width is in the classic squid axon range', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  const s = tr.spikes[0];
  assert.ok(s.halfWidth > 0.3 && s.halfWidth < 5, `width ${s.halfWidth}`);
});

test('afterhyperpolarization drops below the resting potential', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  assert.ok(tr.spikes[0].ahp < tr.meta.vRest, `ahp ${tr.spikes[0].ahp}`);
});

test('detectSpikes and countSpikes agree with the analyzed spike list', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  assert.equal(N.detectSpikes(tr).length, tr.spikes.length);
  assert.equal(N.countSpikes(tr), tr.spikes.length);
  assert.equal(N.detectSpikes(tr)[0], tr.spikes[0].time);
});

test('spikeStats reports a positive firing rate and mean peak', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
  assert.ok(tr.stats.count >= 2);
  assert.ok(tr.stats.meanRateHz > 0);
  assert.ok(tr.stats.meanPeak > 0);
  assert.ok(tr.stats.meanAmplitude > 100);
});

test('a subthreshold current step evokes no spikes', () => {
  const tr = N.currentClamp({ amplitude: 1, stimStart: 5, stimDuration: 40 });
  assert.equal(tr.spikes.length, 0);
});

/* =============================================================== *
 * 8. Current clamp protocols
 * =============================================================== */

test('currentClamp stores stimulus metadata in the trace', () => {
  const tr = N.currentClamp({ amplitude: 12, stimStart: 3, stimDuration: 25, postTime: 8 });
  assert.equal(tr.meta.mode, 'current clamp step');
  assert.equal(tr.meta.amplitude, 12);
  assert.equal(tr.meta.stimStart, 3);
  assert.equal(tr.meta.stimDuration, 25);
  assert.equal(tr.meta.postTime, 8);
});

test('the current step is on during the stimulus window only', () => {
  const tr = N.currentClamp({ amplitude: 9, stimStart: 5, stimDuration: 10, postTime: 5 });
  const at = (t) => tr.I[Math.round(t / tr.dt)];
  assert.equal(at(4), 0);
  assert.equal(at(6), 9);
  assert.equal(at(14.9), 9);
  assert.equal(at(16), 0);
});

test('a ramp stimulus fires later than a matched step', () => {
  const step = N.currentClamp({ amplitude: 40, stimStart: 5, stimDuration: 100, postTime: 5 });
  const ramp = N.currentClamp({
    amplitude: 40, stimStart: 5, stimDuration: 100, postTime: 5,
    stimulusType: 'ramp',
  });
  assert.ok(step.spikes.length > 0 && ramp.spikes.length > 0);
  assert.ok(ramp.spikes[0].time > step.spikes[0].time);
});

test('ramp current increases linearly across the stimulus window', () => {
  const tr = N.currentClamp({
    amplitude: 30, stimStart: 5, stimDuration: 100, postTime: 0,
    stimulusType: 'ramp',
  });
  const at = (t) => tr.I[Math.round(t / tr.dt)];
  near(at(55), 15, 0.01);
  assert.ok(at(25) < at(75));
});

test('HodgkinHuxley class reset returns the membrane to vRest', () => {
  const hh = new N.HodgkinHuxley();
  hh.step(20, 0.5);
  assert.notEqual(hh.state.V, -65);
  const s = hh.reset();
  assert.equal(s.V, -65);
  assert.equal(hh.t, 0);
});

test('HodgkinHuxley class run matches simulateHH for the same protocol', () => {
  const stimulus = (t) => (t >= 5 && t < 25 ? 10 : 0);
  const a = N.simulateHH({ stimulus, totalDuration: 35, dt: 0.01 });
  const b = new N.HodgkinHuxley({ dt: 0.01 }).run({
    stimulus, totalDuration: 35, dt: 0.01,
  });
  assert.equal(a.spikes.length, b.spikes.length);
  near(a.spikes[0].peak, b.spikes[0].peak, 1e-6);
});

/* =============================================================== *
 * 9. f-I curve and rheobase
 * =============================================================== */

test('fICurve reports zero rate for subthreshold currents', () => {
  const fi = N.fICurve({ amplitudes: [0, 1, 2], stimDuration: 300 });
  fi.points.slice(0, 3).forEach((p) => assert.equal(p.rate, 0));
});

test('fI curve is monotonically nondecreasing over the full default sweep', () => {
  const fi = N.fICurve();
  assert.equal(fi.monotonic, true);
  assert.ok(fi.maxRate > 0);
});

test('fI curve maximum rate exceeds its minimum rate', () => {
  const fi = N.fICurve();
  const rates = fi.points.map((p) => p.rate);
  assert.ok(Math.max(...rates) > Math.min(...rates));
  assert.ok(fi.maxRate >= Math.max(...rates));
});

test('fI points expose both rate aliases and spike counts', () => {
  const fi = N.fICurve({ amplitudes: [0, 10, 20], stimDuration: 200 });
  fi.points.forEach((p) => {
    assert.equal(p.rate, p.rateHz);
    assert.ok(Number.isInteger(p.spikeCount));
    assert.ok(Number.isFinite(p.meanPeak));
  });
});

test('rheobase lies in the physiological range for the squid axon', () => {
  const r = N.findRheobase();
  assert.ok(r.rheobase > 1 && r.rheobase < 6, `rheobase ${r.rheobase}`);
  assert.equal(r.converged, true);
  assert.ok(r.lowerBound <= r.upperBound);
});

test('rheobase bisection brackets the true threshold', () => {
  const r = N.findRheobase();
  const below = N.currentClamp({
    amplitude: r.lowerBound - 0.05, stimStart: 5,
    stimDuration: r.stimDuration, postTime: 0,
  });
  const above = N.currentClamp({
    amplitude: r.upperBound + 0.05, stimStart: 5,
    stimDuration: r.stimDuration, postTime: 0,
  });
  assert.equal(below.spikes.length, 0);
  assert.ok(above.spikes.length >= 1);
});

test('rheobase is lower than the current needed for repetitive firing', () => {
  const r = N.findRheobase();
  assert.ok(r.rheobase < 8);
  const hi = N.currentClamp({ amplitude: 15, stimStart: 5, stimDuration: 60, postTime: 0 });
  assert.ok(hi.spikes.length >= 2);
});

test('rheobase evaluation count scales with the iteration budget', () => {
  const a = N.findRheobase({ iterations: 8 });
  const b = N.findRheobase({ iterations: 16 });
  assert.ok(b.evaluations.length > a.evaluations.length);
});

/* =============================================================== *
 * 10. Refractory period
 * =============================================================== */

test('paired pulse protocol reveals an absolute refractory period', () => {
  const r = N.refractoryPeriod();
  assert.ok(r.absoluteRefractoryMs >= 2, `abs ${r.absoluteRefractoryMs}`);
  assert.ok(r.absoluteRefractoryMs <= 20);
});

test('short interpulse gaps fail while long gaps succeed', () => {
  const r = N.refractoryPeriod();
  assert.equal(r.results.find((x) => x.gap === 2).fired, false);
  assert.equal(r.results.find((x) => x.gap === 20).fired, true);
});

test('second spike amplitude recovers toward the control with longer gaps', () => {
  const r = N.refractoryPeriod();
  const early = r.results.find((x) => x.gap === 10);
  const late = r.results.find((x) => x.gap === 20);
  assert.ok(early.fired);
  assert.ok(late.amplitudeRatio >= early.amplitudeRatio);
});

/* =============================================================== *
 * 11. Pharmacology: TTX and TEA
 * =============================================================== */

test('full TTX sodium block abolishes action potentials', () => {
  const tr = N.currentClamp({
    ttx: 1, amplitude: 30, stimStart: 5, stimDuration: 40, postTime: 10,
  });
  assert.equal(tr.spikes.length, 0);
});

test('full TTX block eliminates the sodium current but not the potassium current', () => {
  const tr = N.voltageClamp({ ttx: 1, vCmd: 0 });
  assert.ok(tr.analysis.peakINa === 0);
  assert.ok(tr.analysis.steadyIK > 0);
});

test('partial TTX block raises spike threshold and lowers the overshoot', () => {
  const common = { amplitude: 15, stimStart: 5, stimDuration: 30, postTime: 5 };
  const control = N.currentClamp(common);
  const blocked = N.currentClamp(Object.assign({}, common, { ttx: 0.6 }));
  assert.ok(blocked.spikes.length <= control.spikes.length);
  if (blocked.spikes.length && control.spikes.length) {
    assert.ok(blocked.spikes[0].peak < control.spikes[0].peak);
  }
});

test('full TEA potassium block broadens the action potential', () => {
  const common = { amplitude: 10, stimStart: 5, stimDuration: 20, postTime: 10 };
  const control = N.currentClamp(common);
  const blocked = N.currentClamp(Object.assign({}, common, { tea: 1 }));
  assert.ok(blocked.spikes.length > 0);
  // With potassium blocked the repolarization is so slow that the half
  // width is unmeasurable inside the record, and the AHP nearly vanishes.
  assert.equal(blocked.spikes[0].halfWidth, null);
  assert.ok(blocked.spikes[0].ahp > control.spikes[0].ahp);
});

test('full TEA block eliminates the potassium current but not the sodium current', () => {
  const tr = N.voltageClamp({ tea: 1, vCmd: 0 });
  assert.equal(tr.analysis.steadyIK, 0);
  assert.ok(tr.analysis.peakINa < 0);
});

test('combined TTX and TEA block silences spikes and sodium current', () => {
  const tr = N.currentClamp({ ttx: 1, tea: 1, amplitude: 50, stimDuration: 30 });
  assert.equal(tr.spikes.length, 0);
  const vc = N.voltageClamp({ ttx: 1, tea: 1, vCmd: 0 });
  assert.equal(vc.analysis.peakINa, 0);
  assert.equal(vc.analysis.steadyIK, 0);
});

test('blocker metadata is carried into the trace', () => {
  const tr = N.currentClamp({ ttx: 0.3, tea: 0.7, amplitude: 10 });
  assert.equal(tr.meta.ttx, 0.3);
  assert.equal(tr.meta.tea, 0.7);
  assert.equal(tr.meta.gNaEff, 84);
  near(tr.meta.gKEff, 10.8, 1e-9);
});

/* =============================================================== *
 * 12. Temperature Q10 scaling
 * =============================================================== */

test('temperature scaling changes the spiking response', () => {
  const stim = (t) => (t >= 5 && t < 55 ? 10 : 0);
  const cold = N.simulateHH({ temperature: 6.3, stimulus: stim, totalDuration: 60 });
  const warm = N.simulateHH({ temperature: 16.3, stimulus: stim, totalDuration: 60 });
  assert.notEqual(cold.spikes.length, warm.spikes.length);
});

test('temperature metadata is recorded in the trace', () => {
  const tr = N.simulateHH({ temperature: 18.3, totalDuration: 20 });
  assert.equal(tr.meta.temperature, 18.3);
  assert.ok(tr.meta.q10 > 0);
});

test('changing Q10 changes the temperature factor', () => {
  const a = N.temperatureFactor(16.3, { q10: 2 });
  const b = N.temperatureFactor(16.3, { q10: 3 });
  near(a, 2, 1e-9);
  near(b, 3, 1e-9);
});

/* =============================================================== *
 * 13. Voltage clamp
 * =============================================================== */

test('voltage clamp holds the command potential during the step', () => {
  const tr = N.voltageClamp({ vCmd: -20, vHold: -65, stepStart: 5, stepDuration: 20 });
  const at = (t) => tr.V[Math.round(t / tr.dt)];
  assert.equal(at(4), -65);
  assert.equal(at(10), -20);
  assert.equal(at(26), -65);
});

test('voltage clamp shows a transient inward sodium current', () => {
  const tr = N.voltageClamp({ vCmd: -20 });
  assert.ok(tr.analysis.peakINa < -100, `peakINa ${tr.analysis.peakINa}`);
  assert.ok(tr.analysis.peakINaTime > tr.meta.stepStart);
});

test('voltage clamp shows a sustained outward potassium current', () => {
  const tr = N.voltageClamp({ vCmd: -20 });
  assert.ok(tr.analysis.steadyIK > 100);
  assert.ok(tr.analysis.peakIK > 0);
});

test('voltage clamp produces a potassium tail current after repolarization', () => {
  const tr = N.voltageClamp({ vCmd: 0 });
  assert.ok(tr.analysis.tailIK > 0, `tail ${tr.analysis.tailIK}`);
});

test('holding current equals the total ionic current at every sample', () => {
  const tr = N.voltageClamp({ vCmd: -20, stepDuration: 10 });
  for (let k = 0; k < tr.t.length; k += 1) {
    near(tr.I[k], tr.iNa[k] + tr.iK[k] + tr.iL[k], 1e-6);
  }
});

test('voltage clamp metadata records both command levels and timing', () => {
  const tr = N.voltageClamp({ vCmd: 10, vHold: -70, stepStart: 3, stepDuration: 12 });
  assert.equal(tr.meta.vCmd, 10);
  assert.equal(tr.meta.vHold, -70);
  assert.equal(tr.meta.stepStart, 3);
  assert.equal(tr.meta.stepEnd, 15);
  assert.equal(tr.meta.mode, 'voltage clamp');
});

test('voltage clamp gate variables stay bounded', () => {
  const tr = N.voltageClamp({ vCmd: 40, stepDuration: 30 });
  ['m', 'h', 'n'].forEach((k) =>
    tr[k].forEach((x) => assert.ok(x >= 0 && x <= 1, `${k} bounded`)));
});

/* =============================================================== *
 * 14. IV family and reversal potential
 * =============================================================== */

test('familyVoltageClamp returns one trace and one IV point per command', () => {
  const fam = N.familyVoltageClamp({ voltages: [-60, -20, 20, 60] });
  assert.equal(fam.traces.length, 4);
  assert.equal(fam.iv.length, 4);
  assert.deepEqual(fam.voltages, [-60, -20, 20, 60]);
});

test('peak sodium IV curve has an inward minimum near minus twenty millivolts', () => {
  const fam = N.familyVoltageClamp();
  const inward = fam.iv.filter((p) => p.peakINa < 0);
  assert.ok(inward.length > 0);
  const strongest = inward.reduce((a, p) => p.peakINa < a.peakINa ? p : a);
  assert.ok(strongest.V >= -40 && strongest.V <= 20, `V ${strongest.V}`);
});

test('steady potassium current grows with depolarization', () => {
  const fam = N.familyVoltageClamp();
  assert.ok(fam.iv[fam.iv.length - 1].steadyIK >
    fam.iv[0].steadyIK);
});

test('sodium reversal potential is recovered near plus fifty millivolts', () => {
  const fam = N.familyVoltageClamp();
  assert.ok(fam.reversalPotential !== null);
  near(fam.reversalPotential, 50, 2);
});

test('reversalPotential returns null when the IV curve never crosses zero', () => {
  assert.equal(N.reversalPotential([
    { V: 0, peakINa: -5 }, { V: 10, peakINa: -4 },
  ]), null);
});

/* =============================================================== *
 * 15. STDP plasticity
 * =============================================================== */

test('causal pre before post pairing potentiates', () => {
  assert.ok(N.stdpDeltaW(10) > 0);
  assert.ok(N.stdpDeltaW(1) > 0);
});

test('anti-causal post before pre pairing depresses', () => {
  assert.ok(N.stdpDeltaW(-10) < 0);
  assert.ok(N.stdpDeltaW(-1) < 0);
});

test('potentiation decays exponentially with the pairing interval', () => {
  const a = N.stdpDeltaW(5);
  const b = N.stdpDeltaW(15);
  const c = N.stdpDeltaW(35);
  assert.ok(a > b && b > c);
  near(N.stdpDeltaW(20) / N.stdpDeltaW(0), Math.exp(-1), 1e-9);
});

test('depression magnitude grows as the anti-causal gap shrinks', () => {
  assert.ok(N.stdpDeltaW(-5) < N.stdpDeltaW(-25));
  assert.ok(N.stdpDeltaW(-25) < 0);
});

test('STDP window is asymmetric with stronger depression integral', () => {
  const c = N.stdpCurve({ min: -60, max: 60, step: 1 });
  const pos = c.filter((p) => p.deltaT > 0).reduce((a, p) => a + p.dw, 0);
  const neg = c.filter((p) => p.deltaT < 0).reduce((a, p) => a + p.dw, 0);
  assert.ok(Math.abs(neg) > pos * 0.9);
});

test('applySTDP adds causal potentiation to the weight', () => {
  const w = N.applySTDP(2, 10);
  assert.ok(w > 2);
  near(w, 2 + N.stdpDeltaW(10), 1e-9);
});

test('applySTDP subtracts anti-causal depression from the weight', () => {
  const w = N.applySTDP(2, -10);
  assert.ok(w < 2);
});

test('applySTDP respects the hard weight bounds', () => {
  assert.equal(N.applySTDP(N.STDP_DEFAULTS.wMax, 1), N.STDP_DEFAULTS.wMax);
  assert.equal(N.applySTDP(N.STDP_DEFAULTS.wMin, -1), N.STDP_DEFAULTS.wMin);
});

test('stdpCurve samples both sides of the window', () => {
  const c = N.stdpCurve({ min: -40, max: 40, step: 5 });
  assert.ok(c.some((p) => p.deltaT < 0 && p.dw < 0));
  assert.ok(c.some((p) => p.deltaT > 0 && p.dw > 0));
});

/* =============================================================== *
 * 16. Izhikevich cortical network
 * =============================================================== */

test('network defaults to 64 neurons with an 80/20 excitatory split', () => {
  const net = new N.CorticalNetwork();
  assert.equal(net.n, 64);
  assert.equal(net.nExcitatory, 51);
  assert.equal(net.nInhibitory, 13);
});

test('network uses all four Izhikevich phenotypes', () => {
  const net = new N.CorticalNetwork();
  ['RS', 'IB', 'FS', 'CH'].forEach((t) =>
    assert.ok(net.types.includes(t), `missing ${t}`));
});

test('network run produces spikes, a raster and an LFP signal', () => {
  const res = N.corticalNetwork({ n: 64 }).run(600);
  assert.ok(res.totalSpikes > 0);
  assert.equal(res.raster.length, res.totalSpikes);
  assert.equal(res.lfp.length, 600);
  assert.equal(res.times.length, 600);
});

test('raster entries carry a time, neuron index and phenotype', () => {
  const res = N.corticalNetwork({ n: 16 }).run(300);
  res.raster.forEach((s) => {
    assert.ok(Number.isFinite(s.t));
    assert.ok(s.neuron >= 0 && s.neuron < 16);
    assert.ok(N.IZH_TYPES[s.type]);
  });
});

test('mean firing rate is a plausible cortical value', () => {
  const res = N.corticalNetwork({ n: 64 }).run(1000);
  assert.ok(res.meanFiringRateHz > 0);
  assert.ok(res.meanFiringRateHz < 100);
});

test('inhibitory synapses carry negative weights', () => {
  const net = new N.CorticalNetwork({ n: 16 });
  for (let j = 0; j < net.n; j += 1) {
    if (net.excitatory[j]) continue;
    for (let i = 0; i < net.n; i += 1) assert.ok(net.weights[j][i] < 0);
  }
});

test('STDP enabled network changes its mean excitatory weight', () => {
  const net = new N.CorticalNetwork({ n: 32, stdp: true });
  const w0 = net.meanExcitatoryWeight();
  net.run(600);
  const w1 = net.meanExcitatoryWeight();
  assert.notEqual(w0, w1);
});

test('STDP disabled network keeps its mean excitatory weight fixed', () => {
  const net = new N.CorticalNetwork({ n: 16, stdp: false });
  const w0 = net.meanExcitatoryWeight();
  net.run(400);
  assert.equal(net.meanExcitatoryWeight(), w0);
});

test('network runs are reproducible for the same seed', () => {
  const a = N.corticalNetwork({ n: 16, seed: 1234 }).run(200);
  const b = N.corticalNetwork({ n: 16, seed: 1234 }).run(200);
  assert.equal(a.totalSpikes, b.totalSpikes);
  assert.equal(a.raster[0].t, b.raster[0].t);
});

test('network reset clears spike history and time', () => {
  const net = new N.CorticalNetwork({ n: 16 });
  net.run(200);
  net.reset();
  assert.equal(net.t, 0);
  assert.equal(net.spikeCountTotal, 0);
  net.v.forEach((v) => assert.equal(v, -65));
});

test('izhikevichStep produces finite membrane potential and recovery', () => {
  const p = N.IZH_TYPES.RS;
  const s = N.izhikevichStep(-65, -13, 10, p, 1);
  assert.ok(Number.isFinite(s.v));
  assert.ok(Number.isFinite(s.u));
});

/* =============================================================== *
 * 17. Spectral analysis
 * =============================================================== */

test('powerSpectrum recovers the frequency of a pure sinusoid', () => {
  const signal = [];
  for (let i = 0; i < 1000; i += 1) {
    signal.push(Math.sin(2 * Math.PI * 40 * i / 1000));
  }
  const sp = N.powerSpectrum(signal, 1000);
  near(sp.peakFrequency, 40, 0.5);
});

test('powerSpectrum reports correct sample rate, nfft and nyquist', () => {
  const signal = [1, 2, 3, 4, 5, 6, 7, 8];
  const sp = N.powerSpectrum(signal, 1000);
  assert.equal(sp.sampleRate, 1000);
  assert.equal(sp.nfft, 8);
  near(sp.nyquist, 500, 1e-9);
  assert.equal(sp.freq[sp.freq.length - 1], 500);
});

test('gamma band captures power of a 40 Hz oscillation', () => {
  const signal = [];
  for (let i = 0; i < 2000; i += 1) {
    signal.push(Math.sin(2 * Math.PI * 40 * i / 1000));
  }
  const sp = N.powerSpectrum(signal, 1000);
  assert.ok(sp.bandPower.gamma > sp.bandPower.delta);
  assert.ok(sp.bandPower.gamma > 0);
});

test('lfpPowerSpectrum converts a millisecond step into hertz', () => {
  const lfp = [];
  for (let i = 0; i < 500; i += 1) {
    lfp.push(Math.sin(2 * Math.PI * 20 * i / 500));
  }
  const sp = N.lfpPowerSpectrum(lfp, 2);
  assert.equal(sp.sampleRate, 500);
  near(sp.peakFrequency, 20, 1.5);
});

test('powerSpectrum handles a constant signal with zero spectral power', () => {
  const sp = N.powerSpectrum([5, 5, 5, 5, 5, 5, 5, 5], 1000);
  assert.equal(sp.peakPower, 0);
});

test('powerSpectrum handles a degenerate single sample signal', () => {
  const sp = N.powerSpectrum([7], 1000);
  assert.equal(sp.nfft, 1);
  assert.equal(sp.freq.length, 1);
});

/* =============================================================== *
 * 18. Export helpers
 * =============================================================== */

test('traceToCSV writes a header plus one row per sample', () => {
  const tr = N.simulateHH({ totalDuration: 1, dt: 0.5 });
  const csv = N.traceToCSV(tr);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 't,V,I,iNa,iK,iL,m,h,n');
  assert.equal(lines.length, tr.t.length + 1);
});

test('traceToCSV parses back to numeric fields with no NaN', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 2, stimDuration: 5 });
  const lines = N.traceToCSV(tr).trim().split('\n');
  lines.slice(1).forEach((line) => {
    line.split(',').forEach((v) => assert.ok(Number.isFinite(Number(v))));
  });
});

test('traceToCSV honors a requested column subset', () => {
  const tr = N.simulateHH({ totalDuration: 1, dt: 0.5 });
  const csv = N.traceToCSV(tr, ['t', 'V', 'm']);
  assert.equal(csv.trim().split('\n')[0], 't,V,m');
});

test('traceToJSON returns a valid structured document', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 2, stimDuration: 10 });
  const doc = JSON.parse(N.traceToJSON(tr));
  assert.equal(doc.format, 'spike-bench-trace');
  assert.equal(doc.version, '1.0.0');
  assert.equal(doc.samples.length, tr.t.length);
  assert.equal(doc.columns.length, 9);
  assert.ok(Array.isArray(doc.spikes));
});

test('traceToJSON embeds pharmacology and temperature parameters', () => {
  const tr = N.currentClamp({ ttx: 0.4, tea: 0.2, temperature: 12, amplitude: 10 });
  const doc = JSON.parse(N.traceToJSON(tr));
  near(doc.parameters.ttx, 0.4, 1e-9);
  near(doc.parameters.tea, 0.2, 1e-9);
  near(doc.parameters.temperature, 12, 1e-9);
});

test('ivToCSV and fIToCSV each write a header plus one data row per point', () => {
  const fam = N.familyVoltageClamp({ voltages: [-20, 0, 20] });
  assert.equal(N.ivToCSV(fam.iv).trim().split('\n').length, 4);
  const fi = N.fICurve({ amplitudes: [0, 5, 10], stimDuration: 100 });
  assert.equal(N.fIToCSV(fi).trim().split('\n').length, 4);
});

test('rasterToCSV and spectrumToCSV produce well formed tables', () => {
  const res = N.corticalNetwork({ n: 16 }).run(100);
  const rlines = N.rasterToCSV(res.raster).trim().split('\n');
  assert.equal(rlines[0], 'time_ms,neuron,type');
  assert.equal(rlines.length, res.raster.length + 1);
  const sp = N.lfpPowerSpectrum(res.lfp, 1);
  const slines = N.spectrumToCSV(sp).trim().split('\n');
  assert.equal(slines[0], 'frequency_Hz,power');
  assert.equal(slines.length, sp.freq.length + 1);
});

/* =============================================================== *
 * 19. Browser global and dependency free guarantee
 * =============================================================== */

test('engine attaches itself to globalThis for browser use', () => {
  assert.ok(globalThis.SpikeBench);
  assert.equal(globalThis.SpikeBench.VERSION, '1.0.0');
});

test('engine source contains no require calls outside the export guard', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'neuro.js'), 'utf8');
  const body = src.split("if (typeof module !== 'undefined'")[0];
  assert.ok(!/require\(/.test(body), 'no runtime dependencies');
});

test('engine source is free of em dashes and en dashes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'neuro.js'), 'utf8');
  assert.ok(!src.includes('—'), 'no em dash');
  assert.ok(!src.includes('–'), 'no en dash');
});

/* =============================================================== *
 * 20. Robustness: spike validation, bounds and degenerate inputs
 * =============================================================== */

test('clamp sends positive infinity to the upper bound', () => {
  assert.equal(N.clamp(Infinity, -3, 7), 7);
  assert.equal(N.clamp(-Infinity, -3, 7), -3);
  assert.equal(N.clamp(NaN, -3, 7), -3);
});

test('a fully blocked axon cannot spike no matter the drive strength', () => {
  const tr = N.currentClamp({
    ttx: 1, tea: 1, amplitude: 150, stimDuration: 20, postTime: 10,
  });
  assert.equal(tr.spikes.length, 0);
});

test('a sodium blocked axon cannot spike even with potassium intact', () => {
  const tr = N.currentClamp({
    ttx: 1, amplitude: 150, stimDuration: 20, postTime: 10,
  });
  assert.equal(tr.spikes.length, 0);
});

test('a passive plateau far above the sodium reversal is not a spike', () => {
  const tr = N.currentClamp({
    ttx: 0.99, tea: 1, amplitude: 150, stimDuration: 20, postTime: 10,
  });
  assert.equal(tr.spikes.length, 0);
});

test('rheobase reports non convergence instead of a fake answer', () => {
  const r = N.findRheobase({ ttx: 1, iterations: 6 });
  assert.equal(r.converged, false);
  assert.equal(r.rheobase, null);
});

test('rheobase still converges for a healthy membrane', () => {
  const r = N.findRheobase({ iterations: 12 });
  assert.equal(r.converged, true);
  assert.ok(r.rheobase > 0);
});

test('halfWidth stays null when the right crossing is cut off', () => {
  const tr = N.currentClamp({ amplitude: 10, stimDuration: 20 });
  const s = tr.spikes[0];
  const cut = s.peakIndex + 2;
  const short = {
    t: tr.t.slice(0, cut), V: tr.V.slice(0, cut), dt: tr.dt, meta: tr.meta,
  };
  const spikes = N.analyzeSpikes(short);
  assert.ok(spikes.length >= 1);
  assert.equal(spikes[0].halfWidth, null);
});

test('spikeStats ignores unmeasurable widths instead of producing NaN', () => {
  const stats = N.spikeStats([
    { peak: 40, thresholdV: -55, amplitude: 105, halfWidth: null, ahp: -75 },
  ], 10);
  assert.ok(Number.isFinite(stats.meanPeak));
  assert.equal(stats.meanHalfWidth, 0);
  const timeStats = N.spikeStats([7.1, 9.2], 10);
  assert.ok(Number.isFinite(timeStats.meanPeak));
});

test('refractoryPeriod sorts unsorted gaps and handles an empty list', () => {
  const r = N.refractoryPeriod({ gaps: [20, 1, 2, 3, 15, 8], postTime: 10 });
  assert.deepEqual(r.results.map((x) => x.gap), [1, 2, 3, 8, 15, 20]);
  const firing = r.results.filter((x) => x.fired).map((x) => x.gap);
  if (firing.length) assert.equal(r.absoluteRefractoryMs, Math.min(...firing));
  const empty = N.refractoryPeriod({ gaps: [] });
  assert.equal(empty.absoluteRefractoryMs, null);
  assert.equal(empty.relativeRefractoryMs, null);
  assert.equal(empty.results.length, 0);
});

test('fICurve survives a zero stimulus window and non finite amplitudes', () => {
  const fi = N.fICurve({ amplitudes: [0, 10], stimDuration: 0 });
  assert.ok(fi.points.every((p) => p.rate === 0 && p.rateHz === 0));
  assert.equal(fi.maxRate, 0);
  const mixed = N.fICurve({ amplitudes: [NaN, 5, Infinity], stimDuration: 50 });
  assert.deepEqual(mixed.points.map((p) => p.I), [5]);
});

test('powerSpectrum validates its input instead of corrupting it', () => {
  assert.throws(() => N.powerSpectrum(5, 1000), TypeError);
  assert.throws(() => N.powerSpectrum([1, NaN, 3], 1000), RangeError);
  const two = N.powerSpectrum([1, -1], 1000);
  assert.equal(two.nfft, 1);
  assert.equal(two.peakPower, 0);
});

test('fft requires a power of two and matching lengths', () => {
  assert.throws(() => N.fft([1, 0, 0], [0, 0, 0]), RangeError);
  assert.throws(() => N.fft([1, 0, 0, 0], [0, 0]), RangeError);
  const re = [1, 0, 0, 0];
  const im = [0, 0, 0, 0];
  N.fft(re, im);
  assert.ok(re.every((x) => Math.abs(x - 1) < 1e-12));
});

test('CorticalNetwork rejects degenerate construction options', () => {
  assert.throws(() => new N.CorticalNetwork({ n: 0.5 }), RangeError);
  assert.throws(() => new N.CorticalNetwork({ n: 8, dt: 0 }), RangeError);
  assert.throws(
    () => new N.CorticalNetwork({ n: 4, types: ['RS', 'XX', 'RS', 'FS'] }),
    RangeError);
  assert.throws(
    () => new N.CorticalNetwork({ n: 4, types: ['RS', 'FS'] }), RangeError);
});

test('CorticalNetwork preserves inhibitory weights under STDP', () => {
  const net = new N.CorticalNetwork({
    n: 32, seed: 7, driveFrequency: 80, driveAmplitude: 3, noiseExcitatory: 5,
  });
  net.run(3000);
  for (let j = 0; j < net.n; j += 1) {
    if (net.excitatory[j]) continue;
    for (let i = 0; i < net.n; i += 1) {
      assert.equal(net.weights[j][i], net.inhibitoryWeight);
    }
  }
});

test('CorticalNetwork run count honors zero and stays reproducible after reset', () => {
  const net = new N.CorticalNetwork({ n: 16, seed: 9, stdp: false });
  const empty = net.run(0);
  assert.equal(empty.steps, 0);
  assert.equal(empty.totalSpikes, 0);
  assert.equal(empty.meanFiringRateHz, 0);
  const a = net.run(200);
  const b = net.run(200);
  assert.deepEqual(a.raster, b.raster);
});

test('stdpDeltaW returns zero change for non finite pairings', () => {
  assert.equal(N.stdpDeltaW(NaN), 0);
  assert.equal(N.applySTDP(2, NaN), 2);
  assert.equal(N.applySTDP(2, Infinity), 2);
});

test('simulateHH rejects a non finite injected current loudly', () => {
  assert.throws(
    () => N.simulateHH({ stimulus: () => NaN, totalDuration: 5 }),
    RangeError);
  assert.throws(
    () => N.simulateHH({ stimulus: () => Infinity, totalDuration: 5 }),
    RangeError);
  const cell = new N.HodgkinHuxley();
  assert.throws(() => cell.step(NaN), RangeError);
});

test('resolveHH falls back to defaults for non finite scalars', () => {
  const hh = N.resolveHH({ temperature: NaN, vRest: NaN, eNa: NaN, cM: 0, q10: 0 });
  assert.equal(hh.temperature, 6.3);
  assert.equal(hh.vRest, -65);
  assert.equal(hh.eNa, 50);
  assert.equal(hh.cM, 1);
  assert.equal(hh.q10, 3);
  assert.equal(hh.phi, 1);
});

test('gatingDerivatives resolves raw option objects like its siblings', () => {
  const d = N.gatingDerivatives(
    -20, { m: 0.5, h: 0.5, n: 0.5 }, { temperature: 12.3 });
  assert.ok(Number.isFinite(d.dm));
  assert.ok(Number.isFinite(d.dh));
  assert.ok(Number.isFinite(d.dn));
});

test('simulateHH never samples past the requested duration', () => {
  const tr = N.simulateHH({ totalDuration: 1, dt: 0.3 });
  assert.ok(tr.t[tr.t.length - 1] <= 1 + 1e-9);
});

test('traceToJSON clamps digits and survives missing metadata', () => {
  const tr = N.simulateHH({ totalDuration: 1, dt: 0.5 });
  assert.doesNotThrow(() => N.traceToJSON(tr, { digits: -1 }));
  assert.doesNotThrow(() => N.traceToJSON(tr, { digits: 500 }));
  const bare = { t: [0, 0.5], V: [-65, -64] };
  const doc = JSON.parse(N.traceToJSON(bare));
  assert.equal(doc.format, 'spike-bench-trace');
  assert.equal(doc.samples.length, 2);
});

test('voltageClamp and class traces carry the full parameter block', () => {
  const vc = N.voltageClamp({ ttx: 0.5, temperature: 14 });
  const doc = JSON.parse(N.traceToJSON(vc));
  near(doc.parameters.ttx, 0.5, 1e-9);
  near(doc.parameters.temperature, 14, 1e-9);
  const cell = new N.HodgkinHuxley({ tea: 0.5, temperature: 11 });
  const doc2 = JSON.parse(N.traceToJSON(cell.run({ totalDuration: 2 })));
  near(doc2.parameters.tea, 0.5, 1e-9);
  near(doc2.parameters.temperature, 11, 1e-9);
});
