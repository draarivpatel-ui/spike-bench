'use strict';
/*
 * Spike Bench browser shell. Drives the same Hodgkin-Huxley engine the node
 * tests cover (src/neuro.js exposes window.SpikeBench), draws the recorded
 * traces and reports the engine's own spike analysis.
 */
(function () {
  const N = window.SpikeBench;
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

  const COLORS = {
    grid: 'rgba(210, 220, 255, 0.09)',
    zero: 'rgba(210, 220, 255, 0.22)',
    axis: 'rgba(210, 220, 255, 0.45)',
    text: '#9aa3c7',
    v: '#ff9d3d',
    ina: '#66d9ff',
    ik: '#ff9d3d',
    stimFill: 'rgba(102, 217, 255, 0.22)',
    stimLine: '#66d9ff',
    window: 'rgba(255, 157, 61, 0.07)',
  };

  let last = null;

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

  function isVC() {
    return dom.protocol.value === 'vclamp';
  }

  function syncFields() {
    const vc = isVC();
    document.querySelectorAll('[data-proto="cc"]').forEach((el) => { el.hidden = vc; });
    document.querySelectorAll('[data-proto="vc"]').forEach((el) => { el.hidden = !vc; });
  }

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
      last = null;
      dom.btnCsv.disabled = true;
      dom.statValues.forEach((el) => { el.textContent = '-'; });
      announce('Simulation failed. ' + err.message);
      return;
    }
    last = tr;
    dom.btnCsv.disabled = false;
    draw(tr);
    report(tr);
  }

  function fmt(v, digits) {
    return Number.isFinite(v) ? v.toFixed(digits) : '-';
  }

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

  function contextFor(cv) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return null;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function extent(series) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const ys of series) {
      for (const y of ys) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }

  function tickFmt(v) {
    const a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  function plot(cv, series, opts) {
    const box = contextFor(cv);
    if (!box) return;
    const { ctx, w, h } = box;
    const m = { l: 58, r: 14, t: 10, b: 24 };
    const t = series[0].x;
    const tMin = t[0];
    const tMax = t[t.length - 1];
    const [yMin, yMax] = extent(series.map((s) => s.y));
    const xAt = (tv) => m.l + (w - m.l - m.r) * (tv - tMin) / (tMax - tMin || 1);
    const yAt = (yv) => h - m.b - (h - m.t - m.b) * (yv - yMin) / (yMax - yMin);

    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px ui-rounded, system-ui, sans-serif';

    if (opts && opts.window) {
      ctx.fillStyle = COLORS.window;
      ctx.fillRect(xAt(opts.window[0]), m.t,
        xAt(opts.window[1]) - xAt(opts.window[0]), h - m.t - m.b);
    }

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
      const yv = yMin + (yMax - yMin) * i / 4;
      const y = yAt(yv);
      ctx.beginPath();
      ctx.moveTo(m.l, y);
      ctx.lineTo(w - m.r, y);
      ctx.stroke();
      ctx.fillText(tickFmt(yv), m.l - 7, y);
    }

    if (yMin < 0 && yMax > 0) {
      ctx.strokeStyle = COLORS.zero;
      ctx.beginPath();
      ctx.moveTo(m.l, yAt(0));
      ctx.lineTo(w - m.r, yAt(0));
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i += 1) {
      const tv = tMin + (tMax - tMin) * i / 4;
      ctx.fillText(tickFmt(tv), xAt(tv), h - m.b + 6);
    }

    if (opts && opts.fillTo !== undefined) {
      const s = series[0];
      ctx.beginPath();
      ctx.moveTo(xAt(t[0]), yAt(opts.fillTo));
      for (let i = 0; i < t.length; i += 1) ctx.lineTo(xAt(t[i]), yAt(s.y[i]));
      ctx.lineTo(xAt(t[t.length - 1]), yAt(opts.fillTo));
      ctx.closePath();
      ctx.fillStyle = COLORS.stimFill;
      ctx.fill();
    }

    for (const s of series) {
      ctx.beginPath();
      for (let i = 0; i < s.x.length; i += 1) {
        const x = xAt(s.x[i]);
        const y = yAt(s.y[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.6;
      ctx.stroke();
    }

    if (opts && opts.dots) {
      ctx.strokeStyle = COLORS.ina;
      ctx.lineWidth = 1.6;
      for (const d of opts.dots) {
        ctx.beginPath();
        ctx.arc(xAt(d.x), yAt(d.y), 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (opts && opts.ylabel) {
      ctx.save();
      ctx.translate(13, m.t + (h - m.t - m.b) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(opts.ylabel, 0, 0);
      ctx.restore();
    }
  }

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

  /* ------------------------- export ------------------------- */

  function exportCsv() {
    if (!last) return;
    const csv = N.traceToCSV(last);
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spike-bench-' + dom.protocol.value + '-trace.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    announce('Trace exported as CSV.');
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

  dom.presets.forEach((b) => {
    b.addEventListener('click', () => applyPreset(b.dataset.preset));
  });
  dom.protocol.addEventListener('change', () => {
    syncFields();
    dom.presets.forEach((b) => b.setAttribute('aria-pressed', 'false'));
    run();
  });
  dom.btnRun.addEventListener('click', run);
  dom.btnCsv.addEventListener('click', exportCsv);
  window.addEventListener('resize', () => { if (last) draw(last); });

  syncFields();
  const hash = window.location.hash.slice(1);
  applyPreset(PRESETS[hash] ? hash : 'spike');
}());
