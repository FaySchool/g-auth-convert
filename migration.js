/*
 * Decoder for Google Authenticator "Transfer accounts" exports.
 *
 * An export QR code contains a URI of the form
 *   otpauth-migration://offline?data=<base64 protobuf>
 * whose payload is a MigrationPayload protobuf message:
 *
 *   message MigrationPayload {
 *     repeated OtpParameters otp_parameters = 1;
 *     int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5;
 *   }
 *   message OtpParameters {
 *     bytes secret = 1; string name = 2; string issuer = 3;
 *     Algorithm algorithm = 4;  // 0 unspecified, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5
 *     DigitCount digits = 5;    // 0 unspecified, 1 six, 2 eight
 *     OtpType type = 6;         // 0 unspecified, 1 HOTP, 2 TOTP
 *     int64 counter = 7;
 *   }
 *
 * Works as a plain <script> (exposes window.GAuthMigration) and as a CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GAuthMigration = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALGORITHMS = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
  var DIGITS = { 0: 6, 1: 6, 2: 8 };
  var TYPES = { 0: 'totp', 1: 'hotp', 2: 'totp' };
  var BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base64ToBytes(b64) {
    // Tolerate URL-safe alphabet, spaces (a "+" that was form-decoded) and missing padding.
    var s = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/ /g, '+').replace(/[\r\n\t]/g, '');
    s = s.replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) {
      throw new Error('The export data is not valid base64.');
    }
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function base32Encode(bytes) {
    var out = '';
    var bits = 0;
    var value = 0;
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += BASE32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
      value &= (1 << bits) - 1;
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
  }

  // --- minimal protobuf wire-format reader -------------------------------

  function readVarint(buf, pos) {
    var result = 0;
    var mul = 1;
    for (var i = 0; i < 10; i++) {
      if (pos >= buf.length) throw new Error('The export data is truncated.');
      var b = buf[pos++];
      // Plain arithmetic instead of bit ops so values above 2^31 survive.
      result += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) return { value: result, pos: pos };
    }
    throw new Error('The export data is corrupt (bad varint).');
  }

  // Returns [{ field, wire, value }] where value is a number (varint) or Uint8Array (bytes).
  function readFields(buf) {
    var fields = [];
    var pos = 0;
    while (pos < buf.length) {
      var tag = readVarint(buf, pos);
      pos = tag.pos;
      var field = Math.floor(tag.value / 8);
      var wire = tag.value % 8;
      var value;
      if (wire === 0) {
        var v = readVarint(buf, pos);
        value = v.value;
        pos = v.pos;
      } else if (wire === 2) {
        var len = readVarint(buf, pos);
        pos = len.pos;
        if (pos + len.value > buf.length) throw new Error('The export data is truncated.');
        value = buf.subarray(pos, pos + len.value);
        pos += len.value;
      } else if (wire === 1) {
        pos += 8;
        if (pos > buf.length) throw new Error('The export data is truncated.');
      } else if (wire === 5) {
        pos += 4;
        if (pos > buf.length) throw new Error('The export data is truncated.');
      } else {
        throw new Error('The export data is corrupt (unsupported field type).');
      }
      fields.push({ field: field, wire: wire, value: value });
    }
    return fields;
  }

  function utf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parseOtpParameters(buf) {
    var p = { secret: new Uint8Array(0), name: '', issuer: '', algorithm: 0, digits: 0, type: 0, counter: 0 };
    readFields(buf).forEach(function (f) {
      if (f.field === 1 && f.wire === 2) p.secret = f.value;
      else if (f.field === 2 && f.wire === 2) p.name = utf8(f.value);
      else if (f.field === 3 && f.wire === 2) p.issuer = utf8(f.value);
      else if (f.field === 4 && f.wire === 0) p.algorithm = f.value;
      else if (f.field === 5 && f.wire === 0) p.digits = f.value;
      else if (f.field === 6 && f.wire === 0) p.type = f.value;
      else if (f.field === 7 && f.wire === 0) p.counter = f.value;
    });
    var account = {
      type: TYPES[p.type] || 'totp',
      name: p.name,
      issuer: p.issuer,
      secret: base32Encode(p.secret),
      algorithm: ALGORITHMS[p.algorithm] || 'SHA1',
      digits: DIGITS[p.digits] || 6,
      counter: p.counter
    };
    account.uri = toOtpauthUri(account);
    return account;
  }

  // --- public API --------------------------------------------------------

  /** Extract the raw base64 payload from an otpauth-migration:// URI (or accept bare base64). */
  function extractData(input) {
    var text = String(input || '').trim();
    if (!text) throw new Error('Nothing to convert.');
    var m = /^otpauth-migration:\/\/offline\/?\?(.*)$/i.exec(text);
    if (!m) {
      if (/^otpauth:\/\//i.test(text)) {
        throw new Error('That is already an otpauth:// URI, not a Google Authenticator export.');
      }
      if (/^[A-Za-z0-9+/_\-=%\s]+$/.test(text)) {
        return text.indexOf('%') >= 0 ? decodeURIComponent(text) : text;
      }
      throw new Error('Expected a URI starting with otpauth-migration://offline?data=');
    }
    var data = null;
    m[1].split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq > 0 && pair.slice(0, eq) === 'data') data = pair.slice(eq + 1);
    });
    if (data === null) throw new Error('The export URI has no "data" parameter.');
    // Deliberately not URLSearchParams: it would turn a literal "+" into a space.
    return decodeURIComponent(data);
  }

  /** Build a Key URI Format (otpauth://) string for one account. */
  function toOtpauthUri(a) {
    var name = a.name || '';
    var issuer = a.issuer || '';
    var label;
    if (issuer && name.indexOf(issuer + ':') !== 0) {
      label = encodeURIComponent(issuer) + ':' + encodeURIComponent(name);
    } else if (issuer) {
      label = encodeURIComponent(issuer) + ':' + encodeURIComponent(name.slice(issuer.length + 1).replace(/^ +/, ''));
    } else {
      label = encodeURIComponent(name);
    }
    var params = ['secret=' + a.secret];
    if (issuer) params.push('issuer=' + encodeURIComponent(issuer));
    params.push('algorithm=' + a.algorithm);
    params.push('digits=' + a.digits);
    if (a.type === 'hotp') params.push('counter=' + a.counter);
    else params.push('period=30');
    return 'otpauth://' + a.type + '/' + label + '?' + params.join('&');
  }

  /**
   * Parse a Google Authenticator export.
   * @param {string} input otpauth-migration:// URI or the bare base64 payload
   * @returns {{accounts: Array, version: number, batchSize: number, batchIndex: number, batchId: number}}
   */
  function parseMigration(input) {
    var bytes = base64ToBytes(extractData(input));
    var result = { accounts: [], version: 0, batchSize: 1, batchIndex: 0, batchId: 0 };
    readFields(bytes).forEach(function (f) {
      if (f.field === 1 && f.wire === 2) result.accounts.push(parseOtpParameters(f.value));
      else if (f.field === 2 && f.wire === 0) result.version = f.value;
      else if (f.field === 3 && f.wire === 0) result.batchSize = f.value;
      else if (f.field === 4 && f.wire === 0) result.batchIndex = f.value;
      else if (f.field === 5 && f.wire === 0) result.batchId = f.value;
    });
    if (!result.accounts.length) throw new Error('No accounts were found in that export.');
    return result;
  }

  return {
    parseMigration: parseMigration,
    toOtpauthUri: toOtpauthUri,
    base32Encode: base32Encode,
    extractData: extractData
  };
});
