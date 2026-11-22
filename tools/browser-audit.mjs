#!/usr/bin/env node
'use strict';
/*
 * Spike Bench headless browser audit.
 *
 * Drives a real Chromium (Playwright's cached chrome-headless-shell) over the
 * DevTools protocol using only Node built ins: child_process for the launch
 * and the global WebSocket for CDP. No dependencies, no network beyond
 * localhost CDP. Checks console errors, page errors, external requests,
 * horizontal overflow and exercises every workbench feature at two viewports.
 *
 * Usage: node tools/browser-audit.mjs [--out <dir>]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = path.resolve(__dirname, '..');
const SHELL = process.env.CHROME_HEADLESS_SHELL
  || path.join(os.homedir(), 'Library/Caches/ms-playwright',
    'chromium_headless_shell-1223', 'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell');

const outIdx = process.argv.indexOf('--out');
const OUT_DIR = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1])
  : path.join(REPO, 'audit-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false, dsf: 1 },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true, dsf: 2 },
];

const results = [];
const failures = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  if (!cond) failures.push(name + (detail ? ' (' + detail + ')' : ''));
}

/* ------------------------------ CDP client ------------------------------ */

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    this.externalRequests = [];
    this.failedRequests = [];
    this.open = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } else {
        this.onEvent(msg);
      }
    });
  }

  onEvent(msg) {
    for (const fn of this.listeners) fn(msg);
  }

  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitFor(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((f) => f !== fn);
        reject(new Error('timeout waiting for ' + method));
      }, timeoutMs || 15000);
      const fn = (msg) => {
        if (msg.method === method
            && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((f) => f !== fn);
          resolve(msg.params);
        }
      };
      this.listeners.push(fn);
    });
  }

  close() { try { this.ws.close(); } catch (e) { /* noop */ } }
}

async function evaluate(cdp, sessionId, expression, awaitPromise) {
  const res = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: !!awaitPromise,
  }, sessionId);
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails;
    const desc = ex.exception && ex.exception.description
      ? ex.exception.description : ex.text;
    throw new Error('evaluate failed: ' + desc);
  }
  return res.result && res.result.value;
}

/* ------------------------------ audit ------------------------------ */

