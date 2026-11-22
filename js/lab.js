'use strict';
/*
 * Lab tab. One click verified exports (JSON session bundle plus per channel
 * CSVs, each with a pure JS SHA-256 checksum), URL hash bookmarking and the
 * in page self test battery.
 */
(function () {
  const SB = window.SB;
  const N = SB.N;
  const $ = (id) => document.getElementById(id);

  const dom = {
    btnJson: $('x-json'),
    btnCsv: $('x-csv'),
    btnRaster: $('x-raster'),
    btnWeights: $('x-weights'),
    btnFi: $('x-fi'),
    btnBookmark: $('x-bookmark'),
    btnSelf: $('x-selftest'),
    checksum: $('x-checksum'),
    checksumValue: $('x-checksum-value'),
    results: $('x-results'),
    summary: $('x-summary'),
    exports: $('x-exports'),
  };

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function showChecksum(name, text) {
    const hex = N.checksum(text);
    dom.checksum.hidden = false;
    dom.checksumValue.textContent = name + ' SHA-256 ' + hex;
    return hex;
  }

  function buildBundle() {
    const sections = { label: 'spike-bench-session', meta: { tab: SB.tab } };
    if (SB.last.trace) sections.trace = SB.last.trace;
    if (SB.last.stdp) {
      const exp = SB.last.stdp;
      sections.raster = exp.preSpikes.map((s) => ({
        t: s.t, neuron: s.neuron, type: 'pre',
      })).concat(exp.postSpikes.map((t) => ({
        t, neuron: exp.params.nPre, type: 'post',
      })));
      sections.weights = {
        initial: exp.weights.initial,
        final: exp.weights.final,
        stats: exp.stats,
      };
      sections.pairs = exp.pairs;
    }
    if (SB.last.sweep) sections.fiCurve = SB.last.sweep;
    return N.exportSpikeReport(sections);
  }

  function sessionHasData() {
    return !!(SB.last.trace || SB.last.stdp || SB.last.sweep);
  }

  function syncExportButtons() {
    const any = sessionHasData();
    dom.btnJson.disabled = !any;
    dom.btnCsv.disabled = !SB.last.trace;
    dom.btnRaster.disabled = !SB.last.stdp;
    dom.btnWeights.disabled = !SB.last.stdp;
    dom.btnFi.disabled = !SB.last.sweep;
    dom.exports.hidden = false;
  }

  function exportJson() {
    if (!sessionHasData()) return;
    const rep = buildBundle();
    download('spike-bench-session.json', rep.json, 'application/json');
    showChecksum('session.json', rep.json);
    SB.announce('Verified session JSON exported. Payload checksum ' +
      rep.payloadChecksum.slice(0, 16) + '...');
  }

  function exportTraceCsv() {
    if (!SB.last.trace) return;
    const csv = N.traceToCSV(SB.last.trace);
    download('spike-bench-trace.csv', csv, 'text/csv');
    showChecksum('trace.csv', csv);
    SB.announce('Membrane trace CSV exported with checksum.');
  }

  function exportRasterCsv() {
    if (!SB.last.stdp) return;
    const exp = SB.last.stdp;
    const raster = exp.preSpikes.map((s) => ({
      t: s.t, neuron: s.neuron, type: 'pre',
    })).concat(exp.postSpikes.map((t) => ({
      t, neuron: exp.params.nPre, type: 'post',
    })));
    const csv = N.rasterToCSV(raster);
    download('spike-bench-raster.csv', csv, 'text/csv');
    showChecksum('raster.csv', csv);
    SB.announce('Spike raster CSV exported with checksum.');
  }

  function exportWeightsCsv() {
    if (!SB.last.stdp) return;
    const exp = SB.last.stdp;
    const lines = ['synapse,w_initial,w_final,delta_w'];
    for (let j = 0; j < exp.params.nPre; j += 1) {
      lines.push([j, exp.weights.initial[j], exp.weights.final[j],
        exp.weights.final[j] - exp.weights.initial[j]].join(','));
    }
    const csv = lines.join('\n') + '\n';
    download('spike-bench-weights.csv', csv, 'text/csv');
    showChecksum('weights.csv', csv);
    SB.announce('Synaptic weights CSV exported with checksum.');
  }

  function exportFiCsv() {
    if (!SB.last.sweep) return;
    const csv = N.fIToCSV(SB.last.sweep);
    download('spike-bench-fi.csv', csv, 'text/csv');
    showChecksum('fi.csv', csv);
    SB.announce('f-I curve CSV exported with checksum.');
  }

  function bookmark() {
    const hash = SB.pushHash();
    if (!hash) {
      SB.announce('Bookmark encoding failed.');
      return;
    }
    const url = window.location.href.split('#')[0] + hash;
    const done = () => {
      dom.checksum.hidden = false;
      dom.checksumValue.textContent = 'Bookmark ' + url;
      SB.announce('Bookmark link ready in the address bar.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      done();
    }
  }

  function runSelfTests() {
    dom.btnSelf.disabled = true;
    dom.results.innerHTML = '';
    dom.summary.textContent = 'Running self tests...';
    window.setTimeout(() => {
      let res;
      try {
        res = N.runSelfTests();
      } catch (err) {
        dom.summary.textContent = 'Self test battery crashed: ' + err.message;
        dom.btnSelf.disabled = false;
        return;
      }
      const frag = document.createDocumentFragment();
      res.results.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'selftest-row ' + (r.ok ? 'pass' : 'fail');
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = r.ok ? 'PASS' : 'FAIL';
        const name = document.createElement('span');
        name.className = 'selftest-name';
        name.textContent = r.name;
        const detail = document.createElement('span');
        detail.className = 'selftest-detail';
        detail.textContent = r.detail;
        const ms = document.createElement('span');
        ms.className = 'selftest-ms';
        ms.textContent = r.ms + ' ms';
        li.append(chip, name, detail, ms);
        frag.appendChild(li);
      });
      dom.results.appendChild(frag);
      dom.summary.textContent = res.pass + ' of ' + res.total +
        ' checks passed' + (res.fail ? ', ' + res.fail + ' failed' : '');
      dom.summary.className = res.ok ? 'selftest-summary pass' : 'selftest-summary fail';
      dom.btnSelf.disabled = false;
      SB.announce('Self tests finished. ' + res.pass + ' of ' + res.total + ' passed.');
    }, 30);
  }

  dom.btnJson.addEventListener('click', exportJson);
  dom.btnCsv.addEventListener('click', exportTraceCsv);
  dom.btnRaster.addEventListener('click', exportRasterCsv);
  dom.btnWeights.addEventListener('click', exportWeightsCsv);
  dom.btnFi.addEventListener('click', exportFiCsv);
  dom.btnBookmark.addEventListener('click', bookmark);
  dom.btnSelf.addEventListener('click', runSelfTests);
  document.addEventListener('sb:session', syncExportButtons);
  document.addEventListener('sb:ready', syncExportButtons);
  document.addEventListener('sb:tab', (e) => {
    if (e.detail === 'lab') syncExportButtons();
  });
  syncExportButtons();
}());
