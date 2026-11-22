'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../src/neuro.js');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol,
    `${msg || ''} expected ${a} within ${tol} of ${b}`);

/* =============================================================== *
 * SHA-256: FIPS 180-4 known answer vectors
 * =============================================================== */

test('sha256 of the empty string matches the FIPS vector', () => {
  assert.equal(
    N.sha256(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 of abc matches the FIPS vector', () => {
  assert.equal(
    N.sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 of a two block message matches the FIPS vector', () => {
  assert.equal(
    N.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256 of the alphabet pangram matches the FIPS vector', () => {
  assert.equal(
    N.sha256('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('sha256 of the pangram with a period matches the FIPS vector', () => {
  assert.equal(
    N.sha256('The quick brown fox jumps over the lazy dog.'),
    'ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c');
});

test('sha256 of one million a characters matches the FIPS vector', () => {
  assert.equal(
    N.sha256('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

/* =============================================================== *
 * SHA-256: input handling and properties
 * =============================================================== */

test('sha256 digest is 64 lowercase hex characters', () => {
  const d = N.sha256('spike bench');
  assert.equal(d.length, 64);
  assert.match(d, /^[0-9a-f]{64}$/);
});

test('sha256 accepts a Uint8Array equal to the UTF-8 encoding', () => {
  const bytes = new TextEncoder().encode('membrane potential');
  assert.equal(N.sha256(bytes), N.sha256('membrane potential'));
});

test('sha256 accepts a plain array of bytes', () => {
  assert.equal(N.sha256([97, 98, 99]), N.sha256('abc'));
});

test('sha256 accepts an ArrayBuffer', () => {
  const buf = new TextEncoder().encode('abc').buffer;
  assert.equal(N.sha256(buf), N.sha256('abc'));
});

test('sha256 accepts a typed array view over a larger buffer', () => {
  const backing = new Uint8Array([0, 0, 97, 98, 99, 0, 0]);
  const view = backing.subarray(2, 5);
  assert.equal(N.sha256(view), N.sha256('abc'));
});

test('sha256 rejects unsupported input types', () => {
  assert.throws(() => N.sha256(42), TypeError);
  assert.throws(() => N.sha256(null), TypeError);
  assert.throws(() => N.sha256({ text: 'abc' }), TypeError);
});

test('sha256 is deterministic for identical input', () => {
  assert.equal(N.sha256('synapse'), N.sha256('synapse'));
});

test('sha256 is sensitive to a single bit of difference', () => {
  const a = N.sha256('dendrite');
  const b = N.sha256('dendrite ');
  assert.notEqual(a, b);
});

test('sha256 handles non ASCII input through UTF-8', () => {
  const expected = require('node:crypto')
    .createHash('sha256').update('neuron é å').digest('hex');
  assert.equal(N.sha256('neuron é å'), expected);
});

test('sha256 handles four byte UTF-8 characters', () => {
  const s = 'spike 𝔞 𝔟 𝔠';
  const expected = require('node:crypto')
    .createHash('sha256').update(s).digest('hex');
  assert.equal(N.sha256(s), expected);
});

test('sha256 output is padded so short hex words keep leading zeros', () => {
  // Any digest component below 0x10000000 must pad to 8 digits; the format
  // invariant is the 64 hex length plus strict lowercase, checked here too.
  for (const s of ['a', 'b', 'c', 'x1', 'x2']) {
    assert.match(N.sha256(s), /^[0-9a-f]{64}$/);
  }
});

test('checksum is a string digest of arbitrary text', () => {
  assert.equal(N.checksum('abc'), N.sha256('abc'));
  assert.equal(N.checksum(12345), N.sha256('12345'));
});

test('sha256Bytes matches sha256 on encoded text', () => {
  const bytes = N.utf8Bytes('verified export');
  assert.equal(N.sha256Bytes(bytes), N.sha256('verified export'));
});

test('messages at the 55 and 56 byte block boundary hash correctly', () => {
  const crypto = require('node:crypto');
  for (const len of [55, 56, 63, 64, 65, 119, 120, 128]) {
    const s = 'q'.repeat(len);
    assert.equal(
      N.sha256(s),
      crypto.createHash('sha256').update(s).digest('hex'),
      `length ${len}`);
  }
});

/* =============================================================== *
 * UTF-8 codec
 * =============================================================== */

test('utf8Bytes encodes ASCII identically to TextEncoder', () => {
  const s = 'Spike Bench 2.0';
  assert.deepEqual(Array.from(N.utf8Bytes(s)),
    Array.from(new TextEncoder().encode(s)));
});

test('utf8Bytes encodes two byte characters identically to TextEncoder', () => {
  const s = 'éåüø';
  assert.deepEqual(Array.from(N.utf8Bytes(s)),
    Array.from(new TextEncoder().encode(s)));
});

test('utf8Bytes encodes three byte characters identically to TextEncoder', () => {
  const s = 'neuron 中 文 テスト';
  assert.deepEqual(Array.from(N.utf8Bytes(s)),
    Array.from(new TextEncoder().encode(s)));
});

test('utf8Bytes encodes four byte characters identically to TextEncoder', () => {
  const s = 'ab𝔘𝔠';
  assert.deepEqual(Array.from(N.utf8Bytes(s)),
    Array.from(new TextEncoder().encode(s)));
});

test('utf8String is the exact inverse of utf8Bytes', () => {
  for (const s of ['', 'a', 'hello world', 'é', '中文', 'ab𝔘cd', 'mix é中𝔘z']) {
    assert.equal(N.utf8String(N.utf8Bytes(s)), s, `round trip ${s}`);
  }
});

/* =============================================================== *
 * base64url codec
 * =============================================================== */

test('b64urlEncode uses the URL safe alphabet without padding', () => {
  const out = N.b64urlEncode(N.utf8Bytes('any carnal pleasure.?'));
  assert.match(out, /^[A-Za-z0-9_-]+=*$/);
  assert.ok(!out.includes('+') && !out.includes('/'));
});

test('b64url round trips byte arrays of every remainder length', () => {
  for (let len = 0; len <= 9; len += 1) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => i * 37 + 11);
    const enc = N.b64urlEncode(bytes);
    assert.deepEqual(Array.from(N.b64urlDecode(enc)), Array.from(bytes),
      `length ${len}`);
  }
});

test('b64urlDecode tolerates omitted padding characters', () => {
  const bytes = N.utf8Bytes('state');
  const withPad = N.b64urlEncode(bytes);
  assert.deepEqual(Array.from(N.b64urlDecode(withPad + '==')), Array.from(bytes));
});

test('b64urlDecode throws on characters outside the alphabet', () => {
  assert.throws(() => N.b64urlDecode('abc+'), RangeError);
  assert.throws(() => N.b64urlDecode('a/b'), RangeError);
  assert.throws(() => N.b64urlDecode('héllo'), RangeError);
});

/* =============================================================== *
 * Run state codec for URL hash bookmarking
 * =============================================================== */

test('encodeRunState and decodeRunState round trip a state object', () => {
  const state = { proto: 'step', amp: 12.5, ttx: 0.3, label: 'stim é' };
  const back = N.decodeRunState(N.encodeRunState(state));
  assert.deepEqual(back, state);
});

test('encodeRunState output is URL hash safe', () => {
  const token = N.encodeRunState({ a: 'x+y/z=?&', b: [1, 2] });
  assert.match(token, /^s1\.[A-Za-z0-9_-]+$/);
});

test('encodeRunState is deterministic for equal states', () => {
  const a = N.encodeRunState({ x: 1, y: [2, 3] });
  const b = N.encodeRunState({ x: 1, y: [2, 3] });
  assert.equal(a, b);
});

test('encodeRunState rejects non object input', () => {
  assert.throws(() => N.encodeRunState([1, 2]), TypeError);
  assert.throws(() => N.encodeRunState('text'), TypeError);
  assert.throws(() => N.encodeRunState(null), TypeError);
  assert.throws(() => N.encodeRunState(9), TypeError);
});

test('decodeRunState returns null for malformed tokens', () => {
  assert.equal(N.decodeRunState('garbage'), null);
  assert.equal(N.decodeRunState('s2.abc'), null);
  assert.equal(N.decodeRunState(''), null);
  assert.equal(N.decodeRunState(42), null);
  assert.equal(N.decodeRunState('s1.!!!'), null);
});

test('decodeRunState returns null when the payload is not an object', () => {
  const arr = 's1.' + N.b64urlEncode(N.utf8Bytes('[1,2,3]'));
  const num = 's1.' + N.b64urlEncode(N.utf8Bytes('42'));
  const str = 's1.' + N.b64urlEncode(N.utf8Bytes('"hi"'));
  assert.equal(N.decodeRunState(arr), null);
  assert.equal(N.decodeRunState(num), null);
  assert.equal(N.decodeRunState(str), null);
});

test('stateToHash and stateFromHash handle the leading hash mark', () => {
  const state = { tab: 'stdp', amp: 9 };
  const hash = N.stateToHash(state);
  assert.ok(hash.startsWith('#s1.'));
  assert.deepEqual(N.stateFromHash(hash), state);
  assert.deepEqual(N.stateFromHash(hash.slice(1)), state);
});

test('stateFromHash returns null for non hash input', () => {
  assert.equal(N.stateFromHash('#preset'), null);
  assert.equal(N.stateFromHash(null), null);
});

/* =============================================================== *
 * Verified documents
 * =============================================================== */

test('verifiedDocument carries format, version, algorithm and checksum', () => {
  const doc = JSON.parse(N.verifiedDocument({ a: 1 }));
  assert.equal(doc.format, 'spike-bench-verified');
  assert.equal(doc.version, N.VERSION);
  assert.equal(doc.algorithm, 'SHA-256');
  assert.match(doc.checksum, /^[0-9a-f]{64}$/);
});

test('verifiedDocument checksum equals sha256 of the payload serialization', () => {
  const payload = { spikes: [1, 2], note: 'test' };
  const doc = JSON.parse(N.verifiedDocument(payload));
  assert.equal(doc.checksum, N.sha256(JSON.stringify(payload)));
});

test('verifyDocument confirms an untampered export', () => {
  const json = N.verifiedDocument({ raster: [{ t: 1, neuron: 0 }] });
  const res = N.verifyDocument(json);
  assert.equal(res.ok, true);
  assert.equal(res.computed, res.checksum);
});

test('verifyDocument detects a flipped digit in the payload', () => {
  const doc = JSON.parse(N.verifiedDocument({ value: 10 }));
  doc.payload.value = 11;
  const res = N.verifyDocument(JSON.stringify(doc));
  assert.equal(res.ok, false);
  assert.notEqual(res.computed, res.checksum);
});

test('verifyDocument detects a swapped checksum', () => {
  const doc = JSON.parse(N.verifiedDocument({ value: 10 }));
  doc.checksum = doc.checksum.replace(/^./, doc.checksum[0] === 'a' ? 'b' : 'a');
  assert.equal(N.verifyDocument(JSON.stringify(doc)).ok, false);
});

test('verifyDocument rejects invalid JSON and foreign documents', () => {
  assert.equal(N.verifyDocument('not json').ok, false);
  assert.equal(N.verifyDocument('{"format":"other"}').ok, false);
  assert.equal(N.verifyDocument('{"format":"spike-bench-verified"}').ok, false);
});

test('canonicalJSON serializes payload deterministically', () => {
  const p = { b: 2, a: [3, { z: 1 }] };
  assert.equal(N.canonicalJSON(p), JSON.stringify(p));
  assert.equal(N.canonicalJSON(p), N.canonicalJSON({ b: 2, a: [3, { z: 1 }] }));
});

/* =============================================================== *
 * exportSpikeReport session bundles
 * =============================================================== */

test('exportSpikeReport wraps trace samples in a verified document', () => {
  const tr = N.currentClamp({ amplitude: 10, stimStart: 2, stimDuration: 5 });
  const rep = N.exportSpikeReport({ label: 'run', trace: tr });
  const doc = JSON.parse(rep.json);
  assert.equal(doc.payload.label, 'run');
  assert.equal(doc.payload.sections.trace.samples.length, tr.t.length);
  assert.deepEqual(doc.payload.sections.trace.columns, ['t_ms', 'V_mV', 'I_uA_cm2']);
  assert.equal(N.verifyDocument(rep.json).ok, true);
});

test('exportSpikeReport includes raster, weights, pairs and f-I sections', () => {
  const exp = N.stdpExperiment({ nPre: 4, duration: 300, seed: 3 });
  const fi = N.fICurve({ amplitudes: [0, 10], stimDuration: 100 });
  const rep = N.exportSpikeReport({
    raster: exp.preSpikes.map((s) => ({ t: s.t, neuron: s.neuron, type: 'pre' })),
    weights: { initial: exp.weights.initial, final: exp.weights.final, stats: exp.stats },
    pairs: exp.pairs,
    fiCurve: Object.assign({ rheobase: 2.2 }, fi),
  });
  const doc = JSON.parse(rep.json);
  assert.equal(doc.payload.sections.raster.length, exp.preSpikes.length);
  assert.deepEqual(doc.payload.sections.weights.initial, exp.weights.initial);
  assert.equal(doc.payload.sections.fiCurve.points.length, 2);
  assert.equal(doc.payload.sections.fiCurve.rheobase, 2.2);
  assert.equal(N.verifyDocument(rep.json).ok, true);
});

test('exportSpikeReport reports byte size and both checksums', () => {
  const rep = N.exportSpikeReport({ label: 'x' });
  assert.ok(rep.bytes > 0);
  assert.match(rep.checksum, /^[0-9a-f]{64}$/);
  assert.match(rep.payloadChecksum, /^[0-9a-f]{64}$/);
  assert.equal(rep.checksum, N.sha256(rep.json));
  assert.notEqual(rep.checksum, rep.payloadChecksum);
});

test('exportSpikeReport handles empty sections without crashing', () => {
  const rep = N.exportSpikeReport({});
  const doc = JSON.parse(rep.json);
  assert.deepEqual(doc.payload.sections, {});
  assert.equal(N.verifyDocument(rep.json).ok, true);
});

test('exportSpikeReport rounds trace fields to stable precision', () => {
  const rep = N.exportSpikeReport({
    trace: { t: [0, 0.5], V: [-65.123456789, -64.9], I: [0, 5], dt: 0.5, spikes: [] },
  });
  const doc = JSON.parse(rep.json);
  near(doc.payload.sections.trace.samples[1][1], -64.9, 1e-6);
});

/* =============================================================== *
 * runSelfTests battery
 * =============================================================== */

test('runSelfTests passes every check in Node', () => {
  const res = N.runSelfTests();
  assert.equal(res.ok, true, JSON.stringify(res.results.filter((r) => !r.ok)));
  assert.equal(res.pass, res.total);
  assert.equal(res.fail, 0);
});

test('runSelfTests reports name, status, detail and timing per check', () => {
  const res = N.runSelfTests();
  assert.ok(res.total >= 15);
  res.results.forEach((r) => {
    assert.ok(typeof r.name === 'string' && r.name.length > 0);
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(typeof r.detail, 'string');
    assert.ok(Number.isFinite(r.ms));
  });
});

test('runSelfTests covers the required physics checks', () => {
  const names = N.runSelfTests().results.map((r) => r.name);
  ['rk4-step-halving-convergence', 'stdp-ltp-sign', 'stdp-ltd-sign',
    'rheobase-monotonicity', 'sha256-fips-vector'].forEach((need) =>
    assert.ok(names.includes(need), `missing ${need}`));
});

test('runSelfTests is deterministic across calls', () => {
  const a = N.runSelfTests().results.map((r) => r.name);
  const b = N.runSelfTests().results.map((r) => r.name);
  assert.deepEqual(a, b);
});
