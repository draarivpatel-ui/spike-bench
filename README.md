# Spike Bench

A patch-clamp workbench built on a pure JavaScript engine for computational
neuroscience. Hodgkin-Huxley current clamp and voltage clamp protocols,
spike shape analysis, STDP, Izhikevich networks, power spectra, CSV and
JSON export. No dependencies, no build step.

## Files

- `src/neuro.js`: the engine. Runs in Node and in the browser as
  `window.SpikeBench`.
- `index.html`, `styles.css`, `js/app.js`: the browser workbench, a thin
  shell that drives the same engine the tests cover.
- `test/neuro.test.js`: the engine test suite.

## Use

Open `index.html` in a browser, or visit the live workbench at
<https://aariv.me/spike-bench/>.

Run the tests with Node:

```sh
node --test test/
```

Built by Aariv Patel.
