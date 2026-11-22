'use strict';
/*
 * Spike Bench shared canvas helpers. Every panel draws through the same grid,
 * axes and palette helpers so the workbench stays visually consistent.
 * Exposes window.SBUI.
 */
(function () {
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
    ltp: '#66d9ff',
    ltd: '#ff5d5d',
    mean: '#ff9d3d',
    weight: 'rgba(102, 217, 255, 0.34)',
    nullV: '#ff9d3d',
    nullU: 'rgba(210, 220, 255, 0.5)',
    eq: '#c9f27a',
    raster: '#66d9ff',
    rasterPost: '#ff9d3d',
    curve: '#c9f27a',
  };

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
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a === 0) return '0';
    return v.toPrecision(2);
  }

  function drawAxes(box, xMin, xMax, yMin, yMax, opts) {
    const { ctx, w, h } = box;
    const m = (opts && opts.margin) || { l: 58, r: 14, t: 10, b: 30 };
    const xAt = (v) => m.l + (w - m.l - m.r) * (v - xMin) / (xMax - xMin || 1);
    const yAt = (v) => h - m.b - (h - m.t - m.b) * (v - yMin) / (yMax - yMin || 1);
    ctx.font = '11px ui-rounded, system-ui, sans-serif';
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = (opts && opts.yTicks) || 4;
    for (let i = 0; i <= yTicks; i += 1) {
      const yv = yMin + (yMax - yMin) * i / yTicks;
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
    ctx.strokeStyle = COLORS.grid;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = (opts && opts.xTicks) || 4;
    for (let i = 0; i <= xTicks; i += 1) {
      const xv = xMin + (xMax - xMin) * i / xTicks;
      const x = xAt(xv);
      ctx.beginPath();
      ctx.moveTo(x, h - m.b);
      ctx.lineTo(x, m.t);
      ctx.stroke();
      ctx.fillText(tickFmt(xv), x, h - m.b + 6);
    }
    if (xMin < 0 && xMax > 0) {
      ctx.strokeStyle = COLORS.zero;
      ctx.beginPath();
      ctx.moveTo(xAt(0), m.t);
      ctx.lineTo(xAt(0), h - m.b);
      ctx.stroke();
    }
    return { xAt, yAt, m };
  }

  function axisLabel(box, opts) {
    const { ctx, w, h } = box;
    const m = opts.margin || { l: 58, r: 14, t: 10, b: 30 };
    if (opts.ylabel) {
      ctx.save();
      ctx.translate(13, m.t + (h - m.t - m.b) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(opts.ylabel, 0, 0);
      ctx.restore();
    }
    if (opts.xlabel) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(opts.xlabel, w - m.r, h - m.b + 19);
    }
  }

  /* Time series line plot, same look as the original workbench scope. */
  function plot(cv, series, opts) {
    const box = contextFor(cv);
    if (!box || !series.length || !series[0].x.length) return null;
    const { ctx, w, h } = box;
    const m = { l: 58, r: 14, t: 10, b: 30 };
    const t = series[0].x;
    const xMin = (opts && opts.xMin !== undefined) ? opts.xMin : t[0];
    const xMax = (opts && opts.xMax !== undefined) ? opts.xMax : t[t.length - 1];
    const [yMin, yMax] = (opts && opts.yRange) || extent(series.map((s) => s.y));
    ctx.clearRect(0, 0, w, h);
    const ax = drawAxes(box, xMin, xMax, yMin, yMax,
      Object.assign({}, opts, { margin: m }));

    if (opts && opts.window) {
      ctx.fillStyle = COLORS.window;
      ctx.fillRect(ax.xAt(opts.window[0]), m.t,
        ax.xAt(opts.window[1]) - ax.xAt(opts.window[0]), h - m.t - m.b);
    }

    if (opts && opts.fillTo !== undefined) {
      const s = series[0];
      ctx.beginPath();
      ctx.moveTo(ax.xAt(t[0]), ax.yAt(opts.fillTo));
      for (let i = 0; i < t.length; i += 1) {
        ctx.lineTo(ax.xAt(t[i]), ax.yAt(s.y[i]));
      }
      ctx.lineTo(ax.xAt(t[t.length - 1]), ax.yAt(opts.fillTo));
      ctx.closePath();
      ctx.fillStyle = COLORS.stimFill;
      ctx.fill();
    }

    for (const s of series) {
      ctx.beginPath();
      for (let i = 0; i < s.x.length; i += 1) {
        const x = ax.xAt(s.x[i]);
        const y = ax.yAt(s.y[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.6;
      if (s.dash) ctx.setLineDash(s.dash);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (opts && opts.vLine !== undefined) {
      ctx.strokeStyle = opts.vLineColor || COLORS.eq;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(ax.xAt(opts.vLine), m.t);
      ctx.lineTo(ax.xAt(opts.vLine), h - m.b);
      ctx.stroke();
      ctx.setLineDash([]);
      if (opts.vLineLabel) {
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(opts.vLineLabel, ax.xAt(opts.vLine) + 5, m.t + 4);
      }
    }

    if (opts && opts.dots) {
      ctx.strokeStyle = COLORS.ina;
      ctx.lineWidth = 1.6;
      for (const d of opts.dots) {
        ctx.beginPath();
        ctx.arc(ax.xAt(d.x), ax.yAt(d.y), 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    axisLabel(box, Object.assign({ margin: m }, opts));
    return ax;
  }

  /* Generic x-y scatter with optional color per point. */
  function scatter(cv, points, opts) {
    const box = contextFor(cv);
    if (!box) return null;
    const { ctx } = box;
    const m = { l: 58, r: 14, t: 10, b: 30 };
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = opts && opts.xMin !== undefined ? opts.xMin : Math.min(...xs, 0);
    const xMax = opts && opts.xMax !== undefined ? opts.xMax : Math.max(...xs, 1);
    const [yMin, yMax] = (opts && opts.yRange) || extent([ys]);
    const ax = drawAxes(box, xMin, xMax, yMin, yMax,
      Object.assign({}, opts, { margin: m }));
    if (opts && opts.curve) {
      ctx.beginPath();
      opts.curve.forEach((p, i) => {
        if (i === 0) ctx.moveTo(ax.xAt(p.x), ax.yAt(p.y));
        else ctx.lineTo(ax.xAt(p.x), ax.yAt(p.y));
      });
      ctx.strokeStyle = opts.curveColor || COLORS.curve;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(ax.xAt(p.x), ax.yAt(p.y), p.r || 2.4, 0, Math.PI * 2);
      ctx.fillStyle = p.color || COLORS.ina;
      ctx.globalAlpha = p.alpha === undefined ? 0.75 : p.alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    axisLabel(box, Object.assign({ margin: m }, opts));
    return ax;
  }

  /* Spike raster: one row per unit, dots at event times. */
  function raster(cv, events, opts) {
    const box = contextFor(cv);
    if (!box) return null;
    const { ctx, w, h } = box;
    const m = { l: 40, r: 14, t: 10, b: 30 };
    const rows = opts.rows;
    const xMin = opts.xMin;
    const xMax = opts.xMax;
    const ax = drawAxes(box, xMin, xMax, -0.5, rows - 0.5,
      { margin: m, yTicks: Math.min(rows, 8) });
    for (const e of events) {
      const y = ax.yAt(e.row);
      ctx.beginPath();
      ctx.arc(ax.xAt(e.t), y, e.r || 1.8, 0, Math.PI * 2);
      ctx.fillStyle = e.color || COLORS.raster;
      ctx.globalAlpha = e.alpha === undefined ? 0.8 : e.alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    axisLabel(box, Object.assign({ margin: m }, opts));
    return ax;
  }

  /* Free plane plot for phase portraits: arbitrary x and y extents. */
  function plane(cv, opts) {
    const box = contextFor(cv);
    if (!box) return null;
    const { ctx } = box;
    const m = { l: 58, r: 14, t: 10, b: 30 };
    const ax = drawAxes(box, opts.xMin, opts.xMax, opts.yMin, opts.yMax,
      { margin: m });
    for (const s of opts.series || []) {
      ctx.beginPath();
      s.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(ax.xAt(p.x), ax.yAt(p.y));
        else ctx.lineTo(ax.xAt(p.x), ax.yAt(p.y));
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.6;
      if (s.dash) ctx.setLineDash(s.dash);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of opts.points || []) {
      ctx.beginPath();
      ctx.arc(ax.xAt(p.x), ax.yAt(p.y), p.r || 4, 0, Math.PI * 2);
      if (p.fill === false) {
        ctx.strokeStyle = p.color || COLORS.eq;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color || COLORS.eq;
        ctx.fill();
      }
    }
    axisLabel(box, Object.assign({ margin: m }, opts));
    return ax;
  }

  window.SBUI = {
    COLORS, contextFor, extent, tickFmt, plot, scatter, raster, plane,
  };
}());
