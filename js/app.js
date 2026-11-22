'use strict';
/*
 * Spike Bench browser shell. Drives the same Hodgkin-Huxley engine the node
 * tests cover (src/neuro.js exposes window.SpikeBench), draws the recorded
 * traces and reports the engine's own spike analysis.
 *
 * window.SB carries the shared session: the last workbench trace, the last
 * STDP experiment and the last sweep, so the lab tab can export them all.
 */
(function () {
  const N = window.SpikeBench;
  const UI = window.SBUI;
  const $ = (id) => document.getElementById(id);

  const dom = {
    protocol: $('f-protocol'),
    amp: $('f-amp'),
    vhold: $('f-vhold'),
    vcmd: $('f-vcmd'),
    start: $('f-start'),
    dur: $('f-dur'),
    post: $('f-post'),
    ttx: $('f-ttx'),
    tea: $('f-tea'),
    btnRun: $('btn-run'),
    btnCsv: $('btn-csv'),
    trace: $('trace'),
    stim: $('stim'),
    legend: $('legend'),
    live: $('live'),
    presets: document.querySelectorAll('.preset'),
    tabs: document.querySelectorAll('.tab'),
    statLabels: [$('stat-1-label'), $('stat-2-label'), $('stat-3-label'),
      $('stat-4-label'), $('stat-5-label')],
    statValues: [$('stat-1'), $('stat-2'), $('stat-3'), $('stat-4'), $('stat-5')],
  };

  const PRESETS = {
    rest:   { proto: 'step',   amp: 0,  start: 5, dur: 20, post: 10, ttx: 0,   tea: 0 },
    spike:  { proto: 'step',   amp: 10, start: 5, dur: 20, post: 10, ttx: 0,   tea: 0 },
    train:  { proto: 'step',   amp: 15, start: 5, dur: 60, post: 15, ttx: 0,   tea: 0 },
    ttx:    { proto: 'step',   amp: 30, start: 5, dur: 40, post: 15, ttx: 100, tea: 0 },
    tea:    { proto: 'step',   amp: 15, start: 5, dur: 40, post: 30, ttx: 0,   tea: 100 },
    vclamp: { proto: 'vclamp', vhold: -65, vcmd: -20, start: 5, dur: 20, post: 15, ttx: 0, tea: 0 },
  };

  const COLORS = UI.COLORS;
  const plot = UI.plot;

  /* ------------------------- shared session ------------------------- */

  const SB = window.SB = {
    N, UI,
    last: { trace: null, stdp: null, sweep: null, portrait: null },
    tab: 'clamp',
    collectors: {},
    appliers: {},
  };

  function num(el, fallback) {
    const v = Number(el.value);
    return Number.isFinite(v) ? v : fallback;
  }

  function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }

  function announce(msg) {
    dom.live.textContent = msg;
  }
  SB.announce = announce;
  SB.num = num;

  /* ------------------------- tabs ------------------------- */

  const panels = {
    clamp: $('tab-clamp'), stdp: $('tab-stdp'),
    fi: $('tab-fi'), lab: $('tab-lab'),
  };

  function setTab(name) {
    if (!panels[name]) name = 'clamp';
    SB.tab = name;
    dom.tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('active', on);
    });
    Object.keys(panels).forEach((k) => { panels[k].hidden = k !== name; });
    document.dispatchEvent(new CustomEvent('sb:tab', { detail: name }));
  }
  SB.setTab = setTab;

  /* ------------------------- bookmark state ------------------------- */

  SB.register = (name, collector, applier) => {
    SB.collectors[name] = collector;
    SB.appliers[name] = applier;
  };

  function buildState() {
    const state = { t: SB.tab };
    Object.keys(SB.collectors).forEach((k) => {
      try { state[k] = SB.collectors[k](); } catch (err) { /* keep hash valid */ }
    });
    return state;
  }
  SB.buildState = buildState;

  function pushHash() {
    try {
      const hash = N.stateToHash(buildState());
      window.history.replaceState(null, '', hash);
      return hash;
    } catch (err) {
      return null;
    }
  }
  SB.pushHash = pushHash;

  /* ------------------------- workbench run ------------------------- */

  function isVC() {
    return dom.protocol.value === 'vclamp';
  }

  function syncFields() {
    const vc = isVC();
    document.querySelectorAll('[data-proto="cc"]').forEach((el) => { el.hidden = vc; });
    document.querySelectorAll('[data-proto="vc"]').forEach((el) => { el.hidden = !vc; });
  }

  function workbenchState() {
    return {
      p: dom.protocol.value,
      a: num(dom.amp, 10), vh: num(dom.vhold, -65), vc: num(dom.vcmd, -20),
      s: num(dom.start, 5), d: num(dom.dur, 20), o: num(dom.post, 10),
      x: num(dom.ttx, 0), e: num(dom.tea, 0),
    };
  }

  function applyWorkbenchState(w) {
    if (!w) return;
    if (['step', 'ramp', 'vclamp'].includes(w.p)) dom.protocol.value = w.p;
    if (Number.isFinite(w.a)) dom.amp.value = w.a;
    if (Number.isFinite(w.vh)) dom.vhold.value = w.vh;
    if (Number.isFinite(w.vc)) dom.vcmd.value = w.vc;
    if (Number.isFinite(w.s)) dom.start.value = w.s;
    if (Number.isFinite(w.d)) dom.dur.value = w.d;
    if (Number.isFinite(w.o)) dom.post.value = w.o;
    if (Number.isFinite(w.x)) dom.ttx.value = w.x;
    if (Number.isFinite(w.e)) dom.tea.value = w.e;
    syncFields();
  }
  SB.register('w', workbenchState, applyWorkbenchState);

  function run() {
    const common = {
      ttx: clamp01(num(dom.ttx, 0) / 100),
      tea: clamp01(num(dom.tea, 0) / 100),
      dt: 0.01,
    };
    let tr;
    try {
      if (isVC()) {
        tr = N.voltageClamp(Object.assign(common, {
          vHold: num(dom.vhold, -65),
          vCmd: num(dom.vcmd, -20),
          stepStart: Math.max(0, num(dom.start, 5)),
          stepDuration: Math.max(0.5, num(dom.dur, 20)),
          postTime: Math.max(0, num(dom.post, 10)),
        }));
      } else {
        tr = N.currentClamp(Object.assign(common, {
          amplitude: num(dom.amp, 10),
          stimStart: Math.max(0, num(dom.start, 5)),
          stimDuration: Math.max(0.5, num(dom.dur, 20)),
          postTime: Math.max(0, num(dom.post, 10)),
          stimulusType: dom.protocol.value === 'ramp' ? 'ramp' : 'step',
        }));
      }
    } catch (err) {
      SB.last.trace = null;
      dom.btnCsv.disabled = true;
      dom.statValues.forEach((el) => { el.textContent = '-'; });
      announce('Simulation failed. ' + err.message);
      return;
    }
    SB.last.trace = tr;
    dom.btnCsv.disabled = false;
    draw(tr);
    report(tr);
    document.dispatchEvent(new CustomEvent('sb:session'));
  }
  SB.run = run;

  function fmt(v, digits) {
    return Number.isFinite(v) ? v.toFixed(digits) : '-';
  }
  SB.fmt = fmt;

  function report(tr) {
    if (isVC()) {
      const a = tr.analysis;
      const labels = ['Peak iNa, uA/cm2', 'Peak iNa at, ms', 'Steady iK, uA/cm2',
        'Tail iK, uA/cm2', 'Peak iK, uA/cm2'];
      const values = [fmt(a.peakINa, 1), fmt(a.peakINaTime, 1), fmt(a.steadyIK, 1),
        fmt(a.tailIK, 1), fmt(a.peakIK, 1)];
      dom.statLabels.forEach((el, i) => { el.textContent = labels[i]; });
      dom.statValues.forEach((el, i) => { el.textContent = values[i]; });
      announce('Voltage clamp run complete. Peak sodium current ' +
        fmt(a.peakINa, 1) + ' microamps per square centimeter.');
    } else {
      const s = tr.stats;
      const labels = ['Spikes', 'Rate, Hz', 'Peak, mV', 'Half width, ms', 'AHP, mV'];
      const values = [String(s.count), fmt(s.meanRateHz, 1), fmt(s.meanPeak, 1),
        fmt(s.meanHalfWidth, 2), fmt(s.meanAHP, 1)];
      dom.statLabels.forEach((el, i) => { el.textContent = labels[i]; });
      dom.statValues.forEach((el, i) => { el.textContent = values[i]; });
      announce('Run complete. ' + s.count + ' spike' + (s.count === 1 ? '' : 's') +
        ', mean rate ' + fmt(s.meanRateHz, 1) + ' hertz.');
    }
  }

  /* ------------------------- drawing ------------------------- */

  function draw(tr) {
    const t = tr.t;
    if (isVC()) {
      dom.legend.hidden = false;
      plot(dom.trace, [
        { x: t, y: tr.iNa, color: COLORS.ina },
        { x: t, y: tr.iK, color: COLORS.ik },
      ], {
        ylabel: 'uA/cm2',
        window: [tr.meta.stepStart, tr.meta.stepEnd],
      });
      plot(dom.stim, [{ x: t, y: tr.V, color: COLORS.stimLine, width: 1.4 }], {
        ylabel: 'mV',
      });
    } else {
      dom.legend.hidden = true;
      const dots = tr.spikes.map((s) => ({ x: s.time, y: s.peak }));
      plot(dom.trace, [{ x: t, y: tr.V, color: COLORS.v, width: 1.8 }], {
        ylabel: 'mV',
        window: [tr.meta.stimStart, tr.meta.stimStart + tr.meta.stimDuration],
        dots,
      });
      plot(dom.stim, [{ x: t, y: tr.I, color: COLORS.stimLine, width: 1.4 }], {
        ylabel: 'uA/cm2',
        fillTo: 0,
      });
    }
  }
  SB.draw = draw;

  /* ------------------------- export ------------------------- */

  function exportCsv() {
    if (!SB.last.trace) return;
    const csv = N.traceToCSV(SB.last.trace);
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spike-bench-' + dom.protocol.value + '-trace.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    announce('Trace exported as CSV. SHA-256 ' + N.checksum(csv).slice(0, 16) + '...');
  }

  /* ------------------------- wiring ------------------------- */

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    dom.protocol.value = p.proto;
    if (p.amp !== undefined) dom.amp.value = p.amp;
    if (p.vhold !== undefined) dom.vhold.value = p.vhold;
    if (p.vcmd !== undefined) dom.vcmd.value = p.vcmd;
    dom.start.value = p.start;
    dom.dur.value = p.dur;
    dom.post.value = p.post;
    dom.ttx.value = p.ttx;
    dom.tea.value = p.tea;
    dom.presets.forEach((b) =>
      b.setAttribute('aria-pressed', b.dataset.preset === name ? 'true' : 'false'));
    syncFields();
    run();
  }
  SB.applyPreset = applyPreset;

  dom.presets.forEach((b) => {
    b.addEventListener('click', () => applyPreset(b.dataset.preset));
  });
  dom.tabs.forEach((t) => {
    t.addEventListener('click', () => {
      setTab(t.dataset.tab);
      pushHash();
    });
  });
  dom.protocol.addEventListener('change', () => {
    syncFields();
    dom.presets.forEach((b) => b.setAttribute('aria-pressed', 'false'));
    run();
  });
  dom.btnRun.addEventListener('click', run);
  dom.btnCsv.addEventListener('click', exportCsv);
  window.addEventListener('resize', () => { if (SB.last.trace) draw(SB.last.trace); });

  syncFields();
  const hash = window.location.hash;
  const restored = N.stateFromHash(hash);
  SB.pendingState = restored || null;
  if (restored) {
    if (restored.w) applyWorkbenchState(restored.w);
    Object.keys(SB.appliers).forEach((k) => {
      if (k !== 'w' && restored[k]) {
        try { SB.appliers[k](restored[k]); } catch (err) { /* keep loading */ }
      }
    });
    dom.presets.forEach((b) => b.setAttribute('aria-pressed', 'false'));
    setTab(restored.t);
    run();
  } else {
    const presetName = hash.slice(1);
    setTab('clamp');
    applyPreset(PRESETS[presetName] ? presetName : 'spike');
  }
  // The view scripts load after this one; defer the ready signal so every
  // listener is registered before it fires.
  window.setTimeout(() => {
    document.dispatchEvent(new CustomEvent('sb:ready'));
  }, 0);
}());
