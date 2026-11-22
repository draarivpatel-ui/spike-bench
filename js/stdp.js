'use strict';
/*
 * STDP sandbox tab. Runs a multisynapse plastic microcircuit from
 * window.SpikeBench.stdpExperiment and draws the weight trajectories, the
 * spike timing correlation and the input raster.
 */
(function () {
  const SB = window.SB;
  const N = SB.N;
  const UI = SB.UI;
  const $ = (id) => document.getElementById(id);

  const dom = {
    drive: $('s-drive'),
    postModel: $('s-post'),
    nPre: $('s-npre'),
    rate: $('s-rate'),
    duration: $('s-dur'),
    aPlus: $('s-aplus'),
    aMinus: $('s-aminus'),
    tauPlus: $('s-tauplus'),
    tauMinus: $('s-tauminus'),
    seed: $('s-seed'),
    btnRun: $('s-run'),
    weightsCv: $('stdp-weights'),
    corrCv: $('stdp-corr'),
    rasterCv: $('stdp-raster'),
    stats: [$('s-stat-1'), $('s-stat-2'), $('s-stat-3'), $('s-stat-4'), $('s-stat-5')],
  };

  const COLORS = UI.COLORS;

  function params() {
    return {
      drive: dom.drive.value === 'poisson' ? 'poisson' : 'burst',
      postModel: dom.postModel.value === 'hh' ? 'hh' : 'lif',
      nPre: Math.max(1, Math.round(SB.num(dom.nPre, 16))),
      rate: Math.max(0.1, SB.num(dom.rate, 20)),
      duration: Math.max(50, SB.num(dom.duration, 1200)),
      seed: Math.round(SB.num(dom.seed, 20261121)),
      stdp: {
        aPlus: Math.max(0, SB.num(dom.aPlus, 0.01)),
        aMinus: Math.max(0, SB.num(dom.aMinus, 0.0105)),
        tauPlus: Math.max(0.5, SB.num(dom.tauPlus, 20)),
        tauMinus: Math.max(0.5, SB.num(dom.tauMinus, 20)),
      },
    };
  }

  function applyParams(p) {
    if (!p) return;
    dom.drive.value = p.drive === 'poisson' ? 'poisson' : 'burst';
    dom.postModel.value = p.postModel === 'hh' ? 'hh' : 'lif';
    if (Number.isFinite(p.nPre)) dom.nPre.value = p.nPre;
    if (Number.isFinite(p.rate)) dom.rate.value = p.rate;
    if (Number.isFinite(p.duration)) dom.duration.value = p.duration;
    if (Number.isFinite(p.seed)) dom.seed.value = p.seed;
    if (p.stdp) {
      if (Number.isFinite(p.stdp.aPlus)) dom.aPlus.value = p.stdp.aPlus;
      if (Number.isFinite(p.stdp.aMinus)) dom.aMinus.value = p.stdp.aMinus;
      if (Number.isFinite(p.stdp.tauPlus)) dom.tauPlus.value = p.stdp.tauPlus;
      if (Number.isFinite(p.stdp.tauMinus)) dom.tauMinus.value = p.stdp.tauMinus;
    }
  }
  SB.register('s', params, applyParams);
  if (SB.pendingState && SB.pendingState.s) applyParams(SB.pendingState.s);

  function weightSeries(res) {
    const traj = res.weights.trajectory;
    const nPre = res.params.nPre;
    const series = [];
    for (let j = 0; j < nPre; j += 1) {
      series.push({
        x: traj.map((p) => p.t),
        y: traj.map((p) => p.weights[j]),
        color: COLORS.weight,
        width: 1,
      });
    }
    const mean = res.weights.meanTrajectory;
    series.push({
      x: mean.map((p) => p.t),
      y: mean.map((p) => p.mean),
      color: COLORS.mean,
      width: 2.4,
    });
    return series;
  }

  function draw(res) {
    const stdp = res.params.stdp;
    UI.plot(dom.weightsCv, weightSeries(res), {
      ylabel: 'weight', xlabel: 'ms',
    });

    const pts = res.pairs.map((p) => ({
      x: p.deltaT, y: p.dw,
      color: p.deltaT >= 0 ? COLORS.ltp : COLORS.ltd,
      alpha: 0.65,
    }));
    const curve = N.stdpCurve({
      min: -stdp.window, max: stdp.window, step: stdp.window / 60,
    }).map((p) => ({ x: p.deltaT, y: p.dw }));
    UI.scatter(dom.corrCv, pts, {
      xMin: -stdp.window, xMax: stdp.window,
      curve, ylabel: 'dw', xlabel: 'dt = tPost - tPre, ms',
    });

    const events = res.preSpikes.map((s) => ({ t: s.t, row: s.neuron }));
    res.postSpikes.forEach((t) => {
      events.push({ t, row: res.params.nPre, color: COLORS.rasterPost, r: 3 });
    });
    UI.raster(dom.rasterCv, events, {
      rows: res.params.nPre + 1,
      xMin: 0, xMax: res.params.duration,
      ylabel: 'synapse', xlabel: 'ms',
    });
  }

  function report(res) {
    const s = res.stats;
    const vals = [
      String(s.postSpikeCount),
      String(s.ltpEvents),
      String(s.ltdEvents),
      SB.fmt(s.meanWeightInitial, 3) + ' > ' + SB.fmt(s.meanWeightFinal, 3),
      SB.fmt(s.deltaMeanWeight, 4),
    ];
    dom.stats.forEach((el, i) => { el.textContent = vals[i]; });
    SB.announce('STDP run complete. ' + s.ltpEvents + ' LTP and ' +
      s.ltdEvents + ' LTD pairings, mean weight moved ' +
      SB.fmt(s.deltaMeanWeight, 4) + '.');
  }

  function run() {
    let res;
    try {
      res = N.stdpExperiment(params());
    } catch (err) {
      SB.last.stdp = null;
      SB.announce('STDP run failed. ' + err.message);
      return;
    }
    SB.last.stdp = res;
    draw(res);
    report(res);
    document.dispatchEvent(new CustomEvent('sb:session'));
  }

  dom.btnRun.addEventListener('click', () => { run(); SB.pushHash(); });
  window.addEventListener('resize', () => { if (SB.last.stdp) draw(SB.last.stdp); });
  document.addEventListener('sb:ready', run);
}());
