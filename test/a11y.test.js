'use strict';

/*
 * Static accessibility contracts for the page shell. The tab strip and the
 * labelled control groups are checked against their source markup so an
 * invalid ARIA attribute cannot slip back in without a failing test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');

function tags(source) {
  return [...source.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)]
    .map((match) => ({ tag: match[1].toLowerCase(), attrs: match[2], raw: match[0] }));
}

test('tabs are a real tablist with four role=tab buttons', () => {
  assert.match(html, /<div class="tabs" role="tablist" aria-label="Workbench sections">/);
  const tabs = tags(html).filter((item) => /\brole="tab"/.test(item.attrs));
  assert.equal(tabs.length, 4);
  for (const name of ['clamp', 'stdp', 'fi', 'lab']) {
    assert.ok(tabs.some((item) => item.tag === 'button' &&
      item.attrs.includes(`data-tab="${name}"`) &&
      item.attrs.includes(`id="tab-btn-${name}"`) &&
      item.attrs.includes(`aria-controls="tab-${name}"`)), `tab ${name} is not wired to its panel`);
  }
});

test('each tab panel is a labelled tabpanel', () => {
  for (const name of ['clamp', 'stdp', 'fi', 'lab']) {
    const panel = tags(html).find((item) => item.attrs.includes(`id="tab-${name}"`));
    assert.ok(panel, `panel tab-${name} is missing`);
    assert.equal(panel.tag, 'section');
    assert.match(panel.attrs, /\brole="tabpanel"/);
    assert.match(panel.attrs, new RegExp(`aria-labelledby="tab-btn-${name}"`));
  }
});

test('aria-selected is never set on an element with a non tab role', () => {
  const illegal = tags(html)
    .filter((item) => /\baria-selected=/.test(item.attrs))
    .filter((item) => !/\brole="tab"/.test(item.attrs));
  assert.deepEqual(illegal.map((item) => item.raw), []);
});

test('only the active tab sits in the tab sequence', () => {
  for (const name of ['clamp', 'stdp', 'fi', 'lab']) {
    const tab = tags(html).find((item) => item.attrs.includes(`id="tab-btn-${name}"`));
    const expected = name === 'clamp' ? 'tabindex="0"' : 'tabindex="-1"';
    assert.ok(tab.attrs.includes(expected), `tab ${name} has the wrong roving tabindex`);
  }
  assert.match(appSource, /t\.tabIndex = on \? 0 : -1;/);
});

test('arrow keys, Home and End move focus across the tab list', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.ok(appSource.includes(`event.key === '${key}'`), `missing ${key} handling`);
  }
  assert.match(appSource, /next\.focus\(\);/);
});

test('every named div carries a role so its label reaches assistive tech', () => {
  const offenders = tags(html)
    .filter((item) => item.tag === 'div')
    .filter((item) => /\baria-label=|\baria-labelledby=/.test(item.attrs))
    .filter((item) => !/\brole=/.test(item.attrs));
  assert.deepEqual(offenders.map((item) => item.raw), []);
});

test('control groups are exposed as labelled groups', () => {
  const groups = tags(html).filter((item) => item.tag === 'div' &&
    /\brole="group"/.test(item.attrs) && /\bclass="controls"/.test(item.attrs));
  assert.equal(groups.length, 6);
});
