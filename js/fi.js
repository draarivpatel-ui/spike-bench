'use strict';
/*
 * F-I tab. Sweeps injected current through the engine's rheobase bisection
 * and f-I curve, then draws a live phase plane (Izhikevich v-u or the reduced
 * Hodgkin-Huxley V-n portrait) with nullclines and equilibria.
 */
(function () {
  const SB = window.SB;
  const N = SB.N;
  const UI = SB.UI;
  const $ = (id) => document.getElementById(id);

  const dom = {
    maxI: $('f-maxI'),
    stepI: $('f-stepI'),
    stimDur: $('f-stimdur'),
    btnSweep: $('fi-sweep'),
    model: $('p-model'),
    type: $('p-type'),
    current: $('p-current'),
    duration: $('p-dur'),
    btnPortrait: $('p-run'),
    fiCv: $('fi-curve'),
    planeCv: $('phase-plane'),
    readout: $('p-readout'),
    stats: [$('fi-stat-1'), $('fi-stat-2'), $('fi-stat-3'), $('fi-stat-4'), $('fi-stat-5')],
  };

  const COLORS = UI.COLORS;

  function sweepParams() {
    return {
      maxI: Math.max(1, SB.num(dom.maxI, 20)),
      stepI: Math.max(0.25, SB.num(dom.stepI, 2)),
      stimDuration: Math.max(50, SB.num(dom.stimDur, 400)),
    };
  }

  function portraitParams() {
    return {
      model: dom.model.value === 'hh' ? 'hh' : 'izh',
      type: ['RS', 'IB', 'FS', 'CH'].includes(dom.type.value) ? dom.type.value : 'RS',
      I: SB.num(dom.current, 10),
      duration: Math.max(20, SB.num(dom.duration, 200)),
    };
  }

  function collect() {
    return Object.assign({}, sweepParams(), portraitParams());
  }

  function applyParams(p) {
    if (!p) return;
    if (Number.isFinite(p.maxI)) dom.maxI.value = p.maxI;
    if (Number.isFinite(p.stepI)) dom.stepI.value = p.stepI;
    if (Number.isFinite(p.stimDuration)) dom.stimDur.value = p.stimDuration;
    if (p.model === 'hh' || p.model === 'izh') dom.model.value = p.model;
    if (['RS', 'IB', 'FS', 'CH'].includes(p.type)) dom.type.value = p.type;
    if (Number.isFinite(p.I)) dom.current.value = p.I;
    if (Number.isFinite(p.duration)) dom.duration.value = p.duration;
    syncModelFields();
  }
  SB.register('f', collect, applyParams);
  if (SB.pendingState && SB.pendingState.f) applyParams(SB.pendingState.f);

  function syncModelFields() {
    const izh = dom.model.value !== 'hh';
    dom.type.closest('.field').hidden = !izh;
    dom.duration.closest('.field').hidden = false;
  }

  /* ------------------------- F-I sweep ------------------------- */

  function drawSweep(sw) {
    const pts = sw.points.map((p) => ({ x: p.I, y: p.rate }));
    UI.plot(dom.fiCv, [{ x: pts.map((p) => p.x), y: pts.map((p) => p.y), color: COLORS.v, width: 2 }], {
      ylabel: 'Hz', xlabel: 'uA/cm2',
      dots: pts.map((p) => ({ x: p.x, y: p.y })),
      vLine: sw.rheobase !== null && sw.rheobase !== undefined ? sw.rheobase : undefined,
      vLineColor: COLORS.eq,
      vLineLabel: 'rheobase ' + SB.fmt(sw.rheobase, 2),
      yRange: [0, Math.max(1, sw.maxRate * 1.1)],
    });
  }

  function runSweep() {
    let sw;
    try {
      sw = N.fISweep(sweepParams());
    } catch (err) {
      SB.last.sweep = null;
      SB.announce('Sweep failed. ' + err.message);
      return;
    }
    SB.last.sweep = sw;
    drawSweep(sw);
    const first = sw.firstSpikingI;
    dom.stats[0].textContent = SB.fmt(sw.rheobase, 3);
    dom.stats[1].textContent = first === null ? '-' : SB.fmt(first, 1);
    dom.stats[2].textContent = SB.fmt(sw.maxRate, 1);
    document.dispatchEvent(new CustomEvent('sb:session'));
    SB.announce('f-I sweep complete. Rheobase ' + SB.fmt(sw.rheobase, 3) +
      ' microamps per square centimeter, max rate ' + SB.fmt(sw.maxRate, 1) + ' hertz.');
  }

  /* ------------------------- phase portrait ------------------------- */

  let planeAxes = null;
  let planeRange = null;

  /* Equilibria sit where the two nullclines cross. The Izhikevich portrait
   * solves them exactly in the engine; for the reduced HH portrait we find
   * the intersections of the sampled nullcline curves directly. */
  function nullclineCrossings(vNull, nNull) {
    const atV = new Map(nNull.map((p) => [p.V, p.n]));
    const out = [];
    let prev = null;
    for (const p of vNull) {
      const other = atV.get(p.V);
      if (other === undefined) continue;
      const d = p.n - other;
      if (prev && prev.d !== 0 && ((prev.d < 0) !== (d < 0))) {
        const frac = prev.d / (prev.d - d);
        out.push({
          v: prev.p.V + frac * (p.V - prev.p.V),
          u: prev.p.n + frac * (p.n - prev.p.n),
        });
      }
      prev = { p, d };
    }
    return out;
  }

  function drawPortrait(pp) {
    const model = pp.model;
    const xs = pp.trajectory.map((p) => (model === 'izhikevich' ? p.v : p.V));
    const ys = pp.trajectory.map((p) => (model === 'izhikevich' ? p.u : p.n));
    const xMin = Math.min(-95, Math.min(...xs) - 5);
    const xMax = Math.max(45, Math.max(...xs) + 5);
    const yAll = model === 'izhikevich' ? ys : [0, 1];
    const yMin = Math.min(0, Math.min(...yAll) - 1);
    const yMax = Math.max(model === 'izhikevich' ? 15 : 1, Math.max(...yAll) + 1);

    const series = [
      {
        points: pp.trajectory.map((p) => ({
          x: model === 'izhikevich' ? p.v : p.V,
          y: model === 'izhikevich' ? p.u : p.n,
        })),
        color: COLORS.ina, width: 1.4,
      },
      {
        points: pp.vNullcline.map((p) => ({
          x: model === 'izhikevich' ? p.v : p.V,
          y: model === 'izhikevich' ? p.u : p.n,
        })),
        color: COLORS.nullV, width: 1.2, dash: [5, 4],
      },
      {
        points: (pp.uNullcline || pp.nNullcline).map((p) => ({
          x: model === 'izhikevich' ? p.v : p.V,
          y: model === 'izhikevich' ? p.u : p.n,
        })),
        color: COLORS.nullU, width: 1.2, dash: [2, 3],
      },
    ];
    const eqSrc = pp.equilibria
      || nullclineCrossings(pp.vNullcline, pp.nNullcline || []);
    const eqPoints = eqSrc.map((e) => ({ x: e.v, y: e.u, r: 4.5 }));
    planeAxes = UI.plane(dom.planeCv, {
      xMin, xMax, yMin, yMax,
      series, points: eqPoints,
      ylabel: model === 'izhikevich' ? 'u' : 'n',
      xlabel: 'V, mV',
    });
    planeRange = { xMin, xMax, yMin, yMax };

    const label = model === 'izhikevich' ? 'Izhikevich ' + pp.type : 'Hodgkin-Huxley';
    dom.stats[3].textContent = label + ', I=' + SB.fmt(pp.I, 1);
    dom.stats[4].textContent = pp.spikeCount + (pp.isLimitCycle ? ', limit cycle' : ', rest');
    SB.announce('Phase portrait done. ' + label + ' fired ' + pp.spikeCount +
      ' spikes' + (pp.isLimitCycle ? ', a limit cycle.' : ', no limit cycle.'));
  }

  function runPortrait() {
    const p = portraitParams();
    let pp;
    try {
      pp = p.model === 'hh'
        ? N.phasePortraitHH({ amplitude: p.I, duration: p.duration })
        : N.phasePortraitIzh({ I: p.I, type: p.type, duration: p.duration });
    } catch (err) {
      SB.last.portrait = null;
      SB.announce('Phase portrait failed. ' + err.message);
      return;
    }
    SB.last.portrait = pp;
    drawPortrait(pp);
    document.dispatchEvent(new CustomEvent('sb:session'));
  }

  function onPlaneMove(ev) {
    if (!planeAxes || !planeRange || !dom.readout) return;
    const rect = dom.planeCv.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const { m } = planeAxes;
    const w = rect.width;
    const h = rect.height;
    const x = planeRange.xMin +
      (px - m.l) / Math.max(1, w - m.l - m.r) * (planeRange.xMax - planeRange.xMin);
    const y = planeRange.yMin +
      (h - m.b - py) / Math.max(1, h - m.t - m.b) * (planeRange.yMax - planeRange.yMin);
    const pp = SB.last.portrait;
    const yName = pp && pp.model === 'izhikevich' ? 'u' : 'n';
    dom.readout.textContent = 'V ' + x.toFixed(1) + ' mV, ' + yName + ' ' + y.toFixed(3);
  }

  dom.btnSweep.addEventListener('click', () => { runSweep(); SB.pushHash(); });
  dom.btnPortrait.addEventListener('click', () => { runPortrait(); SB.pushHash(); });
  dom.model.addEventListener('change', syncModelFields);
  if (dom.planeCv) {
    dom.planeCv.addEventListener('pointermove', onPlaneMove);
    dom.planeCv.addEventListener('pointerleave', () => {
      if (dom.readout) dom.readout.textContent = '';
    });
  }
  window.addEventListener('resize', () => {
    if (SB.last.sweep) drawSweep(SB.last.sweep);
    if (SB.last.portrait) drawPortrait(SB.last.portrait);
  });
  document.addEventListener('sb:ready', () => {
    syncModelFields();
    runSweep();
    runPortrait();
  });
}());
