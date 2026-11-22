# Spike Bench

A computational neuroscience workbench built on a pure JavaScript engine.
Hodgkin-Huxley current clamp and voltage clamp protocols, a plastic STDP
microcircuit sandbox, firing rate tuning curves, phase plane portraits,
SHA-256 verified exports and a self test battery that runs in the page.
No dependencies, no build step, no network access of any kind.

## Engine

`src/neuro.js` runs in Node and in the browser as `window.SpikeBench`.

- Hodgkin-Huxley squid axon model with RK4 integration, current clamp step
  and ramp, voltage clamp, TTX and TEA channel blocks, I-V families,
  reversal potentials and refractory analysis.
- Leaky integrate and fire neuron and a deterministic multisynapse STDP
  microcircuit (`stdpExperiment`) with burst and Poisson presynaptic
  drives, per event weight updates, spike pair records and seeded
  reproducibility.
- Izhikevich phenotypes (RS, IB, FS, CH) plus exact (v, u) nullclines and
  equilibria, and a reduced Hodgkin-Huxley (V, n) phase portrait.
- Firing rate sweep (`fISweep`) combining an f-I curve with bisected
  rheobase and a monotonicity check.
- Pure JavaScript SHA-256, canonical JSON verified documents
  (`verifiedDocument`, `verifyDocument`), and a base64url URL hash state
  codec for bookmarking.
- `runSelfTests`, a 17 check battery covering RK4 step halving
  convergence, STDP LTP and LTD sign symmetry, rheobase monotonicity,
  deterministic seeding, codecs and the phase portrait pipeline.

## Workbench

Open `index.html` in a browser or visit the live workbench at
<https://aariv.me/spike-bench/>. Four tabs share one session:

- **Clamp**: the original workbench. Presets, current and voltage clamp,
  TTX and TEA, spike stats, CSV export.
- **STDP Sandbox**: pick the drive, synapse count, rates, STDP window
  constants and seed; watch every synapse's weight trajectory, the
  delta t versus delta w correlation and the presynaptic raster.
- **F-I and Phase**: sweep injected current for the rheobase and the f-I
  curve, then inspect a live phase portrait with nullclines, equilibria
  and a pointer readout.
- **Export and Tests**: download the session as a checksumed JSON bundle
  or per channel CSVs, copy a bookmark link that restores the whole
  session, and run the self test battery in the page.

## Tests and audit

The suite covers the engine end to end: 317 tests, all passing.

```sh
npm test
```

`tools/browser-audit.mjs` drives a real headless Chromium over the
DevTools protocol with zero dependencies and exercises every tab at
1440x900 and 390x844: console errors, page errors, external requests,
horizontal overflow and per panel screenshots into `audit-out/`.

```sh
npm run audit
```

## Files

- `src/neuro.js`: the engine, shared by Node and the browser.
- `index.html`, `styles.css`: the page shell.
- `js/app.js`: workbench, tabs, shared session, URL hash bookmarking.
- `js/plots.js`: canvas plotting helpers used by every panel.
- `js/stdp.js`: STDP sandbox panel.
- `js/fi.js`: f-I sweep and phase portrait panel.
- `js/lab.js`: verified exports, bookmark link, self tests panel.
- `test/`: the `node --test` suite.
- `tools/browser-audit.mjs`: the dependency free headless audit.

Built by Aariv Patel.
