const MD5_S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
const MD5_K = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];

export function md5(input: string): string {
  const utf8 = unescape(encodeURIComponent(input));
  const n = utf8.length;
  const wordCount = (((n + 8) >> 6) + 1) << 4;
  const words = new Array<number>(wordCount).fill(0);
  for (let i = 0; i < n; i++) words[i >> 2] |= (utf8.charCodeAt(i) & 0xff) << ((i % 4) * 8);
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[wordCount - 2] = (n * 8) >>> 0;
  words[wordCount - 1] = Math.floor((n * 8) / 0x100000000);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < words.length; off += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + (words[off + g] | 0)) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = (num: number) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((num >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

const SBOX = new Uint8Array([0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]);
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
const AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

function aesKeyExpansion(key: Uint8Array): Uint8Array {
  const exp = new Uint8Array(176);
  exp.set(key);
  let gen = 16, rconIter = 0;
  const temp = new Uint8Array(4);
  while (gen < 176) {
    for (let i = 0; i < 4; i++) temp[i] = exp[gen - 4 + i];
    if (gen % 16 === 0) {
      const t = temp[0];
      temp[0] = SBOX[temp[1]] ^ AES_RCON[rconIter++];
      temp[1] = SBOX[temp[2]];
      temp[2] = SBOX[temp[3]];
      temp[3] = SBOX[t];
    }
    for (let i = 0; i < 4; i++) {
      exp[gen] = exp[gen - 16] ^ temp[i];
      gen++;
    }
  }
  return exp;
}

function gfMul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

function aesDecryptBlock(block: Uint8Array, rk: Uint8Array): Uint8Array {
  const s = new Uint8Array(block);
  const addRK = (off: number) => { for (let i = 0; i < 16; i++) s[i] ^= rk[off + i]; };
  const invSR = () => {
    const c = s.slice();
    for (let r = 1; r < 4; r++) for (let col = 0; col < 4; col++) s[r + 4 * col] = c[r + 4 * ((col - r + 4) % 4)];
  };
  const invSB = () => { for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]; };
  const invMC = () => {
    for (let c = 0; c < 4; c++) {
      const i = 4 * c;
      const s0 = s[i], s1 = s[i + 1], s2 = s[i + 2], s3 = s[i + 3];
      s[i] = gfMul(s0,14)^gfMul(s1,11)^gfMul(s2,13)^gfMul(s3,9);
      s[i+1] = gfMul(s0,9)^gfMul(s1,14)^gfMul(s2,11)^gfMul(s3,13);
      s[i+2] = gfMul(s0,13)^gfMul(s1,9)^gfMul(s2,14)^gfMul(s3,11);
      s[i+3] = gfMul(s0,11)^gfMul(s1,13)^gfMul(s2,9)^gfMul(s3,14);
    }
  };
  addRK(160);
  for (let round = 9; round >= 1; round--) { invSR(); invSB(); addRK(round * 16); invMC(); }
  invSR(); invSB(); addRK(0);
  return s;
}

export function aesCbcDecrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const rk = aesKeyExpansion(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 16) {
    const block = data.slice(off, off + 16);
    const dec = aesDecryptBlock(block, rk);
    for (let i = 0; i < 16; i++) dec[i] ^= prev[i];
    out.set(dec, off);
    prev = block;
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  let clean = b64.replace(/=+$/, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const val = chars.indexOf(clean[i]);
    if (val === -1) continue;
    buf = (buf << 6) | val;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c < 0x80) { s += String.fromCharCode(c); i++; }
    else if (c < 0xe0) { s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i+1] & 0x3f)); i += 2; }
    else if (c < 0xf0) { s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i+1] & 0x3f) << 6) | (bytes[i+2] & 0x3f)); i += 3; }
    else {
      let cp = ((c & 7) << 18) | ((bytes[i+1] & 0x3f) << 12) | ((bytes[i+2] & 0x3f) << 6) | (bytes[i+3] & 0x3f);
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 4;
    }
  }
  return s;
}

export function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

export function decryptResponse(raw: string): any {
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  const data = base64ToBytes(padded);
  const key = stringToBytes('0123456789123456');
  const iv = stringToBytes('2015030120123456');
  let dec = aesCbcDecrypt(data, key, iv);
  const pad = dec[dec.length - 1];
  if (pad >= 1 && pad <= 16) dec = dec.slice(0, dec.length - pad);
  return JSON.parse(utf8Decode(dec));
}
