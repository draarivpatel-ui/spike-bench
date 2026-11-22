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

const VERSION = '2.0.0';

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

const LIF_DEFAULTS = Object.freeze({
  tauM: 20,          // ms, membrane time constant
  vRest: -65,        // mV
  vTh: -50,          // mV, spike threshold
  vReset: -65,       // mV
  rIn: 3,            // mV per uA/cm2 of input drive; rheobase 5 at defaults
  refracMs: 2,       // ms, absolute refractory period
  tauSyn: 5,         // ms, exponential synaptic current decay
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
 * SHA-256, UTF-8 and base64url codecs (pure JS, FIPS 180-4)
 * ------------------------------------------------------------------ */

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb,
  0xbef9a3f7, 0xc67178f2,
]);

const SHA256_H0 = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** UTF-8 encode a JS string into bytes, handling surrogate pairs. */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 1) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** Decode UTF-8 bytes back into a JS string. */
function utf8String(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let c;
    if (b < 0x80) { c = b; i += 1; }
    else if (b < 0xe0) {
      c = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2;
    } else if (b < 0xf0) {
      c = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6)
        | (bytes[i + 2] & 0x3f); i += 3;
    } else {
      c = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12)
        | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4;
    }
    if (c > 0xffff) {
      c -= 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

function sha256Bytes(bytes) {
  const H = SHA256_H0.slice();
  const W = new Int32Array(64);
  const tail = bytes.length % 64;
  const padTotal = bytes.length + (tail < 56 ? 56 - tail : 120 - tail) + 8;
  const buf = new Uint8Array(padTotal);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  // Bit length as a 64 bit big endian integer; messages stay below 2^32 bits
  // in every realistic export, so the low word suffices for the high word too.
  dv.setUint32(padTotal - 8, Math.floor(bytes.length / 0x20000000));
  dv.setUint32(padTotal - 4, (bytes.length * 8) >>> 0);

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padTotal; off += 64) {
    for (let i = 0; i < 16; i += 1) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const w15 = W[i - 15];
      const w2 = W[i - 2];
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0] | 0; let b = H[1] | 0; let c = H[2] | 0; let d = H[3] | 0;
    let e = H[4] | 0; let f = H[5] | 0; let g = H[6] | 0; let h = H[7] | 0;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (SHA256_K[i] | 0) + W[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += (H[i] >>> 0).toString(16).padStart(8, '0');
  }
  return hex;
}

/**
 * SHA-256 hex digest of a string (UTF-8) or byte array.
 * Verified against the FIPS 180-4 test vectors in the test suite.
 */
function sha256(input) {
  let bytes;
  if (typeof input === 'string') bytes = utf8Bytes(input);
  else if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else if (Array.isArray(input)) bytes = Uint8Array.from(input);
  else throw new TypeError('sha256 expects a string, byte array or ArrayBuffer');
  return sha256Bytes(bytes);
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url encode bytes (RFC 4648 section 5, no padding). */
function b64urlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | (b1 === null ? 0 : b1 >> 4)];
    if (b1 !== null) out += B64URL[((b1 & 15) << 2) | (b2 === null ? 0 : b2 >> 6)];
    if (b2 !== null) out += B64URL[b2 & 63];
  }
  return out;
}

/** Base64url decode back into bytes. Throws on characters outside the alphabet. */
function b64urlDecode(str) {
  const rev = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i += 1) rev[B64URL.charCodeAt(i)] = i;
  const clean = str.replace(/=+$/, '');
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    if (code >= 128 || rev[code] < 0) {
      throw new RangeError('b64urlDecode: invalid character at index ' + i);
    }
    acc = (acc << 6) | rev[code];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const STATE_PREFIX = 's1.';

/**
 * Serialize a small plain object into a URL hash safe bookmark token.
 * Deterministic: same state always produces the same string.
 */
function encodeRunState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('encodeRunState expects a plain object');
  }
  return STATE_PREFIX + b64urlEncode(utf8Bytes(JSON.stringify(state)));
}

