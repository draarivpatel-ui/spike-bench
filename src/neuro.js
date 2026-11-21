'use strict';

/*
 * spike-bench core engine
 * Computational neuroscience, patch-clamp electrophysiology and spiking circuits.
 * Pure JavaScript. No dependencies. Runs in Node and in the browser.
 *
 * Units:
 *   membrane potential  mV
 *   time                ms
 *   current density     uA / cm^2
 *   conductance density mS / cm^2
 *   capacitance         uF / cm^2
 *
 * The Hodgkin-Huxley equations use the classic 1952 squid giant axon rate
 * functions with the membrane potential expressed relative to the resting
 * level, x = V - vRest. Reversal potentials use the modern absolute scale.
 */

const VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * Constants and small helpers
 * ------------------------------------------------------------------ */

const HH_DEFAULTS = Object.freeze({
  gNa: 120,          // mS/cm^2
  gK: 36,            // mS/cm^2
  gL: 0.3,           // mS/cm^2
  eNa: 50,           // mV
  eK: -77,           // mV
  eL: -54.387,       // mV
  cM: 1,             // uF/cm^2
  vRest: -65,        // mV
  temperature: 6.3,  // degrees Celsius, classic HH reference
  tRef: 6.3,         // degrees Celsius
  q10: 3,            // temperature coefficient
  ttx: 0,            // fraction of sodium conductance blocked (0..1)
  tea: 0,            // fraction of potassium conductance blocked (0..1)
});

const IZH_TYPES = Object.freeze({
  RS: Object.freeze({ a: 0.02, b: 0.2, c: -65, d: 8, excitatory: true, label: 'regular spiking' }),
  IB: Object.freeze({ a: 0.02, b: 0.2, c: -55, d: 4, excitatory: true, label: 'intrinsically bursting' }),
  FS: Object.freeze({ a: 0.1, b: 0.2, c: -65, d: 2, excitatory: false, label: 'fast spiking' }),
  CH: Object.freeze({ a: 0.02, b: 0.2, c: -50, d: 2, excitatory: true, label: 'chattering' }),
});

const STDP_DEFAULTS = Object.freeze({
  aPlus: 0.01,       // potentiation amplitude
  aMinus: 0.0105,    // depression amplitude
  tauPlus: 20,       // ms
  tauMinus: 20,      // ms
  wMin: 0,
  wMax: 6,
  window: 40,        // ms, spike pairing horizon
});

