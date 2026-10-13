import crypto from 'node:crypto';
import {
  base64ToBytes,
  decryptResponse,
  md5,
  stringToBytes,
  utf8Decode,
} from '../src/providers/filmtvCrypto';

/**
 * The FilmTV crypto, checked against Node's own implementations.
 *
 * This file exists because the port had to be *exactly* the app's. Every FilmTV
 * request is signed with `md5` and every response arrives AES-CBC encrypted, and
 * a single wrong entry in the S-box would still compile, still pass a type check,
 * and only show up as "the API answered nothing" on a live deploy.
 *
 * The reference is Node's `crypto`, not a hard-coded string: Node's
 * implementation is independent of the app's, so if the two agree on arbitrary
 * input — including the non-ASCII a movie title is made of — then the port is the
 * same algorithm. Non-ASCII is written as escapes here so the test itself cannot
 * be broken by an editor's idea of encoding.
 */

/** Non-ASCII samples a real FilmTV response is full of, as escapes. */
const UNICODE_SAMPLES = [
  '\u0939\u093f\u0928\u094d\u0926\u0940', // Hindi
  '\u0e44\u0e17\u0e22', // Thai
  '\u4e2d\u6587', // Chinese
  '\ud83c\udfac movie', // emoji, four bytes on the wire
];

/** AES-128-CBC exactly as FilmTV expects it: same key, same iv, PKCS padding. */
const encryptLikeFilmTV = (plaintext: string): string => {
  const key = Buffer.from('0123456789123456', 'latin1');
  const iv = Buffer.from('2015030120123456', 'latin1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]).toString('base64');
};

describe('md5', () => {
  it('matches Node over the cases that would expose a broken table', () => {
    const samples = [
      '',
      'a',
      'abc',
      'The quick brown fox jumps over the lazy dog',
      // The exact shapes FilmTV signs: secret + device id + timestamp.
      '47Q8tBqO4YqrMHf40123456789abcdef1788934400',
      'Zox882LYjEn4Rqpa' + '0123456789abcdef' + '7884012600',
      // Every input whose length changes the padding block.
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(64),
      'x'.repeat(1000),
      ...UNICODE_SAMPLES,
    ];

    for (const sample of samples) {
      const expected = crypto
        .createHash('md5')
        .update(sample, 'utf8')
        .digest('hex');
      expect(md5(sample)).toBe(expected);
    }
  });

  it('signs the header the way the app does — upper case hex', () => {
    const deviceId = '0123456789abcdef';
    const curTime = '1788934400';
    const sign = md5(`47Q8tBqO4YqrMHf4${deviceId}${curTime}`).toUpperCase();

    expect(sign).toMatch(/^[0-9A-F]{32}$/);
    expect(sign).toBe(
      crypto
        .createHash('md5')
        .update(`47Q8tBqO4YqrMHf4${deviceId}${curTime}`)
        .digest('hex')
        .toUpperCase(),
    );
  });
});

describe('the response cipher', () => {
  it('decrypts a body Node encrypted with FilmTV keys', () => {
    const payload = {
      code: 10000,
      result: {vod_id: 42, vod_name: '\u0939\u093f\u0928\u094d\u0926\u0940 Filim'},
    };
    const wire = encryptLikeFilmTV(JSON.stringify(payload));

    expect(decryptResponse(wire)).toEqual(payload);
  });

  it('decrypts a body long enough to need several cipher blocks', () => {
    const payload = {
      code: 10000,
      result: Array.from({length: 40}, (_, i) => ({
        vod_id: i,
        vod_name: `Title ${i}`,
      })),
    };

    expect(decryptResponse(encryptLikeFilmTV(JSON.stringify(payload)))).toEqual(
      payload,
    );
  });

  it('agrees with Node over every base64 shape the server sends', () => {
    for (const text of ['QUJD', 'a', 'hello world', ...UNICODE_SAMPLES]) {
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      expect(Array.from(base64ToBytes(encoded))).toEqual(
        Array.from(Buffer.from(text, 'utf8')),
      );
    }
  });

  it('decodes utf-8 the way Node does', () => {
    for (const text of [...UNICODE_SAMPLES, 'plain', 'Line\nbreak']) {
      const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
      expect(utf8Decode(bytes)).toBe(text);
    }
  });

  it('builds its fixed keys as latin1, which is what the server expects', () => {
    expect(Array.from(stringToBytes('0123456789123456'))).toEqual(
      Array.from(Buffer.from('0123456789123456', 'latin1')),
    );
  });
});