/** Inverse of encodeRunState; returns null for malformed input. */
function decodeRunState(token) {
  if (typeof token !== 'string' || !token.startsWith(STATE_PREFIX)) return null;
  try {
    const obj = JSON.parse(utf8String(b64urlDecode(token.slice(STATE_PREFIX.length))));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch (err) {
    return null;
  }
}

function stateToHash(state) {
  return '#' + encodeRunState(state);
}

function stateFromHash(hash) {
  if (typeof hash !== 'string') return null;
  return decodeRunState(hash.replace(/^#/, ''));
}

/* ------------------------------------------------------------------ *
 * Leaky integrate and fire point neuron
 * ------------------------------------------------------------------ */

function resolveLIF(options = {}) {
  const o = Object.assign({}, LIF_DEFAULTS, options.lif || options);
  const num = (v, d, lo) => {
    const x = Number(v);
    return Number.isFinite(x) && x > lo ? x : d;
  };
  return {
    tauM: num(o.tauM, LIF_DEFAULTS.tauM, 0),
    vRest: Number.isFinite(Number(o.vRest)) ? Number(o.vRest) : LIF_DEFAULTS.vRest,
    vTh: Number.isFinite(Number(o.vTh)) ? Number(o.vTh) : LIF_DEFAULTS.vTh,
    vReset: Number.isFinite(Number(o.vReset)) ? Number(o.vReset) : LIF_DEFAULTS.vReset,
    rIn: num(o.rIn, LIF_DEFAULTS.rIn, 0),
    refracMs: Math.max(0, Number.isFinite(Number(o.refracMs))
      ? Number(o.refracMs) : LIF_DEFAULTS.refracMs),
    tauSyn: num(o.tauSyn, LIF_DEFAULTS.tauSyn, 0),
  };
}

/**
 * Single leaky integrate and fire neuron, driven by an injected current plus
 * optional exponential synaptic pulses. The subthreshold update is the exact
 * analytic solution of the linear membrane equation, so the step size only
 * affects spike time resolution, not stability.
 *
 * options.synapses: [{ times: [ms...], weight }] pulses delivered into an
 * exponentially decaying synaptic current iSyn.
 */
function simulateLIF(options = {}) {
  const lif = resolveLIF(options);
  const dt = Number(options.dt) > 0 ? Number(options.dt) : 0.05;
  const totalDuration = Number(options.totalDuration) > 0
    ? Number(options.totalDuration) : 50;
  let stimulus;
  if (typeof options.stimulus === 'function') stimulus = options.stimulus;
  else {
    const amplitude = Number.isFinite(options.amplitude) ? options.amplitude : 0;
    const stimStart = Number.isFinite(options.stimStart) ? options.stimStart : 0;
    const stimDuration = Number.isFinite(options.stimDuration)
      ? options.stimDuration : totalDuration;
    stimulus = makeStep(amplitude, stimStart, stimDuration);
  }
  const stim = finiteStimulus(stimulus);

  const synapses = (Array.isArray(options.synapses) ? options.synapses : [])
    .map((s) => ({
      times: (s && Array.isArray(s.times) ? s.times : [])
        .filter((t) => Number.isFinite(t)).sort((a, b) => a - b),
      weight: s && Number.isFinite(s.weight) ? s.weight : 1,
      next: 0,
    }));

  const decayM = Math.exp(-dt / lif.tauM);
  const decayS = Math.exp(-dt / lif.tauSyn);
  let V = Number.isFinite(options.initialV) ? options.initialV : lif.vRest;
  let iSyn = 0;
  let refrac = 0;
  const spikes = [];
  const tr = {
    t: [], V: [], I: [], iSyn: [], dt,
    meta: {
      mode: 'lif', lif, totalDuration,
      vRest: lif.vRest, vTh: lif.vTh, vReset: lif.vReset,
    },
    spikes,
  };
  const steps = Math.max(0, Math.floor(totalDuration / dt + 1e-9));
  for (let k = 0; k <= steps; k += 1) {
    const t = k * dt;
    for (const s of synapses) {
      while (s.next < s.times.length && s.times[s.next] <= t + 1e-9) {
        iSyn += s.weight;
        s.next += 1;
      }
    }
    const I = stim(t);
    tr.t.push(t);
    tr.I.push(I);
    tr.iSyn.push(iSyn);
    tr.V.push(V);
    if (k === steps) break;
    iSyn *= decayS;
    if (refrac > 0) {
      refrac -= dt;
      V = lif.vReset;
    } else {
      const vInf = lif.vRest + lif.rIn * (I + iSyn);
      V += (vInf - V) * (1 - decayM);
      if (V >= lif.vTh) {
        spikes.push({ index: spikes.length, time: t + dt, sample: k + 1 });
        V = lif.vReset;
        refrac = lif.refracMs;
      }
    }
    if (!Number.isFinite(V) || !Number.isFinite(iSyn)) {
      throw new RangeError('simulateLIF diverged: non finite state');
    }
  }
  tr.stats = {
    count: spikes.length,
    meanRateHz: totalDuration > 0 ? (spikes.length * 1000) / totalDuration : 0,
  };
  return tr;
}

/* ------------------------------------------------------------------ *
 * STDP microcircuit experiment
 * ------------------------------------------------------------------ */

/**
 * Many presynaptic spike trains converge on one postsynaptic neuron through
 * plastic synapses that follow the classic Bi and Poo asymmetric STDP rule.
 *
 * Every pair event is recorded with its signed timing deltaT = tPost - tPre
 * (positive: pre before post, potentiation; negative: post before pre,
 * depression) so the UI can plot the exact spike timing correlation.
 *
 * drive: 'burst' gives the presynaptic population partial synchrony, creating
 * strong causal structure and net potentiation; 'poisson' gives independent
 * trains for a mostly balanced drift.
 */
function stdpExperiment(options = {}) {
  const stdp = Object.assign({}, STDP_DEFAULTS, options.stdp || options.stdpOptions || {});
  const nPre = clamp(Math.floor(Number(options.nPre) || 20), 1, 400);
  const rate = Number(options.rate) > 0 ? Number(options.rate) : 20; // Hz
  const duration = Number(options.duration) > 0 ? Number(options.duration) : 1000;
  const dt = Number(options.dt) > 0 ? Number(options.dt) : 0.5;
  const seed = Number.isFinite(options.seed) ? options.seed : 20261121;
  const drive = options.drive === 'poisson' ? 'poisson' : 'burst';
  const burstEvery = Number(options.burstEvery) > 0 ? Number(options.burstEvery) : 120;
  const burstWidth = Number(options.burstWidth) > 0 ? Number(options.burstWidth) : 8;
  const burstProb = clamp(Number.isFinite(options.burstProb)
    ? options.burstProb : 0.55, 0, 1);
  const bias = Number.isFinite(options.bias) ? options.bias : 0;
  const postModel = options.postModel === 'hh' ? 'hh' : 'lif';
  const rng = mulberry32(seed);
  // A fast, well driven membrane lets the postsynaptic cell answer a
  // synchronous burst inside its few millisecond window; callers can
  // override every value via options.lif.
  const lifOpts = Object.assign({ tauM: 8, rIn: 4, tauSyn: 8 }, options.lif || {});
  const lif = resolveLIF({ lif: lifOpts });
  const recordEvery = Number(options.recordEvery) > 0 ? Number(options.recordEvery) : 4;

  // Presynaptic trains, generated first so every random draw is seed bound.
  const preTrains = [];
  for (let j = 0; j < nPre; j += 1) {
    const times = [];
    const sparseRate = drive === 'burst' ? rate * 0.15 : rate;
    let t = -Math.log(1 - rng()) * 1000 / sparseRate;
    while (t < duration) {
      times.push(t);
      t += -Math.log(1 - rng()) * 1000 / sparseRate;
    }
    if (drive === 'burst') {
      for (let c = burstEvery / 2 + rng() * 10; c < duration; c += burstEvery) {
        if (rng() < burstProb) times.push(c + rng() * burstWidth);
      }
      times.sort((a, b) => a - b);
    }
    preTrains.push(times);
  }

  const w0 = options.w0;
  const weights = new Float64Array(nPre);
  for (let j = 0; j < nPre; j += 1) {
    weights[j] = Array.isArray(w0) && Number.isFinite(w0[j])
      ? clamp(w0[j], stdp.wMin, stdp.wMax)
      : (Number.isFinite(w0) ? clamp(w0, stdp.wMin, stdp.wMax)
        : (stdp.wMin + stdp.wMax) / 2);
  }
  const initialWeights = Array.from(weights);
  const lastPre = new Float64Array(nPre).fill(-Infinity);
  let lastPost = -Infinity;

  // Postsynaptic state. 'hh' uses the full RK4 Hodgkin-Huxley integrator.
  const hh = postModel === 'hh' ? resolveHH(options) : null;
  let hhState = null;
  if (hh) {
    const g = steadyStateGates(hh.vRest, hh);
    hhState = cleanState({ V: hh.vRest, m: g.m, h: g.h, n: g.n });
  }
  let V = lif.vRest;
  let iSyn = 0;
  let refrac = 0;
  const decayS = Math.exp(-dt / lif.tauSyn);
  const decayM = Math.exp(-dt / lif.tauM);

  const hhSubsteps = hh ? Math.max(1, Math.ceil(dt / 0.05)) : 0;
  const hhDt = hh ? dt / hhSubsteps : 0;
  const preNext = new Int32Array(nPre);
  const preSpikes = [];
  const postSpikes = [];
  const pairs = [];
  const trajectory = [];
  const vTrace = { t: [], V: [], iSyn: [] };
  let ltpEvents = 0;
  let ltdEvents = 0;

  const steps = Math.max(0, Math.floor(duration / dt + 1e-9));
  const recordStride = Math.max(1, Math.round(recordEvery / dt));

  const applyPair = (j, deltaT, t) => {
    const dw = stdpDeltaW(deltaT, stdp);
    const before = weights[j];
    const after = clamp(before + dw, stdp.wMin, stdp.wMax);
    weights[j] = after;
    pairs.push({
      t, synapse: j, deltaT, dw,
      wBefore: before, wAfter: after,
      kind: deltaT >= 0 ? 'ltp' : 'ltd',
    });
    if (dw >= 0) ltpEvents += 1; else ltdEvents += 1;
  };

  let hhFiredPrev = false;
  for (let k = 0; k <= steps; k += 1) {
    const t = k * dt;
    iSyn *= decayS;

    // Deliver presynaptic spikes; a post spike inside the window depresses.
    for (let j = 0; j < nPre; j += 1) {
      while (preNext[j] < preTrains[j].length
          && preTrains[j][preNext[j]] <= t + 1e-9) {
        const tPre = preTrains[j][preNext[j]];
        iSyn += weights[j];
        preSpikes.push({ t: tPre, neuron: j });
        const deltaT = lastPost - tPre;
        if (lastPost > -Infinity && -deltaT > 0 && -deltaT <= stdp.window) {
          applyPair(j, deltaT, t);
        }
        lastPre[j] = tPre;
        preNext[j] += 1;
      }
    }

    // Postsynaptic update. The HH membrane needs a finer step than the
    // sandbox clock, so it integrates in substeps of at most 0.05 ms.
    let postFired = false;
    if (hhState) {
      for (let s = 0; s < hhSubsteps; s += 1) {
        hhState = rk4Step(hhState, iSyn + bias, hhDt, hh);
      }
      V = hhState.V;
      const crossed = !hhFiredPrev && V > 0;
      hhFiredPrev = V > 0;
      if (crossed) postFired = true;
    } else {
      if (refrac > 0) {
        refrac -= dt;
        V = lif.vReset;
      } else {
        const vInf = lif.vRest + lif.rIn * (bias + iSyn);
        V += (vInf - V) * (1 - decayM);
        if (V >= lif.vTh) postFired = true;
      }
      if (postFired) { V = lif.vReset; refrac = lif.refracMs; }
    }

    if (postFired) {
      postSpikes.push(t);
      for (let j = 0; j < nPre; j += 1) {
        const deltaT = t - lastPre[j];
        if (deltaT >= 0 && deltaT <= stdp.window) applyPair(j, deltaT, t);
      }
      lastPost = t;
    }

    vTrace.t.push(t);
    vTrace.V.push(V);
    vTrace.iSyn.push(iSyn);
    if (k % recordStride === 0) {
      trajectory.push({ t, weights: Array.from(weights) });
    }
  }

  const finalWeights = Array.from(weights);
  const mean = (xs) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
  return {
    params: {
      nPre, rate, duration, dt, seed, drive,
      burstEvery, burstWidth, burstProb, bias, postModel,
      stdp: Object.assign({}, stdp),
      lif: Object.assign({}, lif),
    },
    preTrains, preSpikes, postSpikes, pairs, pairsAll: pairs,
    weights: {
      initial: initialWeights,
      final: finalWeights,
      trajectory,
      meanTrajectory: trajectory.map((p) => ({ t: p.t, mean: mean(p.weights) })),
    },
    vTrace,
    stats: {
      preSpikeCount: preSpikes.length,
      postSpikeCount: postSpikes.length,
      meanPostRateHz: duration > 0 ? (postSpikes.length * 1000) / duration : 0,
      ltpEvents, ltdEvents,
      meanWeightInitial: mean(initialWeights),
      meanWeightFinal: mean(finalWeights),
      deltaMeanWeight: mean(finalWeights) - mean(initialWeights),
      totalPairEvents: pairs.length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Izhikevich phase portraits and Hodgkin-Huxley reduced nullclines
 * ------------------------------------------------------------------ */

/**
 * Simulate one Izhikevich neuron under tonic drive and return its (v, u)
 * trajectory with spike markers, ready for phase plane plotting.
 */
function simulateIzh(options = {}) {
  const type = IZH_TYPES[options.type] ? options.type : 'RS';
  const p = IZH_TYPES[type];
  const dt = Number(options.dt) > 0 ? Number(options.dt) : 0.25;
  const duration = Number(options.duration) > 0 ? Number(options.duration) : 200;
  const I = options.I === undefined ? 10 : options.I;
  const iAt = (t) => {
    const v = typeof I === 'function' ? I(t) : I;
    if (!Number.isFinite(v)) {
      throw new RangeError('simulateIzh: injected current is not finite');
    }
    return v;
  };
  let v = Number.isFinite(options.v0) ? options.v0 : -65;
  let u = Number.isFinite(options.u0) ? options.u0 : p.b * v;
  const trajectory = [];
  const spikes = [];
  const steps = Math.max(0, Math.floor(duration / dt + 1e-9));
  for (let k = 0; k <= steps; k += 1) {
    const t = k * dt;
    if (v >= 30) {
      trajectory.push({ t, v: 30, u, spike: true });
      spikes.push(t);
      v = p.c;
      u += p.d;
      continue;
    }
    const next = izhikevichStep(v, u, iAt(t), p, dt);
    trajectory.push({ t, v, u, spike: false });
    v = next.v;
    u = next.u;
    if (!Number.isFinite(v) || !Number.isFinite(u)) {
      throw new RangeError('simulateIzh diverged: non finite state');
    }
  }
  return { trajectory, spikes, type, dt, duration };
}

/** Exact (v, u) nullclines for the Izhikevich model at drive I. */
function izhNullclines(I, type = 'RS', options = {}) {
  const p = IZH_TYPES[type] || IZH_TYPES.RS;
  const vMin = Number.isFinite(options.vMin) ? options.vMin : -90;
  const vMax = Number.isFinite(options.vMax) ? options.vMax : 40;
  const step = Number(options.step) > 0 ? Number(options.step) : 1;
  const drive = Number.isFinite(I) ? I : 0;
  const vNull = [];
  const uNull = [];
  for (let v = vMin; v <= vMax + 1e-9; v += step) {
    vNull.push({ v, u: 0.04 * v * v + 5 * v + 140 + drive });
    uNull.push({ v, u: p.b * v });
  }
  // Equilibria solve 0.04 v^2 + (5 - b) v + 140 + I = 0.
  const A = 0.04;
  const B = 5 - p.b;
  const C = 140 + drive;
  const disc = B * B - 4 * A * C;
  const equilibria = [];
  if (disc >= 0) {
    const s = Math.sqrt(disc);
    equilibria.push({ v: (-B - s) / (2 * A), u: p.b * (-B - s) / (2 * A) });
    if (s > 0) equilibria.push({ v: (-B + s) / (2 * A), u: p.b * (-B + s) / (2 * A) });
  }
  return { vNull, uNull, equilibria, I: drive, type };
}

/** Full phase portrait bundle: trajectory plus exact nullclines. */
function phasePortraitIzh(options = {}) {
  const sim = simulateIzh(options);
  const drive = Number.isFinite(options.I) ? options.I : 0;
  const nc = izhNullclines(drive, sim.type, options);
  return {
    model: 'izhikevich',
    trajectory: sim.trajectory,
    spikes: sim.spikes,
    vNullcline: nc.vNull,
    uNullcline: nc.uNull,
    equilibria: nc.equilibria,
    isLimitCycle: sim.spikes.length > 0,
    spikeCount: sim.spikes.length,
    I: drive,
    type: sim.type,
    duration: sim.duration,
    dt: sim.dt,
  };
}

/**
 * Reduced (V, n) nullclines for the Hodgkin-Huxley membrane under a constant
 * injected current, using the standard fast slow decomposition: m and h are
 * assumed to sit at their voltage dependent steady states, leaving n as the
 * slow variable. The V nullcline solves dV/dt = 0 for n; the n nullcline is
 * n_inf(V). Only V nullcline points with n inside [0, 1] are reported.
 */
function hhReducedNullclines(I, options = {}) {
  const hh = asHH(options);
  const drive = Number.isFinite(I) ? I : 0;
  const vMin = Number.isFinite(options.vMin) ? options.vMin : -100;
  const vMax = Number.isFinite(options.vMax) ? options.vMax : 60;
  const step = Number(options.step) > 0 ? Number(options.step) : 0.25;
  const vNull = [];
  const nNull = [];
  for (let V = vMin; V <= vMax + 1e-9; V += step) {
    const g = steadyStateGates(V, hh);
    const iNa = hh.gNaEff * g.mInf * g.mInf * g.mInf * g.hInf * (V - hh.eNa);
    const iL = hh.gL * (V - hh.eL);
    const denom = hh.gKEff * (V - hh.eK);
    if (Math.abs(denom) > 1e-9) {
      const n4 = (drive - iNa - iL) / denom;
      if (n4 >= 0) {
        const nStar = Math.pow(n4, 0.25);
        if (nStar >= 0 && nStar <= 1) vNull.push({ V, n: nStar });
      }
    }
    nNull.push({ V, n: g.nInf });
  }
  return { vNull, nNull, I: drive };
}

/**
 * Phase portrait of the Hodgkin-Huxley membrane in the (V, n) plane under a
 * constant current step, plus the reduced nullclines for interpretation.
 */
function phasePortraitHH(options = {}) {
  const I = Number.isFinite(options.amplitude)
    ? options.amplitude
    : (Number.isFinite(options.I) ? options.I : 10);
  const duration = Number(options.duration) > 0 ? Number(options.duration) : 50;
  const tr = currentClamp(Object.assign({}, options, {
    amplitude: I, stimStart: 0, stimDuration: duration, postTime: 0,
    stimulusType: 'step',
  }));
  const trajectory = [];
  for (let k = 0; k < tr.t.length; k += 1) {
    trajectory.push({ t: tr.t[k], V: tr.V[k], n: tr.n[k], m: tr.m[k], h: tr.h[k] });
  }
  const nc = hhReducedNullclines(I, options);
  return {
    model: 'hodgkin-huxley',
    trajectory,
    spikes: tr.spikes.map((s) => s.time),
    vNullcline: nc.vNull,
    nNullcline: nc.nNull,
    isLimitCycle: tr.spikes.length > 0,
    spikeCount: tr.spikes.length,
    I,
    duration,
    dt: tr.dt,
  };
}

/** Combined rheobase bisection plus an f-I sweep in one call. */
function fISweep(options = {}) {
  const maxI = Number.isFinite(options.maxI) && options.maxI > 0 ? options.maxI : 20;
  const stepI = Number.isFinite(options.stepI) && options.stepI > 0
    ? options.stepI : 2;
  const amplitudes = Array.isArray(options.amplitudes)
    ? options.amplitudes.filter((I) => Number.isFinite(I))
    : (() => {
      const out = [];
      for (let I = 0; I <= maxI + 1e-9; I += stepI) out.push(Math.round(I * 1e6) / 1e6);
      return out;
    })();
  const fi = fICurve(Object.assign({}, options, { amplitudes }));
  const rheo = findRheobase(options);
  const first = fi.points.find((p) => p.rate > 0);
  return {
    points: fi.points,
    amplitudes: fi.points.map((p) => p.I),
    rates: fi.points.map((p) => p.rate),
    monotonic: fi.monotonic,
    maxRate: fi.maxRate,
    stimDuration: fi.stimDuration,
    rheobase: rheo.rheobase,
    rheobaseDetail: rheo,
    firstSpikingI: first ? first.I : null,
  };
}

/* ------------------------------------------------------------------ *
 * Verified deterministic export
 * ------------------------------------------------------------------ */

/** Canonical serialization for checksumming: JSON with stable key order. */
function canonicalJSON(payload) {
  return JSON.stringify(payload);
}

/** SHA-256 checksum helper for any exported text. */
function checksum(text) {
  return sha256(String(text));
}

/**
 * Wrap a payload in a self verifying document: the payload checksum travels
 * beside it so a reader can prove the export was not corrupted or edited.
 */
function verifiedDocument(payload) {
  const body = canonicalJSON(payload);
  return JSON.stringify({
    format: 'spike-bench-verified',
    version: VERSION,
    algorithm: 'SHA-256',
    checksum: sha256(body),
    payload,
  }, null, 2);
}

/** Recompute a verified document's checksum. */
function verifyDocument(jsonText) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!doc || doc.format !== 'spike-bench-verified' || doc.payload === undefined) {
    return { ok: false, error: 'not a spike-bench verified document' };
  }
  const computed = sha256(canonicalJSON(doc.payload));
  return {
    ok: computed === doc.checksum,
    checksum: doc.checksum,
    computed,
    algorithm: doc.algorithm,
    version: doc.version,
  };
}

/**
 * Assemble a session report: membrane trace samples, spike raster, synaptic
 * weights and f-I points travel together in one verified JSON document.
 */
function exportSpikeReport(sections = {}) {
  const payload = {
    label: typeof sections.label === 'string' ? sections.label : 'spike-bench-session',
    generator: 'spike-bench/' + VERSION,
    sections: {},
  };
  if (sections.meta && typeof sections.meta === 'object') payload.meta = sections.meta;
  if (sections.trace && Array.isArray(sections.trace.t)) {
    const tr = sections.trace;
    const samples = [];
    const rows = tr.t.length;
    for (let i = 0; i < rows; i += 1) {
      samples.push([fixed(tr.t[i], 4), fixed(tr.V[i], 4), fixed(tr.I[i], 4)]);
    }
    payload.sections.trace = {
      columns: ['t_ms', 'V_mV', 'I_uA_cm2'],
      dt: tr.dt,
      samples,
      spikes: (tr.spikes || []).map((s) => ({
        time: fixed(s.time !== undefined ? s.time : s, 4),
        peak: fixed(s.peak, 4),
      })),
    };
  }
  if (Array.isArray(sections.raster)) {
    payload.sections.raster = sections.raster.map((s) => ({
      t: fixed(s.t, 4), neuron: s.neuron, type: s.type,
    }));
  }
  if (sections.weights) {
    const w = sections.weights;
    payload.sections.weights = {
      initial: w.initial || [],
      final: w.final || [],
      stats: w.stats || {},
    };
  }
  if (sections.pairs) {
    payload.sections.pairs = sections.pairs.map((p) => ({
      t: fixed(p.t, 4), synapse: p.synapse,
      deltaT: fixed(p.deltaT, 4), dw: fixed(p.dw, 6),
    }));
  }
  if (sections.fiCurve) {
    const fi = sections.fiCurve;
    payload.sections.fiCurve = {
      points: (fi.points || fi || []).map((p) => ({
        I: fixed(p.I, 4), rate: fixed(p.rate, 4), spikeCount: p.spikeCount,
      })),
      rheobase: fi.rheobase !== undefined ? fi.rheobase : null,
      monotonic: !!fi.monotonic,
    };
  }
  const json = verifiedDocument(payload);
  return {
    json,
    checksum: sha256(json),
    payloadChecksum: JSON.parse(json).checksum,
    payload,
    bytes: utf8Bytes(json).length,
  };
}

/* ------------------------------------------------------------------ *
 * In page self test battery
 * ------------------------------------------------------------------ */

/**
 * Deterministic self checks, runnable in the browser and in Node.
 * Returns { ok, pass, fail, results: [{name, ok, detail, ms}] }.
 */
function runSelfTests() {
  const results = [];
  const check = (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: String(detail), ms: Date.now() - t0 });
    } catch (err) {
      results.push({
        name, ok: false, detail: err && err.message ? err.message : String(err),
        ms: Date.now() - t0,
      });
    }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  check('sha256-fips-vector', () => {
    const want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const got = sha256('abc');
    expect(got === want, 'abc digest mismatch: ' + got);
    return 'sha256("abc") = ' + got.slice(0, 16) + '...';
  });

  check('resting-potential-stability', () => {
    const tr = simulateHH({ totalDuration: 50, dt: 0.02 });
    const drift = Math.abs(tr.V[tr.V.length - 1] - tr.V[0]);
    expect(drift < 0.1, 'rest drift ' + drift.toFixed(4) + ' mV');
    return 'drift ' + drift.toFixed(4) + ' mV over 50 ms';
  });

  check('rk4-step-halving-convergence', () => {
    const common = { amplitude: 10, stimStart: 5, stimDuration: 20, postTime: 5 };
    const a = currentClamp(Object.assign({}, common, { dt: 0.02 }));
    const b = currentClamp(Object.assign({}, common, { dt: 0.01 }));
    expect(a.spikes.length > 0 && b.spikes.length > 0, 'no spikes in either run');
    const d = Math.abs(a.spikes[0].peak - b.spikes[0].peak);
    expect(d < 1.5, 'peak mismatch ' + d.toFixed(3) + ' mV');
    return 'peak error ' + d.toFixed(3) + ' mV at halved dt';
  });

  check('spike-detection-and-shape', () => {
    const tr = currentClamp({ amplitude: 10, stimStart: 5, stimDuration: 20 });
    expect(tr.spikes.length >= 2, 'expected a spike train');
    expect(tr.spikes[0].peak > 0 && tr.spikes[0].peak < 60, 'peak out of range');
    return tr.spikes.length + ' spikes, first peak ' +
      tr.spikes[0].peak.toFixed(1) + ' mV';
  });

  check('stdp-ltp-sign', () => {
    const dw = stdpDeltaW(10);
    expect(dw > 0, 'causal pairing did not potentiate');
    return 'causal dt=+10 ms gives dw=+' + dw.toFixed(5);
  });

  check('stdp-ltd-sign', () => {
    const dw = stdpDeltaW(-10);
    expect(dw < 0, 'anti-causal pairing did not depress');
    return 'anti-causal dt=-10 ms gives dw=' + dw.toFixed(5);
  });

  check('stdp-exponential-window', () => {
    const ratio = stdpDeltaW(STDP_DEFAULTS.tauPlus) / stdpDeltaW(0);
    expect(Math.abs(ratio - Math.exp(-1)) < 1e-9,
      'potentiation does not decay as exp(-t/tau)');
    return 'dw(tau)/dw(0) = ' + ratio.toFixed(6) + ' vs 1/e';
  });

  check('stdp-sandbox-burst-potentiates', () => {
    const r = stdpExperiment({
      nPre: 8, duration: 400, dt: 0.5, drive: 'burst', seed: 7,
    });
    expect(r.stats.ltpEvents > 0, 'no LTP events recorded');
    expect(r.weights.final.every((w) => w >= -1e-9), 'weight below bound');
    return r.stats.ltpEvents + ' LTP / ' + r.stats.ltdEvents + ' LTD events';
  });

  check('rheobase-bisection-converges', () => {
    const r = findRheobase({ iterations: 12, stimDuration: 60 });
    expect(r.converged === true, 'rheobase did not converge');
    expect(r.rheobase > 1 && r.rheobase < 6, 'rheobase out of range: ' + r.rheobase);
    return 'rheobase ' + r.rheobase.toFixed(3) + ' uA/cm2';
  });

  check('rheobase-monotonicity', () => {
    const r = findRheobase({ iterations: 12, stimDuration: 60 });
    const below = currentClamp({
      amplitude: r.lowerBound - 0.05, stimStart: 5,
      stimDuration: r.stimDuration, postTime: 0,
    });
    const above = currentClamp({
      amplitude: r.upperBound + 0.05, stimStart: 5,
      stimDuration: r.stimDuration, postTime: 0,
    });
    expect(below.spikes.length === 0, 'subthreshold run fired');
    expect(above.spikes.length >= 1, 'suprathreshold run silent');
    return 'fires above ' + r.upperBound.toFixed(3) +
      ', silent below ' + r.lowerBound.toFixed(3);
  });

  check('fi-monotone-sweep', () => {
    const fi = fICurve({ amplitudes: [0, 5, 10, 15, 20], stimDuration: 200 });
    expect(fi.monotonic, 'f-I curve not monotone');
    expect(fi.maxRate > 0, 'no firing on sweep');
    return 'max rate ' + fi.maxRate.toFixed(1) + ' Hz, monotone';
  });

  check('lif-threshold-and-reset', () => {
    const tr = simulateLIF({ amplitude: 8, totalDuration: 100, dt: 0.05 });
    expect(tr.spikes.length > 0, 'LIF did not fire above rheobase');
    expect(tr.spikes[0].time > 0, 'non physical spike time');
    return 'LIF fired ' + tr.spikes.length + ' spikes at I=8';
  });

  check('izh-phase-plane-limit-cycle', () => {
    const pp = phasePortraitIzh({ I: 10, duration: 200 });
    expect(pp.spikeCount > 0, 'no limit cycle at I=10');
    const quiet = phasePortraitIzh({ I: 0, duration: 100 });
    expect(quiet.spikeCount === 0, 'spurious spikes at rest');
    return 'RS limit cycle: ' + pp.spikeCount + ' spikes at I=10';
  });

  check('network-determinism', () => {
    const a = corticalNetwork({ n: 8, seed: 11 }).run(200);
    const b = corticalNetwork({ n: 8, seed: 11 }).run(200);
    expect(a.totalSpikes === b.totalSpikes, 'seeded runs diverged');
    return 'seed 11: ' + a.totalSpikes + ' spikes, identical';
  });

  check('export-roundtrip-verified', () => {
    const report = exportSpikeReport({
      label: 'self-test',
      raster: [{ t: 1.5, neuron: 0, type: 'RS' }],
    });
    const v = verifyDocument(report.json);
    expect(v.ok, 'checksum verification failed');
    return 'checksum ' + report.payloadChecksum.slice(0, 12) + '... verified';
  });

  check('state-codec-roundtrip', () => {
    const state = { amp: 10, proto: 'step', nested: { a: [1, 2, 3] } };
    const back = decodeRunState(encodeRunState(state));
    expect(back && back.amp === 10 && back.nested.a[2] === 3, 'codec mismatch');
    return 'state round trip via #' + encodeRunState(state).slice(0, 14) + '...';
  });

  check('fft-impulse-flat-spectrum', () => {
    const re = [1, 0, 0, 0];
    const im = [0, 0, 0, 0];
    fft(re, im);
    expect(re.every((x) => Math.abs(x - 1) < 1e-12), 'impulse spectrum not flat');
    return 'unit impulse gives flat spectrum';
  });

  const pass = results.filter((r) => r.ok).length;
  return {
    ok: pass === results.length,
    pass,
    fail: results.length - pass,
    total: results.length,
    results,
    version: VERSION,
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

const API = {
  VERSION,
  HH_DEFAULTS, IZH_TYPES, STDP_DEFAULTS, FREQ_BANDS, LIF_DEFAULTS, TRACE_COLUMNS,
  clamp, temperatureFactor, resolveHH, rateFunctions, steadyStateGates,
  hhCurrents, hhDerivatives, gatingDerivatives, rk4Step, rk4ClampStep,
  makeStep, makeRamp,
  analyzeSpikes, detectSpikes, countSpikes, spikeStats,
  simulateHH, HodgkinHuxley, currentClamp, fICurve, findRheobase, fISweep,
  refractoryPeriod, voltageClamp, analyzeVoltageClamp,
  familyVoltageClamp, reversalPotential,
  stdpDeltaW, applySTDP, stdpCurve, stdpExperiment,
  izhikevichStep, CorticalNetwork, corticalNetwork,
  simulateIzh, izhNullclines, phasePortraitIzh,
  hhReducedNullclines, phasePortraitHH,
  fft, powerSpectrum, lfpPowerSpectrum,
  mulberry32,
  resolveLIF, simulateLIF,
  sha256, sha256Bytes, checksum, utf8Bytes, utf8String,
  b64urlEncode, b64urlDecode,
  encodeRunState, decodeRunState, stateToHash, stateFromHash,
  canonicalJSON, verifiedDocument, verifyDocument, exportSpikeReport,
  runSelfTests,
  traceToCSV, traceToJSON, ivToCSV, fIToCSV, rasterToCSV, spectrumToCSV,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.SpikeBench = API;
