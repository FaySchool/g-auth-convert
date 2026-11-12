'use strict';
// Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { parseMigration, base32Encode } = require('../migration.js');

// --- tiny protobuf encoder, just enough to build fixtures ---
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const vfield = (num, value) => [...varint(num * 8), ...varint(value)];
const bfield = (num, bytes) => [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
const str = (s) => [...Buffer.from(s, 'utf8')];

function otp({ secret, name, issuer, algorithm, digits, type, counter }) {
  return [
    ...bfield(1, [...secret]), ...bfield(2, str(name)),
    ...(issuer ? bfield(3, str(issuer)) : []),
    ...vfield(4, algorithm), ...vfield(5, digits), ...vfield(6, type),
    ...(counter !== undefined ? vfield(7, counter) : []),
  ];
}
function exportUri(accounts, batch = {}) {
  const payload = [
    ...accounts.flatMap((a) => bfield(1, otp(a))),
    ...vfield(2, 1), ...vfield(3, batch.size || 1), ...vfield(4, batch.index || 0), ...vfield(5, 12345),
  ];
  return 'otpauth-migration://offline?data=' + encodeURIComponent(Buffer.from(payload).toString('base64'));
}
module.exports = { exportUri };

test('base32 matches RFC 4648 vectors (unpadded)', () => {
  assert.equal(base32Encode(Buffer.from('')), '');
  assert.equal(base32Encode(Buffer.from('f')), 'MY');
  assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Encode(Buffer.from('Hello!\xde\xad\xbe\xef', 'latin1')), 'JBSWY3DPEHPK3PXP');
});

test('converts TOTP and HOTP accounts', () => {
  const uri = exportUri([
    { secret: Buffer.from('Hello!\xde\xad\xbe\xef', 'latin1'), name: 'alice@example.com', issuer: 'Example Co', algorithm: 1, digits: 1, type: 2 },
    { secret: Buffer.from('12345678901234567890'), name: 'GitHub:bob', issuer: 'GitHub', algorithm: 2, digits: 2, type: 2 },
    { secret: Buffer.from('foobar'), name: 'counter & co', issuer: '', algorithm: 0, digits: 0, type: 1, counter: 42 },
  ], { size: 2, index: 0 });
  const r = parseMigration(uri);
  assert.equal(r.batchSize, 2);
  assert.equal(r.batchIndex, 0);
  assert.deepEqual(r.accounts.map((a) => a.uri), [
    'otpauth://totp/Example%20Co:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example%20Co&algorithm=SHA1&digits=6&period=30',
    'otpauth://totp/GitHub:bob?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub&algorithm=SHA256&digits=8&period=30',
    'otpauth://hotp/counter%20%26%20co?secret=MZXW6YTBOI&algorithm=SHA1&digits=6&counter=42',
  ]);
});

test('accepts unescaped base64, "+" turned into spaces, and bare payloads', () => {
  // 0xfb 0xff bytes force "+" and "/" into the base64.
  const uri = exportUri([{ secret: Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xef, 0xbe]), name: 'x', issuer: 'Y', algorithm: 1, digits: 1, type: 2 }]);
  const expected = parseMigration(uri).accounts[0].uri;
  const raw = decodeURIComponent(uri.split('data=')[1]);
  assert.match(raw, /[+/]/);
  assert.equal(parseMigration('otpauth-migration://offline?data=' + raw).accounts[0].uri, expected);
  assert.equal(parseMigration('otpauth-migration://offline?data=' + raw.replace(/\+/g, ' ')).accounts[0].uri, expected);
  assert.equal(parseMigration(raw).accounts[0].uri, expected);
  assert.equal(parseMigration('  ' + uri + '\n').accounts[0].uri, expected);
});

test('rejects bad input with a readable message', () => {
  assert.throws(() => parseMigration(''), /Nothing to convert/);
  assert.throws(() => parseMigration('https://example.com'), /otpauth-migration/);
  assert.throws(() => parseMigration('otpauth://totp/a?secret=AAAA'), /already an otpauth/);
  assert.throws(() => parseMigration('otpauth-migration://offline?foo=bar'), /no "data"/);
  assert.throws(() => parseMigration('otpauth-migration://offline?data=CgoKBWhlbGxvEgE'), /truncated|corrupt|No accounts/);
});