const FREQ_BANDS = Object.freeze({
  delta: [1, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta: [13, 30],
  gamma: [30, 100],
});

function clamp(x, lo, hi) {
  if (typeof x !== 'number' || Number.isNaN(x)) return lo;
  return x < lo ? lo : (x > hi ? hi : x);
}

function asHH(o) {
  if (o && typeof o === 'object' &&
      Number.isFinite(o.phi) && Number.isFinite(o.gNaEff) &&
      Number.isFinite(o.gKEff) && Number.isFinite(o.gL) &&
      Number.isFinite(o.eNa) && Number.isFinite(o.eK) &&
      Number.isFinite(o.eL) && Number.isFinite(o.cM) &&
      Number.isFinite(o.vRest)) return o;
  return resolveHH(o || {});
}

function temperatureFactor(temperature, o) {
  const q10 = (o && Number.isFinite(o.q10)) ? o.q10 : HH_DEFAULTS.q10;
  const tRef = (o && Number.isFinite(o.tRef)) ? o.tRef : HH_DEFAULTS.tRef;
  return Math.pow(q10, (temperature - tRef) / 10);
}

function resolveHH(options = {}) {
  const o = Object.assign({}, HH_DEFAULTS, options);
  o.gNa = Math.max(0, Number(o.gNa) || 0);
  o.gK = Math.max(0, Number(o.gK) || 0);
  o.gL = Math.max(0, Number(o.gL) || 0);
  const cM = Number(o.cM);
  o.cM = Number.isFinite(cM) && cM > 0 ? Math.max(1e-6, cM) : HH_DEFAULTS.cM;
  const q10 = Number(o.q10);
  o.q10 = Number.isFinite(q10) && q10 > 0 ? q10 : HH_DEFAULTS.q10;
  o.temperature = Number.isFinite(o.temperature)
    ? o.temperature : HH_DEFAULTS.temperature;
  o.tRef = Number.isFinite(o.tRef) ? o.tRef : HH_DEFAULTS.tRef;
  o.vRest = Number.isFinite(o.vRest) ? o.vRest : HH_DEFAULTS.vRest;
  o.eNa = Number.isFinite(o.eNa) ? o.eNa : HH_DEFAULTS.eNa;
  o.eK = Number.isFinite(o.eK) ? o.eK : HH_DEFAULTS.eK;
  o.eL = Number.isFinite(o.eL) ? o.eL : HH_DEFAULTS.eL;
  o.ttx = clamp(Number(o.ttx) || 0, 0, 1);
  o.tea = clamp(Number(o.tea) || 0, 0, 1);
  o.phi = temperatureFactor(o.temperature, o);
  o.gNaEff = o.gNa * (1 - o.ttx);
  o.gKEff = o.gK * (1 - o.tea);
  return o;
}

/* Deterministic pseudo random generator, keeps every run reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ *
 * Hodgkin-Huxley rate functions, gating, currents, RK4
 * ------------------------------------------------------------------ */

/**
 * Classic HH voltage dependent transition rates at membrane potential V (mV).
 * Returns alpha and beta for m, h and n gates, all in 1/ms before Q10 scaling.
 */
function rateFunctions(V, options = {}) {
  const hh = asHH(options);
  if (!Number.isFinite(V)) {
    throw new RangeError('rateFunctions: membrane potential must be finite');
  }
  const x = V - hh.vRest;                    // depolarization from rest
  const un = (10 - x) / 10;
  const um = (25 - x) / 10;

  // 0.01*(10-x)/(exp((10-x)/10)-1) == 0.1*un/expm1(un)
  // 0.1*(25-x)/(exp((25-x)/10)-1)  == um/expm1(um)
  // The removable singularities at un=0 and um=0 use a Taylor series.
  const series = (u) => 1 - u / 2 + (u * u) / 12;
  const alphaN = 0.1 * (Math.abs(un) < 1e-7 ? series(un) : un / Math.expm1(un));
  const alphaM = (Math.abs(um) < 1e-7 ? series(um) : um / Math.expm1(um));

  const betaN = 0.125 * Math.exp(-x / 80);
  const betaM = 4 * Math.exp(-x / 18);
  const alphaH = 0.07 * Math.exp(-x / 20);
  const betaH = 1 / (Math.exp((30 - x) / 10) + 1);

  return { alphaM, betaM, alphaH, betaH, alphaN, betaN };
}

/** Steady state gate values and voltage dependent time constants. */
function steadyStateGates(V, options = {}) {
  const hh = asHH(options);
  const r = rateFunctions(V, hh);
  const mInf = r.alphaM / (r.alphaM + r.betaM);
  const hInf = r.alphaH / (r.alphaH + r.betaH);
  const nInf = r.alphaN / (r.alphaN + r.betaN);
  const phi = hh.phi;
  return {
    m: mInf, h: hInf, n: nInf,
    mInf, hInf, nInf,
    tauM: 1 / (phi * (r.alphaM + r.betaM)),
    tauH: 1 / (phi * (r.alphaH + r.betaH)),
    tauN: 1 / (phi * (r.alphaN + r.betaN)),
    rates: r,
  };
}

/** Ionic currents for a given potential and gate state. */
function hhCurrents(V, gates, options = {}) {
  const hh = asHH(options);
  const m = clamp(Number(gates.m) || 0, 0, 1);
  const h = clamp(Number(gates.h) || 0, 0, 1);
  const n = clamp(Number(gates.n) || 0, 0, 1);
  // A zero conductance gives literal zero even when V is below reversal,
  // avoiding a signed negative zero in exported data.
  const iNa = hh.gNaEff === 0 ? 0
    : hh.gNaEff * m * m * m * h * (V - hh.eNa);
  const iK = hh.gKEff === 0 ? 0
    : hh.gKEff * n * n * n * n * (V - hh.eK);
  const iL = hh.gL * (V - hh.eL);
  return {
    iNa, iK, iL,
    iIonic: iNa + iK + iL,
    gNaEff: hh.gNaEff,
    gKEff: hh.gKEff,
  };
}

function gatingDerivatives(V, gates, options) {
  const hh = asHH(options || {});
  const r = rateFunctions(V, hh);
  const dm = hh.phi * (r.alphaM * (1 - gates.m) - r.betaM * gates.m);
  const dh = hh.phi * (r.alphaH * (1 - gates.h) - r.betaH * gates.h);
  const dn = hh.phi * (r.alphaN * (1 - gates.n) - r.betaN * gates.n);
  return { dm, dh, dn };
}

/** Full state derivative for current clamp. */
function hhDerivatives(state, I, options = {}) {
  const hh = asHH(options);
  const cur = hhCurrents(state.V, state, hh);
  const g = gatingDerivatives(state.V, state, hh);
  return {
    V: (I - cur.iIonic) / hh.cM,
    m: g.dm, h: g.dh, n: g.dn,
  };
}

function advanceState(s, d, h) {
  return {
    V: s.V + h * d.V,
    m: s.m + h * d.m,
    h: s.h + h * d.h,
    n: s.n + h * d.n,
  };
}

function cleanState(s) {
  return {
    V: s.V,
    m: clamp(s.m, 0, 1),
    h: clamp(s.h, 0, 1),
    n: clamp(s.n, 0, 1),
  };
}

/**
 * One classical fourth order Runge-Kutta step of the free membrane.
 * I may be a number or a function of the offset inside the step, which keeps
 * stimulus waveforms accurate to fourth order as well.
 */
function rk4Step(state, I, dt, options = {}) {
  const hh = asHH(options);
  const iAt = (off) => {
    const v = typeof I === 'function' ? I(off) : I;
    if (!Number.isFinite(v)) {
      throw new RangeError('rk4Step: injected current is not finite');
    }
    return v;
  };
  const k1 = hhDerivatives(state, iAt(0), hh);
  const k2 = hhDerivatives(advanceState(state, k1, dt / 2), iAt(dt / 2), hh);
  const k3 = hhDerivatives(advanceState(state, k2, dt / 2), iAt(dt / 2), hh);
  const k4 = hhDerivatives(advanceState(state, k3, dt), iAt(dt), hh);
  const sixth = dt / 6;
  return cleanState({
    V: state.V + sixth * (k1.V + 2 * k2.V + 2 * k3.V + k4.V),
    m: state.m + sixth * (k1.m + 2 * k2.m + 2 * k3.m + k4.m),
    h: state.h + sixth * (k1.h + 2 * k2.h + 2 * k3.h + k4.h),
    n: state.n + sixth * (k1.n + 2 * k2.n + 2 * k3.n + k4.n),
  });
}

/** RK4 of the gates while the command potential is imposed by a clamp. */
function rk4ClampStep(state, vAt, dt, hh) {
  const stage = (s, off) => {
    const g = gatingDerivatives(vAt(off), s, hh);
    return { V: 0, m: g.dm, h: g.dh, n: g.dn };
  };
  const k1 = stage(state, 0);
  const k2 = stage(advanceState(state, k1, dt / 2), dt / 2);
  const k3 = stage(advanceState(state, k2, dt / 2), dt / 2);
  const k4 = stage(advanceState(state, k3, dt), dt);
  const sixth = dt / 6;
  return cleanState({
    V: vAt(dt),
    m: state.m + sixth * (k1.m + 2 * k2.m + 2 * k3.m + k4.m),
    h: state.h + sixth * (k1.h + 2 * k2.h + 2 * k3.h + k4.h),
    n: state.n + sixth * (k1.n + 2 * k2.n + 2 * k3.n + k4.n),
  });
}

/* ------------------------------------------------------------------ *
 * Traces and spike analysis
 * ------------------------------------------------------------------ */

function newTrace(dt, meta) {
  return {
    t: [], V: [], I: [], iNa: [], iK: [], iL: [], m: [], h: [], n: [],
    dt, meta, spikes: [],
  };
}

function pushSample(tr, t, V, I, cur, state) {
  tr.t.push(t);
  tr.V.push(V);
  tr.I.push(I);
  tr.iNa.push(cur.iNa);
  tr.iK.push(cur.iK);
  tr.iL.push(cur.iL);
  tr.m.push(state.m);
  tr.h.push(state.h);
  tr.n.push(state.n);
}

/** Step waveform generator, I(t) in uA/cm^2. */
function makeStep(amplitude, start, duration) {
  return (t) => (t >= start && t < start + duration ? amplitude : 0);
}

/** Linear ramp waveform generator, ramps from 0 to amplitude. */
function makeRamp(amplitude, start, duration) {
  return (t) => {
    if (t < start || t >= start + duration) return 0;
    return amplitude * (t - start) / duration;
  };
}

function interpCross(t1, v1, t2, v2, level) {
  if (v2 === v1) return t1;
  return t1 + (level - v1) * (t2 - t1) / (v2 - v1);
}

/** Locate action potentials and measure their shape. */
function analyzeSpikes(trace, options = {}) {
  const threshold = options.threshold === undefined ? 0 : options.threshold; // mV
  const dvThreshold = options.dvThreshold === undefined ? 12 : options.dvThreshold; // mV/ms
  // A real action potential is regenerative: its upstroke exceeds this slope.
  // A purely passive RC charging transient never reaches it, so full channel
  // blockade is correctly reported as "no spikes" even at huge currents.
  const minUpstroke = options.minUpstroke === undefined
    ? 100 : options.minUpstroke; // mV/ms
  const meta = trace.meta || {};
  const gNaEff = Number.isFinite(meta.gNaEff) ? meta.gNaEff
    : (meta.hh && Number.isFinite(meta.hh.gNaEff) ? meta.hh.gNaEff : null);
  const eNa = meta.hh && Number.isFinite(meta.hh.eNa) ? meta.hh.eNa : 60;
  // A regenerative peak cannot overshoot the sodium reversal by much; a
  // passive RC plateau driven far above it is not a spike.
  const maxPeak = Number.isFinite(options.maxPeak)
    ? options.maxPeak : eNa + 20;
  const vRest = Number.isFinite(meta.vRest) ? meta.vRest : HH_DEFAULTS.vRest;
  const V = trace.V;
  const t = trace.t;
  const dt = trace.dt;
  const spikes = [];
  // With sodium fully blocked there is no regenerative mechanism at all:
  // every threshold crossing is passive charging, never an action potential.
  if (gNaEff === 0) return spikes;
  let i = 1;
  while (i < V.length) {
    if (!(V[i - 1] <= threshold && V[i] > threshold)) { i += 1; continue; }

    let peakIdx = i;
    while (peakIdx + 1 < V.length && V[peakIdx + 1] > V[peakIdx]) peakIdx += 1;
    let endIdx = peakIdx;
    while (endIdx + 1 < V.length && V[endIdx] > threshold) endIdx += 1;

    // Reject slow non regenerative depolarizations, such as the passive RC
    // charging seen when both sodium and potassium channels are blocked.
    let maxUpstroke = 0;
    for (let k = i; k <= peakIdx; k += 1) {
      const dv = (V[k] - V[k - 1]) / dt;
      if (dv > maxUpstroke) maxUpstroke = dv;
    }
    if (maxUpstroke < minUpstroke) {
      i = Math.max(endIdx + 1, peakIdx + 1);
      continue;
    }

    // A passive plateau held by sustained current can still charge fast
    // enough to pass the slope test: reject it by peak plausibility.
    if (V[peakIdx] > maxPeak) {
      i = Math.max(endIdx + 1, peakIdx + 1);
      continue;
    }

    // Foot of the upstroke. Find the steepest rising segment, then walk back
    // from it until the slope falls below dvThreshold. The peak itself has a
    // near zero slope, so searching from the peak directly is incorrect.
    let maxSlopeIdx = i;
    let maxSlope = -Infinity;
    for (let k = i; k <= peakIdx; k += 1) {
      const dv = (V[k] - V[k - 1]) / dt;
      if (dv > maxSlope) { maxSlope = dv; maxSlopeIdx = k; }
    }
    let threshIdx = maxSlopeIdx;
    for (let k = maxSlopeIdx; k > 1; k -= 1) {
      const dv = (V[k] - V[k - 1]) / dt;
      if (dv < dvThreshold) break;
      threshIdx = k - 1;
    }

    // Afterhyperpolarization within 20 ms after the peak.
    const ahpEnd = Math.min(V.length - 1, peakIdx + Math.round(20 / dt));
    let ahp = V[peakIdx];
    let ahpIdx = peakIdx;
    for (let k = peakIdx; k <= ahpEnd; k += 1) {
      if (V[k] < ahp) { ahp = V[k]; ahpIdx = k; }
    }

    // Width at half maximal depolarization.
    const half = vRest + (V[peakIdx] - vRest) / 2;
    let left = null;
    let right = null;
    for (let k = peakIdx; k > 0; k -= 1) {
      if (V[k] >= half && V[k - 1] < half) {
        left = interpCross(t[k - 1], V[k - 1], t[k], V[k], half);
        break;
      }
    }
    for (let k = peakIdx; k + 1 < V.length; k += 1) {
      if (V[k] >= half && V[k + 1] < half) {
        right = interpCross(t[k], V[k], t[k + 1], V[k + 1], half);
        break;
      }
    }

    spikes.push({
      index: spikes.length,
      time: t[peakIdx],
      peakIndex: peakIdx,
      peak: V[peakIdx],
      overshoot: V[peakIdx],
      amplitude: V[peakIdx] - vRest,
      thresholdV: V[threshIdx],
      thresholdTime: t[threshIdx],
      ahp,
      ahpTime: t[ahpIdx],
      halfWidth: (left !== null && right !== null) ? right - left : null,
    });
    i = Math.max(endIdx + 1, peakIdx + 1);
  }
  return spikes;
}

function detectSpikes(trace, options = {}) {
  return analyzeSpikes(trace, options).map((s) => s.time);
}

function countSpikes(trace, options = {}) {
  return analyzeSpikes(trace, options).length;
}

function spikeStats(spikes, durationMs) {
  const n = spikes.length;
  const mean = (key) => {
    const vals = [];
    for (const s of spikes) {
      const v = s && s[key];
      if (Number.isFinite(v)) vals.push(v);
    }
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  return {
    count: n,
    meanRateHz: durationMs > 0 ? (n * 1000) / durationMs : 0,
    meanPeak: mean('peak'),
    meanThresholdV: mean('thresholdV'),
    meanAmplitude: mean('amplitude'),
    meanHalfWidth: mean('halfWidth'),
    meanAHP: mean('ahp'),
  };
}

/* ------------------------------------------------------------------ *
 * Current clamp simulation
 * ------------------------------------------------------------------ */

/** Wrap a stimulus so a non finite current fails loudly instead of NaN-ing the trace. */
function finiteStimulus(stimulus) {
  return (t) => {
    const v = stimulus(t);
    if (!Number.isFinite(v)) {
      throw new RangeError('injected current is not finite at t=' + t);
    }
    return v;
  };
}

/** Integrate the free membrane with an arbitrary injected current waveform. */
function simulateHH(options = {}) {
  const hh = resolveHH(options);
  const dt = Number(options.dt) > 0 ? Number(options.dt) : 0.01;
  const totalDuration = Number(options.totalDuration) > 0
    ? Number(options.totalDuration) : 50;
  const stimulus = typeof options.stimulus === 'function'
    ? options.stimulus : () => 0;
  const stim = finiteStimulus(stimulus);
  const initialV = Number.isFinite(options.initialV) ? options.initialV : hh.vRest;
  const gateState = options.steadyState === false
    ? { m: 0.05, h: 0.6, n: 0.32 }
    : steadyStateGates(initialV, hh);
  let state = cleanState({
    V: initialV,
    m: gateState.m, h: gateState.h, n: gateState.n,
  });

  const steps = Math.max(0, Math.floor(totalDuration / dt + 1e-9));
  const tr = newTrace(dt, {
    vRest: hh.vRest,
    hh,
    mode: options.mode || 'free run',
    totalDuration,
    temperature: hh.temperature,
    q10: hh.q10,
    ttx: hh.ttx,
    tea: hh.tea,
    gNaEff: hh.gNaEff,
    gKEff: hh.gKEff,
  });

  for (let k = 0; k <= steps; k += 1) {
    const t = k * dt;
    const I = stim(t);
    const cur = hhCurrents(state.V, state, hh);
    pushSample(tr, t, state.V, I, cur, state);
    if (k < steps) {
      state = rk4Step(state, (off) => stim(t + off), dt, hh);
      if (!Number.isFinite(state.V)) {
        throw new RangeError('simulation diverged: membrane potential is not finite');
      }
    }
  }
  tr.spikes = analyzeSpikes(tr);
  tr.stats = spikeStats(tr.spikes, totalDuration);
  return tr;
}

/** Object oriented wrapper around the same RK4 solver. */
class HodgkinHuxley {
  constructor(options = {}) {
    this.hh = resolveHH(options);
    this.dt = Number(options.dt) > 0 ? Number(options.dt) : 0.01;
    this.t = 0;
    this.reset(options.initialV);
  }

  reset(V) {
    const v = Number.isFinite(V) ? V : this.hh.vRest;
    const g = steadyStateGates(v, this.hh);
    this.state = cleanState({ V: v, m: g.m, h: g.h, n: g.n });
    this.t = 0;
    return this.state;
  }

  step(I, dt) {
    const h = Number(dt) > 0 ? Number(dt) : this.dt;
    this.state = rk4Step(this.state, I, h, this.hh);
    if (!Number.isFinite(this.state.V)) {
      throw new RangeError('simulation diverged: membrane potential is not finite');
    }
    this.t += h;
    return this.state;
  }

  currents() {
    return hhCurrents(this.state.V, this.state, this.hh);
  }

  run(options = {}) {
    const dt = Number(options.dt) > 0 ? Number(options.dt) : this.dt;
    const totalDuration = Number(options.totalDuration) > 0
      ? Number(options.totalDuration) : 50;
    const stimulus = typeof options.stimulus === 'function'
      ? options.stimulus : () => 0;
    const stim = finiteStimulus(stimulus);
    if (options.reset !== false) this.reset(options.initialV);
    const steps = Math.max(0, Math.floor(totalDuration / dt + 1e-9));
    const tr = newTrace(dt, {
      vRest: this.hh.vRest, hh: this.hh, mode: options.mode || 'free run',
      totalDuration,
      temperature: this.hh.temperature, q10: this.hh.q10,
      ttx: this.hh.ttx, tea: this.hh.tea,
      gNaEff: this.hh.gNaEff, gKEff: this.hh.gKEff,
    });
    for (let k = 0; k <= steps; k += 1) {
      const t = k * dt;
      const cur = hhCurrents(this.state.V, this.state, this.hh);
      pushSample(tr, t, this.state.V, stim(t), cur, this.state);
      if (k < steps) this.step((off) => stim(t + off), dt);
    }
    tr.spikes = analyzeSpikes(tr);
    tr.stats = spikeStats(tr.spikes, totalDuration);
    return tr;
  }
}

/** Current clamp step or ramp protocol. */
function currentClamp(options = {}) {
  const amplitude = Number.isFinite(options.amplitude) ? options.amplitude : 10;
  const stimStart = Number.isFinite(options.stimStart) ? options.stimStart : 5;
  const stimDuration = Number.isFinite(options.stimDuration)
    ? options.stimDuration : 20;
  const postTime = Number.isFinite(options.postTime) ? options.postTime : 10;
  const kind = options.stimulusType || 'step';
  const rampFrom = Number.isFinite(options.rampFrom) ? options.rampFrom : 0;
  let stimulus;
  if (typeof options.stimulus === 'function') {
    stimulus = options.stimulus;
  } else if (kind === 'ramp') {
    stimulus = (t) => {
      if (t < stimStart || t >= stimStart + stimDuration) return 0;
      return rampFrom + (amplitude - rampFrom) * (t - stimStart) / stimDuration;
    };
  } else {
    stimulus = makeStep(amplitude, stimStart, stimDuration);
  }
  const tr = simulateHH(Object.assign({}, options, {
    stimulus,
    mode: 'current clamp ' + kind,
    totalDuration: stimStart + stimDuration + postTime,
  }));
  tr.meta.amplitude = amplitude;
  tr.meta.stimStart = stimStart;
  tr.meta.stimDuration = stimDuration;
  tr.meta.postTime = postTime;
  tr.meta.stimulusType = kind;
  return tr;
}

/** Firing rate versus injected current (the f-I curve). */
function fICurve(options = {}) {
  const amplitudes = (Array.isArray(options.amplitudes)
    ? options.amplitudes : [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    .filter((I) => Number.isFinite(I));
  const stimStart = Number.isFinite(options.stimStart) ? options.stimStart : 5;
  const stimDuration = Number.isFinite(options.stimDuration)
    ? options.stimDuration : 500;
  const returnTraces = options.returnTraces === true;
  const points = amplitudes.map((I) => {
    const tr = currentClamp(Object.assign({}, options, {
      amplitude: I,
      stimStart,
      stimDuration,
      postTime: 0,
      stimulusType: 'step',
    }));
    const spikes = tr.spikes.filter((s) =>
      s.time >= stimStart && s.time <= stimStart + stimDuration);
    const point = {
      I,
      amplitude: I,
      rateHz: stimDuration > 0 ? (spikes.length * 1000) / stimDuration : 0,
      rate: stimDuration > 0 ? (spikes.length * 1000) / stimDuration : 0,
      spikeCount: spikes.length,
      spikes,
      meanPeak: spikes.length
        ? spikes.reduce((a, s) => a + s.peak, 0) / spikes.length : 0,
    };
    if (returnTraces) point.trace = tr;
    return point;
  });
  return {
    points,
    stimDuration,
    monotonic: points.every((p, k) => k === 0 || p.rate >= points[k - 1].rate - 1e-9),
    maxRate: points.reduce((a, p) => Math.max(a, p.rate), 0),
  };
}

/** Bisection search for the smallest sustained current that fires a spike. */
function findRheobase(options = {}) {
  const stimStart = Number.isFinite(options.stimStart) ? options.stimStart : 5;
  const stimDuration = Number.isFinite(options.stimDuration)
    ? options.stimDuration : 60;
  const iterations = Number.isFinite(options.iterations)
    ? Math.max(1, Math.floor(options.iterations)) : 20;
  const evaluations = [];

  const fires = (I) => {
    const tr = currentClamp(Object.assign({}, options, {
      amplitude: I, stimStart, stimDuration, postTime: 0, stimulusType: 'step',
    }));
    const n = tr.spikes.length;
    evaluations.push({ I, spikes: n });
    return n > 0;
  };

  let lo = Number.isFinite(options.min) ? options.min : 0;
  let hi = Number.isFinite(options.max) ? options.max : 20;
  let guard = 0;
  while (!fires(hi) && guard < 6) { hi *= 2; guard += 1; }
  if (fires(lo)) lo = 0;
  const converged = evaluations.some((e) => e.spikes > 0);
  if (!converged) {
    return {
      rheobase: null,
      lowerBound: lo,
      upperBound: hi,
      converged: false,
      iterations: 0,
      evaluations,
      stimDuration,
    };
  }
  for (let k = 0; k < iterations; k += 1) {
    const mid = (lo + hi) / 2;
    if (fires(mid)) hi = mid; else lo = mid;
  }
  return {
    rheobase: hi,
    lowerBound: lo,
    upperBound: hi,
    converged: true,
    iterations,
    evaluations,
    stimDuration,
  };
}

/** Paired pulse estimate of the absolute and relative refractory periods. */
function refractoryPeriod(options = {}) {
  const dt = Number(options.dt) > 0 ? Number(options.dt) : 0.01;
  const pulseAmplitude = Number.isFinite(options.pulseAmplitude)
    ? options.pulseAmplitude : 20;
  const pulseDuration = Number.isFinite(options.pulseDuration)
    ? options.pulseDuration : 1;
  const stimStart = Number.isFinite(options.stimStart) ? options.stimStart : 5;
  const postTime = Number.isFinite(options.postTime) ? options.postTime : 20;
  const gaps = (Array.isArray(options.gaps) ? options.gaps : (() => {
    const out = [];
    for (let g = 1; g <= 20; g += 1) out.push(g);
    return out;
  })()).filter((g) => Number.isFinite(g) && g >= 0).sort((a, b) => a - b);

  const runPair = (gap) => {
    const secondStart = stimStart + pulseDuration + gap;
    const stimulus = (t) => {
      if (t >= stimStart && t < stimStart + pulseDuration) return pulseAmplitude;
      if (t >= secondStart && t < secondStart + pulseDuration) return pulseAmplitude;
      return 0;
    };
    const tr = simulateHH(Object.assign({}, options, {
      dt, stimulus, mode: 'paired pulse refractory',
      totalDuration: secondStart + pulseDuration + postTime,
    }));
    return { tr, secondStart };
  };

  const control = runPair(1000);
  const controlSpikes = control.tr.spikes.filter((s) => s.time < 50);
  const controlPeak = controlSpikes.length ? controlSpikes[0].peak : 40;
  const controlThreshold = controlSpikes.length ? controlSpikes[0].thresholdV : -55;
  // A genuine second action potential must regenerate a large overshoot.
  // Subthreshold damped oscillations and the late AHP rebound are rejected.
  const secondPeakFloor = controlThreshold + 20;

  const results = gaps.map((gap) => {
    const { tr, secondStart } = runPair(gap);
    const valid = tr.spikes.filter((s) =>
      s.time >= secondStart && s.peak >= secondPeakFloor);
    const second = valid.length ? valid[0] : null;
    const denom = controlPeak - tr.meta.vRest;
    const ratio = second && denom > 0
      ? (second.peak - tr.meta.vRest) / denom : 0;
    return {
      gap,
      fired: !!second,
      peak: second ? second.peak : null,
      amplitudeRatio: second ? ratio : 0,
      thresholdV: second ? second.thresholdV : null,
      spikeCount: tr.spikes.length,
    };
  });

  const firstFiring = results.find((r) => r.fired);
  const recovered = results.find((r) => r.fired && r.amplitudeRatio >= 0.95);
  const maxGap = gaps.length ? gaps[gaps.length - 1] : null;
  return {
    absoluteRefractoryMs: firstFiring ? firstFiring.gap : maxGap,
    relativeRefractoryMs: recovered ? recovered.gap : maxGap,
    controlPeak,
    controlThreshold,
    gaps,
    results,
  };
}

/* ------------------------------------------------------------------ *
 * Voltage clamp protocol studio
 * ------------------------------------------------------------------ */

/** Integrate the gates while the soma is held at an imposed command potential. */
function voltageClamp(options = {}) {
  const hh = resolveHH(options);
  const dt = Number(options.dt) > 0 ? Number(options.dt) : 0.01;
  const vHold = Number.isFinite(options.vHold) ? options.vHold : hh.vRest;
  const vCmd = Number.isFinite(options.vCmd) ? options.vCmd : -20;
  const stepStart = Number.isFinite(options.stepStart) ? options.stepStart : 5;
  const stepDuration = Number.isFinite(options.stepDuration)
    ? options.stepDuration : 20;
  const postTime = Number.isFinite(options.postTime) ? options.postTime : 10;
  const stepEnd = stepStart + stepDuration;
  const totalDuration = stepEnd + postTime;
  const vCmdAt = (t) =>
    (t >= stepStart && t < stepEnd) ? vCmd : vHold;

  const g = steadyStateGates(vHold, hh);
  let state = cleanState({ V: vHold, m: g.m, h: g.h, n: g.n });
  const tr = newTrace(dt, {
    vRest: hh.vRest, hh, mode: 'voltage clamp', vHold, vCmd,
    stepStart, stepEnd, stepDuration, postTime, totalDuration,
    temperature: hh.temperature, q10: hh.q10,
    ttx: hh.ttx, tea: hh.tea,
    gNaEff: hh.gNaEff, gKEff: hh.gKEff,
  });
  const steps = Math.max(0, Math.floor(totalDuration / dt + 1e-9));
  for (let k = 0; k <= steps; k += 1) {
    const t = k * dt;
    const V = vCmdAt(t);
    const cur = hhCurrents(V, state, hh);
    // Holding current is the injected current needed to keep V at command.
    const holdingCurrent = cur.iIonic;
    pushSample(tr, t, V, holdingCurrent, cur, state);
    if (k < steps) state = rk4ClampStep(state, (off) => vCmdAt(t + off), dt, hh);
  }
  tr.analysis = analyzeVoltageClamp(tr);
  return tr;
}

/** Extract inward sodium, outward potassium and tail currents from a clamp. */
function analyzeVoltageClamp(trace) {
  const { stepStart, stepEnd } = trace.meta;
  const dt = trace.dt;
  const t = trace.t;
  const iNa = trace.iNa;
  const iK = trace.iK;
  let peakINa = Infinity;
  let peakINaTime = 0;
  let steadyIK = 0;
  let peakIK = -Infinity;
  let tailIK = 0;
  let tailINa = 0;
  let tailWindowEnd = stepEnd + 5;
  for (let k = 0; k < t.length; k += 1) {
    if (t[k] >= stepStart && t[k] < stepEnd) {
      if (iNa[k] < peakINa) { peakINa = iNa[k]; peakINaTime = t[k]; }
      if (iK[k] > peakIK) peakIK = iK[k];
      steadyIK = iK[k];
    }
    if (t[k] >= stepEnd && t[k] <= tailWindowEnd) {
      if (iK[k] > tailIK) tailIK = iK[k];
      if (iNa[k] < tailINa) tailINa = iNa[k];
    }
  }
  if (!Number.isFinite(peakINa)) peakINa = 0;
  if (!Number.isFinite(peakIK)) peakIK = 0;
  return {
    vCmd: trace.meta.vCmd,
    vHold: trace.meta.vHold,
    peakINa,
    peakINaTime,
    steadyIK,
    peakIK,
    tailIK,
    tailINa,
    tailWindowEnd,
    dt,
  };
}

/** A family of command steps, giving the current versus voltage relation. */
function familyVoltageClamp(options = {}) {
  const voltages = Array.isArray(options.voltages) ? options.voltages
    : [-80, -60, -40, -20, 0, 20, 40, 50, 60];
  const traces = voltages.map((vCmd) =>
    voltageClamp(Object.assign({}, options, { vCmd })));
  const iv = traces.map((tr) => Object.assign({ V: tr.meta.vCmd }, tr.analysis));
  return { traces, iv, voltages, reversalPotential: reversalPotential(iv) };
}

/** Sodium reversal read from the zero crossing of the peak I_Na IV curve. */
function reversalPotential(iv) {
  for (let k = 1; k < iv.length; k += 1) {
    const a = iv[k - 1];
    const b = iv[k];
    if (a.peakINa < 0 && b.peakINa >= 0) {
      const f = -a.peakINa / (b.peakINa - a.peakINa);
      return a.V + f * (b.V - a.V);
    }
    if (a.peakINa > 0 && b.peakINa <= 0) {
      const f = a.peakINa / (a.peakINa - b.peakINa);
      return a.V + f * (b.V - a.V);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Spike timing dependent plasticity
 * ------------------------------------------------------------------ */

/**
 * The classic asymmetric STDP learning window.
 * deltaT = t_post - t_pre, in ms.
 * Causal pairings (deltaT > 0) potentiate; anti-causal pairings depress.
 */
function stdpDeltaW(deltaT, options = {}) {
  const o = Object.assign({}, STDP_DEFAULTS, options);
  if (!Number.isFinite(deltaT)) return 0;
  if (deltaT > 0) return o.aPlus * Math.exp(-deltaT / o.tauPlus);
  if (deltaT < 0) return -o.aMinus * Math.exp(deltaT / o.tauMinus);
  return o.aPlus;
}

/** Apply one pairing to a synaptic weight, respecting hard bounds. */
function applySTDP(weight, deltaT, options = {}) {
  const o = Object.assign({}, STDP_DEFAULTS, options);
  return clamp(weight + stdpDeltaW(deltaT, o), o.wMin, o.wMax);
}

/** Sample the full biphasic learning window. */
function stdpCurve(options = {}) {
  const min = Number.isFinite(options.min) ? options.min : -60;
  const max = Number.isFinite(options.max) ? options.max : 60;
  const step = Number(options.step) > 0 ? Number(options.step) : 1;
  const points = [];
  for (let dt = min; dt <= max + 1e-9; dt += step) {
    points.push({ deltaT: dt, dw: stdpDeltaW(dt, options) });
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * Izhikevich cortical spiking network
 * ------------------------------------------------------------------ */

function defaultComposition(n) {
  const nExcitatory = Math.round(0.8 * n);
  const types = [];
  for (let i = 0; i < n; i += 1) {
    if (i >= nExcitatory) types.push('FS');
    else if (i % 5 === 0) types.push('IB');
    else if (i % 7 === 0) types.push('CH');
    else types.push('RS');
  }
  return types;
}

/** One Izhikevich point neuron integrated with two half millisecond steps. */
function izhikevichStep(v, u, I, p, dt) {
  const half = dt / 2;
  for (let k = 0; k < 2; k += 1) {
    v += half * (0.04 * v * v + 5 * v + 140 - u + I);
    u += half * (p.a * (p.b * v - u));
  }
  return { v, u };
}

class CorticalNetwork {
  constructor(options = {}) {
    const nOpt = options.n === undefined ? 64 : Number(options.n);
    if (!Number.isInteger(nOpt) || nOpt < 1) {
      throw new RangeError('CorticalNetwork: n must be a positive integer');
    }
    const n = nOpt;
    const dtOpt = options.dt === undefined ? 1 : Number(options.dt);
    if (!Number.isFinite(dtOpt) || dtOpt <= 0) {
      throw new RangeError('CorticalNetwork: dt must be a positive finite step in ms');
    }
    this.n = n;
    this.dt = dtOpt; // ms
    this.seed = Number.isFinite(options.seed) ? options.seed : 20261109;
    this.rng = mulberry32(this.seed);
    this.stdpEnabled = options.stdp !== false;
    this.stdp = Object.assign({}, STDP_DEFAULTS, options.stdpOptions || {});
    this.noiseExcitatory = Number.isFinite(options.noiseExcitatory)
      ? options.noiseExcitatory : 3;
    this.noiseInhibitory = Number.isFinite(options.noiseInhibitory)
      ? options.noiseInhibitory : 1.5;
    this.driveFrequency = Number.isFinite(options.driveFrequency)
      ? options.driveFrequency : 40; // Hz, weak rhythmic thalamic drive
    this.driveAmplitude = Number.isFinite(options.driveAmplitude)
      ? options.driveAmplitude : 1.2;
    this.inhibitoryWeight = Number.isFinite(options.inhibitoryWeight)
      ? options.inhibitoryWeight : -5;
    this.initialWeight = Number.isFinite(options.initialWeight)
      ? options.initialWeight : 3;

    if (Array.isArray(options.types)) {
      if (options.types.length !== n) {
        throw new RangeError('CorticalNetwork: types length must equal n');
      }
      for (const ty of options.types) {
        if (!IZH_TYPES[ty]) {
          throw new RangeError('CorticalNetwork: unknown neuron type ' + ty);
        }
      }
      this.types = options.types.slice();
    } else {
      this.types = defaultComposition(n);
    }
    this.excitatory = this.types.map((t) => IZH_TYPES[t].excitatory);
    this.nExcitatory = this.excitatory.filter(Boolean).length;
    this.nInhibitory = n - this.nExcitatory;

    this.v = new Float64Array(n);
    this.u = new Float64Array(n);
    this.lastPreSpike = new Float64Array(n).fill(-1e9);
    this.lastPostSpike = new Float64Array(n).fill(-1e9);
    this.synaptic = new Float64Array(n);
    this.weights = [];
    for (let j = 0; j < n; j += 1) {
      const row = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        if (this.excitatory[j]) {
          row[i] = 0.5 * this.initialWeight + this.rng() * this.initialWeight * 0.5;
        } else {
          row[i] = this.inhibitoryWeight;
        }
      }
      this.weights.push(row);
    }
    this.reset();
  }

  reset() {
    this.rng = mulberry32(this.seed);
    for (let i = 0; i < this.n; i += 1) {
      const p = IZH_TYPES[this.types[i]];
      this.v[i] = -65;
      this.u[i] = p.b * this.v[i];
      this.synaptic[i] = 0;
      this.lastPreSpike[i] = -1e9;
      this.lastPostSpike[i] = -1e9;
    }
    this.t = 0;
    this.spikeCountTotal = 0;
  }

  meanExcitatoryWeight() {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < this.n; j += 1) {
      if (!this.excitatory[j]) continue;
      for (let i = 0; i < this.n; i += 1) { sum += this.weights[j][i]; count += 1; }
    }
    return count ? sum / count : 0;
  }

  step(externalInput) {
    const n = this.n;
    const rng = this.rng;
    const drive = this.driveAmplitude * Math.sin(2 * Math.PI * this.driveFrequency * this.t / 1000);
    const fired = [];
    const nextSynaptic = new Float64Array(n);

    for (let i = 0; i < n; i += 1) {
      const p = IZH_TYPES[this.types[i]];
      const noise = (this.excitatory[i] ? this.noiseExcitatory : this.noiseInhibitory)
        * gaussian(rng);
      const I = this.synaptic[i] + noise + drive
        + (typeof externalInput === 'function'
          ? externalInput(i, this.t)
          : (Number(externalInput) || 0));
      const next = izhikevichStep(this.v[i], this.u[i], I, p, this.dt);
      this.v[i] = next.v;
      this.u[i] = next.u;
      if (!Number.isFinite(this.v[i]) || !Number.isFinite(this.u[i])) {
        throw new RangeError(
          'CorticalNetwork diverged: non finite state; reduce dt or input amplitude');
      }
      if (this.v[i] >= 30) {
        this.v[i] = p.c;
        this.u[i] += p.d;
        fired.push(i);
        this.spikeCountTotal += 1;
      }
    }

    // Deliver synaptic currents and run the plasticity rules.
    const tNow = this.t;
    for (const j of fired) {
      for (let i = 0; i < n; i += 1) {
        nextSynaptic[i] += this.weights[j][i];
      }
      // Causal potentiation: this spike is postsynaptic to earlier pre spikes.
      if (this.stdpEnabled) {
        for (let pre = 0; pre < n; pre += 1) {
          if (!this.excitatory[pre]) continue;
          const dtPair = tNow - this.lastPreSpike[pre];
          if (dtPair > 0 && dtPair <= this.stdp.window) {
            this.weights[pre][j] = clamp(
              this.weights[pre][j] + stdpDeltaW(dtPair, this.stdp),
              this.stdp.wMin, this.stdp.wMax);
          }
        }
        // Anti-causal depression for postsynaptic neurons that fired earlier.
        // Only excitatory synapses are plastic, matching the causal rule:
        // clamping an inhibitory row into [wMin, wMax] would zero it.
        if (this.excitatory[j]) {
          for (let post = 0; post < n; post += 1) {
            const gap = tNow - this.lastPostSpike[post];
            if (gap > 0 && gap <= this.stdp.window) {
              this.weights[j][post] = clamp(
                this.weights[j][post] + stdpDeltaW(-gap, this.stdp),
                this.stdp.wMin, this.stdp.wMax);
            }
          }
        }
      }
      this.lastPreSpike[j] = tNow;
      this.lastPostSpike[j] = tNow;
    }

    this.synaptic = nextSynaptic;
    // Local field potential proxy: mean synaptic current across the column.
    let lfp = 0;
    for (let i = 0; i < n; i += 1) lfp += nextSynaptic[i];
    lfp /= n;
    this.t += this.dt;
    return { fired, lfp, t: tNow };
  }

  run(steps, options = {}) {
    const count = steps === undefined ? 1000
      : Math.max(0, Math.floor(Number(steps) || 0));
    if (options.reset !== false) this.reset();
    const raster = [];
    const lfp = [];
    const times = [];
    const weightHistory = [];
    const spikeCounts = new Array(this.n).fill(0);
    for (let k = 0; k < count; k += 1) {
      const r = this.step(options.externalInput);
      times.push(r.t);
      lfp.push(r.lfp);
      for (const i of r.fired) {
        raster.push({ t: r.t, neuron: i, type: this.types[i] });
        spikeCounts[i] += 1;
      }
      if (k % 50 === 0) weightHistory.push({ t: r.t, meanW: this.meanExcitatoryWeight() });
    }
    return {
      raster, lfp, times, dt: this.dt,
      steps: count,
      durationMs: count * this.dt,
      spikeCounts,
      totalSpikes: raster.length,
      meanFiringRateHz: count > 0
        ? (raster.length * 1000) / (count * this.dt * this.n) : 0,
      meanExcitatoryWeight: this.meanExcitatoryWeight(),
      weightHistory,
      types: this.types.slice(),
      excitatory: this.excitatory.slice(),
      nExcitatory: this.nExcitatory,
      nInhibitory: this.nInhibitory,
      seed: this.seed,
      stdpEnabled: this.stdpEnabled,
    };
  }
}

function corticalNetwork(options = {}) {
  return new CorticalNetwork(options);
}

/* ------------------------------------------------------------------ *
 * Spectral analysis
 * ------------------------------------------------------------------ */

/** In place iterative radix two Cooley-Tukey FFT. */
function fft(re, im) {
  const n = re.length;
  if (n < 2) return;
  if (!im || im.length !== n) {
    throw new RangeError('fft: real and imaginary parts must have equal length');
  }
  if ((n & (n - 1)) !== 0) {
    throw new RangeError('fft: length must be a power of two, got ' + n);
  }
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nextR = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextR;
      }
    }
  }
}

/** One sided power spectrum of a real signal with a Hann window. */
function powerSpectrum(signal, sampleRate, options = {}) {
  const fs = Number(sampleRate) > 0 ? Number(sampleRate) : 1000;
  if (!signal || typeof signal.length !== 'number') {
    throw new TypeError('powerSpectrum expects an array of samples');
  }
  const N = signal.length;
  const bands = options.bands || FREQ_BANDS;
  const bandPower = {};
  Object.keys(bands).forEach((k) => { bandPower[k] = 0; });

  for (let i = 0; i < N; i += 1) {
    if (!Number.isFinite(signal[i])) {
      throw new RangeError('powerSpectrum: non finite sample at index ' + i);
    }
  }

  if (N <= 2) {
    return {
      freq: [0], power: [0], sampleRate: fs, nfft: 1,
      peakFrequency: 0, peakPower: 0, bands, bandPower,
      nyquist: fs / 2,
    };
  }
  let mean = 0;
  for (let i = 0; i < N; i += 1) mean += signal[i];
  mean /= N;

  let nfft = 1;
  while (nfft < N) nfft <<= 1;
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < N; i += 1) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    re[i] = (signal[i] - mean) * w;
  }
  fft(re, im);

  const half = nfft / 2;
  const freq = new Array(half + 1);
  const power = new Array(half + 1);
  let peakPower = -1;
  let peakFrequency = 0;
  for (let k = 0; k <= half; k += 1) {
    const f = k * fs / nfft;
    const p = (re[k] * re[k] + im[k] * im[k]) / (N * N);
    freq[k] = f;
    power[k] = p;
    if (k > 0 && p > peakPower) { peakPower = p; peakFrequency = f; }
    Object.keys(bands).forEach((name) => {
      const range = bands[name];
      if (f >= range[0] && f < range[1]) bandPower[name] += p;
    });
  }
  return {
    freq, power, sampleRate: fs, nfft,
    peakFrequency, peakPower: Math.max(0, peakPower),
    bands, bandPower,
    nyquist: fs / 2,
  };
}

/** LFP power spectrum, sample rate derived from the integration step in ms. */
function lfpPowerSpectrum(lfp, dtMs, options = {}) {
  return powerSpectrum(lfp, 1000 / (Number(dtMs) > 0 ? Number(dtMs) : 1), options);
}

/* ------------------------------------------------------------------ *
 * Export helpers
 * ------------------------------------------------------------------ */

const TRACE_COLUMNS = ['t', 'V', 'I', 'iNa', 'iK', 'iL', 'm', 'h', 'n'];

function fixed(x, digits = 6) {
  return Number.isFinite(x) ? Number(x.toFixed(digits)) : 0;
}

function traceToCSV(trace, columns = TRACE_COLUMNS) {
  const cols = columns.filter((c) => Array.isArray(trace[c]) || trace[c] && trace[c].length);
  const lines = [cols.join(',')];
  const rows = (trace.t || []).length;
  for (let i = 0; i < rows; i += 1) {
    const row = cols.map((c) => fixed(trace[c][i], 6));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

function traceToJSON(trace, options = {}) {
  const digits = clamp(
    Math.floor(Number.isFinite(options.digits) ? options.digits : 6), 0, 100);
  const meta = trace.meta || {};
  const samplesT = trace.t || [];
  const spikesList = trace.spikes || [];
  const samples = [];
  const ch = (name) => trace[name] || [];
  for (let i = 0; i < samplesT.length; i += 1) {
    samples.push([
      fixed(samplesT[i], 4), fixed(ch('V')[i], digits),
      fixed(ch('I')[i], digits), fixed(ch('iNa')[i], digits),
      fixed(ch('iK')[i], digits), fixed(ch('iL')[i], digits),
      fixed(ch('m')[i], digits), fixed(ch('h')[i], digits),
      fixed(ch('n')[i], digits),
    ]);
  }
  return JSON.stringify({
    format: 'spike-bench-trace',
    version: VERSION,
    columns: ['t_ms', 'V_mV', 'I_uA_cm2', 'iNa', 'iK', 'iL', 'm', 'h', 'n'],
    mode: meta.mode,
    dt: trace.dt,
    parameters: {
      temperature: meta.temperature,
      q10: meta.q10,
      ttx: meta.ttx,
      tea: meta.tea,
      gNaEff: meta.gNaEff,
      gKEff: meta.gKEff,
      vRest: meta.vRest,
    },
    spikes: spikesList.map((s) => ({
      time: fixed(s.time, 4), peak: fixed(s.peak, 4),
      thresholdV: fixed(s.thresholdV, 4), halfWidth: fixed(s.halfWidth, 4),
    })),
    samples,
  }, null, 2);
}

function ivToCSV(iv) {
  const lines = ['V_mV,peak_iNa_uA_cm2,steady_iK_uA_cm2,tail_iK_uA_cm2,peak_iNa_time_ms'];
  iv.forEach((p) => lines.push([
    fixed(p.V, 3), fixed(p.peakINa, 4), fixed(p.steadyIK, 4),
    fixed(p.tailIK, 4), fixed(p.peakINaTime, 3),
  ].join(',')));
  return lines.join('\n') + '\n';
}

function fIToCSV(curve) {
  const lines = ['I_uA_cm2,rate_Hz,spike_count,mean_peak_mV'];
  curve.points.forEach((p) => lines.push([
    fixed(p.I, 4), fixed(p.rate, 4), p.spikeCount, fixed(p.meanPeak, 4),
  ].join(',')));
  return lines.join('\n') + '\n';
}

function rasterToCSV(raster) {
  const lines = ['time_ms,neuron,type'];
  raster.forEach((s) => lines.push([
    fixed(s.t, 3), s.neuron, s.type,
  ].join(',')));
  return lines.join('\n') + '\n';
}

function spectrumToCSV(spectrum) {
  const lines = ['frequency_Hz,power'];
  for (let k = 0; k < spectrum.freq.length; k += 1) {
    lines.push(fixed(spectrum.freq[k], 4) + ',' + fixed(spectrum.power[k], 8));
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

const API = {
  VERSION,
  HH_DEFAULTS, IZH_TYPES, STDP_DEFAULTS, FREQ_BANDS, TRACE_COLUMNS,
  clamp, temperatureFactor, resolveHH, rateFunctions, steadyStateGates,
  hhCurrents, hhDerivatives, gatingDerivatives, rk4Step, rk4ClampStep,
  makeStep, makeRamp,
  analyzeSpikes, detectSpikes, countSpikes, spikeStats,
  simulateHH, HodgkinHuxley, currentClamp, fICurve, findRheobase,
  refractoryPeriod, voltageClamp, analyzeVoltageClamp,
  familyVoltageClamp, reversalPotential,
  stdpDeltaW, applySTDP, stdpCurve,
  izhikevichStep, CorticalNetwork, corticalNetwork,
  fft, powerSpectrum, lfpPowerSpectrum,
  mulberry32,
  traceToCSV, traceToJSON, ivToCSV, fIToCSV, rasterToCSV, spectrumToCSV,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.SpikeBench = API;