async function auditViewport(vp) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-audit-'));
  const args = [
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    'about:blank',
  ];
  const proc = spawn(SHELL, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    proc.on('exit', () => reject(new Error('chrome exited before DevTools URL')));
    setTimeout(() => reject(new Error('no DevTools URL within 15s')), 15000);
  });

  const cdp = new CDP(wsUrl);
  await cdp.open;
  try {
    const { targetId } = await cdp.send('Target.createTarget',
      { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget',
      { targetId, flatten: true });

    // Wire telemetry before navigating.
    cdp.listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled'
          && msg.params.type === 'error') {
        cdp.consoleErrors.push(msg.params.args.map(
          (a) => a.value !== undefined ? String(a.value) : a.description || '?')
          .join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const ex = msg.params.exceptionDetails;
        cdp.pageErrors.push(
          (ex.exception && (ex.exception.description || ex.exception.value))
          || ex.text);
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params.request.url;
        if (!url.startsWith('file://') && !url.startsWith('data:')
            && !url.startsWith('devtools://')) {
          cdp.externalRequests.push(url);
        }
      }
      if (msg.method === 'Network.loadingFailed'
          && !msg.params.canceled) {
        cdp.failedRequests.push(msg.params.errorText || 'loading failed');
      }
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    // Export clicks create real blob downloads; deny them at browser level so
    // nothing is written while the code path still runs.
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' })
      .catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height,
      deviceScaleFactor: vp.dsf, mobile: vp.mobile,
    }, sessionId);

    const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 15000);
    await cdp.send('Page.navigate', {
      url: pathToFileURL(path.join(REPO, 'index.html')).href,
    }, sessionId);
    await loaded;
    // sb:ready defers one macrotask, the engine runs synchronously after.
    await new Promise((r) => setTimeout(r, 400));

    async function snap(name) {
      const shot = await cdp.send('Page.captureScreenshot',
        { format: 'png' }, sessionId);
      const p = path.join(OUT_DIR,
        'spike-bench-' + vp.name + '-' + name + '.png');
      fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
      return p;
    }

    const tag = '[' + vp.name + ']';

    const boot = await evaluate(cdp, sessionId, `(() => ({
      sb: !!window.SB,
      spikes: document.getElementById('stat-1').textContent,
      tab: document.getElementById('tab-clamp').hidden === false,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      docH: document.documentElement.scrollHeight,
    }))()`);
    check(tag + ' engine booted with workbench run', boot.sb && boot.spikes !== '0' && boot.spikes !== '-',
      'stat-1=' + boot.spikes);
    check(tag + ' no horizontal overflow', boot.scrollW <= boot.innerW,
      boot.scrollW + ' vs ' + boot.innerW);
    await snap('clamp');

    // STDP sandbox: switch tab, run, verify session data and canvases.
    await evaluate(cdp, sessionId,
      `document.querySelector('[data-tab="stdp"]').click()`);
    await evaluate(cdp, sessionId,
      `document.getElementById('s-run').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const stdp = await evaluate(cdp, sessionId, `(() => ({
      panel: !document.getElementById('tab-stdp').hidden,
      has: !!SB.last.stdp,
      post: document.getElementById('s-stat-1').textContent,
      ltp: document.getElementById('s-stat-2').textContent,
      ltd: document.getElementById('s-stat-3').textContent,
      pairs: SB.last.stdp ? SB.last.stdp.pairs.length : 0,
      traj: SB.last.stdp ? SB.last.stdp.weights.trajectory.length : 0,
      wPaint: (() => {
        const c = document.getElementById('stdp-weights');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
        return false;
      })(),
    }))()`);
    check(tag + ' STDP sandbox ran with recorded pairs',
      stdp.panel && stdp.has && stdp.pairs > 0,
      'pairs=' + stdp.pairs + ' post=' + stdp.post);
    check(tag + ' STDP charts painted', stdp.wPaint && stdp.traj > 10,
      'traj=' + stdp.traj);
    check(tag + ' STDP stats populated',
      stdp.post !== '-' && stdp.ltp !== '-' && stdp.ltd !== '-');
    await snap('stdp');

    // F-I sweep + phase portrait.
    await evaluate(cdp, sessionId,
      `document.querySelector('[data-tab="fi"]').click()`);
    await evaluate(cdp, sessionId,
      `document.getElementById('fi-sweep').click()`);
    await new Promise((r) => setTimeout(r, 2500));
    await evaluate(cdp, sessionId,
      `document.getElementById('p-run').click()`);
    await new Promise((r) => setTimeout(r, 600));
    const fi = await evaluate(cdp, sessionId, `(() => ({
      panel: !document.getElementById('tab-fi').hidden,
      sweep: !!SB.last.sweep,
      rheo: document.getElementById('fi-stat-1').textContent,
      portrait: !!SB.last.portrait,
      spikes: document.getElementById('fi-stat-5').textContent,
      lc: SB.last.portrait ? SB.last.portrait.isLimitCycle : false,
      planePaint: (() => {
        const c = document.getElementById('phase-plane');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
        return false;
      })(),
    }))()`);
    check(tag + ' f-I sweep converged with rheobase',
      fi.panel && fi.sweep && fi.rheo !== '-', 'rheo=' + fi.rheo);
    check(tag + ' phase portrait rendered limit cycle',
      fi.portrait && fi.planePaint, 'spikes=' + fi.spikes + ' lc=' + fi.lc);

    // Phase plane interactivity: pointer move over the canvas.
    await evaluate(cdp, sessionId, `(() => {
      const c = document.getElementById('phase-plane');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new PointerEvent('pointermove',
        { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      return true;
    })()`);
    const ro = await evaluate(cdp, sessionId,
      `document.getElementById('p-readout').textContent`);
    check(tag + ' phase plane pointer readout live', /V\s/.test(ro), ro);

    // Hodgkin-Huxley phase portrait variant.
    await evaluate(cdp, sessionId, `(() => {
      document.getElementById('p-model').value = 'hh';
      document.getElementById('p-model').dispatchEvent(new Event('change'));
      document.getElementById('p-run').click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    const hhp = await evaluate(cdp, sessionId, `(() => ({
      model: SB.last.portrait && SB.last.portrait.model,
      lc: SB.last.portrait && SB.last.portrait.isLimitCycle,
    }))()`);
    check(tag + ' HH phase portrait runs too',
      hhp.model === 'hodgkin-huxley' && hhp.lc === true, JSON.stringify(hhp));
    await snap('fi');

    // Exports: click every export button and read the checksum line.
    await evaluate(cdp, sessionId,
      `document.querySelector('[data-tab="lab"]').click()`);
    await new Promise((r) => setTimeout(r, 150));
    const labState = await evaluate(cdp, sessionId, `(() => ({
      panel: !document.getElementById('tab-lab').hidden,
      exports: !document.getElementById('x-exports').hidden,
      json: !document.getElementById('x-json').disabled,
      csv: !document.getElementById('x-csv').disabled,
      raster: !document.getElementById('x-raster').disabled,
      weights: !document.getElementById('x-weights').disabled,
      fiCsv: !document.getElementById('x-fi').disabled,
    }))()`);
    check(tag + ' export buttons armed from session data',
      labState.panel && labState.exports && labState.json
      && labState.csv && labState.raster && labState.weights && labState.fiCsv,
      JSON.stringify(labState));

    for (const id of ['x-json', 'x-csv', 'x-raster', 'x-weights', 'x-fi']) {
      await evaluate(cdp, sessionId,
        `document.getElementById('${id}').click()`);
    }
    await new Promise((r) => setTimeout(r, 200));
    const sum = await evaluate(cdp, sessionId,
      `document.getElementById('x-checksum-value').textContent`);
    check(tag + ' SHA-256 shown after export click',
      /SHA-256 [0-9a-f]{64}/.test(sum), sum.slice(0, 90));

    // Verify the exported document verifies inside the page engine.
    const verify = await evaluate(cdp, sessionId, `(() => {
      const rep = SB.N.exportSpikeReport({ label: 'audit', raster: [] });
      return SB.N.verifyDocument(rep.json);
    })()`);
    check(tag + ' verified document round trip', verify.ok === true);

    // Bookmark link updates the URL hash with restorable state.
    await evaluate(cdp, sessionId,
      `document.getElementById('x-bookmark').click()`);
    await new Promise((r) => setTimeout(r, 300));
    const hashState = await evaluate(cdp, sessionId, `(() => ({
      hash: location.hash,
      decoded: SB.N.stateFromHash(location.hash),
    }))()`);
    check(tag + ' bookmark hash encodes restorable state',
      hashState.hash.startsWith('#s1.') && !!hashState.decoded,
      hashState.hash.slice(0, 40));

    // Self tests: run the whole battery, wait for the summary.
    await evaluate(cdp, sessionId,
      `document.getElementById('x-selftest').click()`);
    await new Promise((r) => setTimeout(r, 4000));
    const st = await evaluate(cdp, sessionId, `(() => ({
      summary: document.getElementById('x-summary').textContent,
      rows: document.querySelectorAll('.selftest-row').length,
      fails: document.querySelectorAll('.selftest-row.fail').length,
    }))()`);
    check(tag + ' self test battery all pass',
      st.rows >= 15 && st.fails === 0, st.summary);

    // URL hash restore: reload with the bookmark hash and confirm the tab.
    // A hash only change stays in the same document, so go through
    // about:blank first to force a real load event.
    await cdp.send('Page.navigate', { url: 'about:blank' }, sessionId);
    await new Promise((r) => setTimeout(r, 250));
    const reloaded = cdp.waitFor('Page.loadEventFired', sessionId, 15000);
    await cdp.send('Page.navigate', {
      url: pathToFileURL(path.join(REPO, 'index.html')).href + hashState.hash,
    }, sessionId);
    await reloaded;
    await new Promise((r) => setTimeout(r, 400));
    const back = await evaluate(cdp, sessionId, `(() => ({
      tab: SB.tab,
      panel: !document.getElementById('tab-' + SB.tab).hidden,
      spikes: document.getElementById('stat-1').textContent,
    }))()`);
    check(tag + ' hash restore selects bookmarked tab and reruns',
      back.tab === 'lab' && back.panel && back.spikes !== '-',
      JSON.stringify(back));

    // Screenshot per viewport for a human look.
    const shotPath = await snap('lab');
    check(tag + ' screenshot captured', fs.statSync(shotPath).size > 10000,
      shotPath);

    check(tag + ' zero console errors', cdp.consoleErrors.length === 0,
      cdp.consoleErrors.slice(0, 3).join(' | '));
    check(tag + ' zero uncaught page errors', cdp.pageErrors.length === 0,
      cdp.pageErrors.slice(0, 3).join(' | '));
    check(tag + ' zero external requests', cdp.externalRequests.length === 0,
      cdp.externalRequests.slice(0, 3).join(' | '));
    check(tag + ' zero failed requests', cdp.failedRequests.length === 0,
      cdp.failedRequests.slice(0, 3).join(' | '));
    const overflow = await evaluate(cdp, sessionId, `(() => {
      const d = document.documentElement;
      return { scroll: d.scrollWidth, inner: window.innerWidth,
        bodyScroll: document.body ? document.body.scrollWidth : 0 };
    })()`);
    check(tag + ' no horizontal overflow at end',
      overflow.scroll <= overflow.inner && overflow.bodyScroll <= overflow.inner,
      JSON.stringify(overflow));
  } finally {
    cdp.close();
    proc.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(SHELL)) {
    console.error('chrome-headless-shell not found at ' + SHELL);
    process.exit(2);
  }
  for (const vp of VIEWPORTS) {
    try {
      await auditViewport(vp);
    } catch (err) {
      check('[' + vp.name + '] audit ran to completion', false, err.message);
    }
  }
  console.log('\n=== Spike Bench browser audit ===');
  results.forEach((r) => {
    console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name +
      (r.detail ? '  -- ' + r.detail : ''));
  });
  const pass = results.filter((r) => r.ok).length;
  console.log('\n' + pass + '/' + results.length + ' checks passed');
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('audit crashed:', err);
  process.exit(1);
});
