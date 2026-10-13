/* eslint-disable no-bitwise -- base64 encoder needs bit shifts */
import {store} from '../store/kv';

// Famelack public dataset — the live TV / radio / webcam catalogue that powers
// the "Live Channels" section. Plain JSON (the `raw/` variant needs no gzip).
const BASE = 'https://raw.githubusercontent.com/famelack/famelack-data/main';

export type FamelackKind = 'tv' | 'radio' | 'webcams';

export interface FamelackChannel {
  nanoid: string;
  name: string;
  sources?: {
    streams?: string[];
    youtube?: string[];
  };
  languages?: string[];
  country?: string;
  isGeoBlocked?: boolean;
}

export interface FamelackCountryMeta {
  country: string;
  capital?: string;
  timeZone?: string;
  hasChannels?: boolean;
  channelCount?: number;
}

export const FAMELACK_KINDS: {key: FamelackKind; label: string; icon: string}[] = [
  {key: 'tv', label: 'TV', icon: 'tv-outline'},
  {key: 'radio', label: 'Radio', icon: 'radio-outline'},
  {key: 'webcams', label: 'Webcams', icon: 'videocam-outline'},
];

// ---------------------------------------------------------------------------
// Cache: in-memory for the session + MMKV mirror for an instant first paint.
// ---------------------------------------------------------------------------
const MEM = new Map<string, any>();
const INFLIGHT = new Map<string, Promise<any>>();

function memGet<T>(key: string): T | null {
  if (MEM.has(key)) {
    return MEM.get(key) as T;
  }
  try {
    const raw = store.getString('famelack_c_' + key);
    if (raw) {
      const ttl = 6 * 60 * 60 * 1000; // 6h
      const o = JSON.parse(raw) as {d: T; w: number};
      if (Date.now() - o.w <= ttl && o.d != null) {
        MEM.set(key, o.d);
        return o.d;
      }
    }
  } catch {}
  return null;
}

function memSet(key: string, d: any): void {
  MEM.set(key, d);
  // Only mirror reasonably small payloads to disk (skip huge radio lists).
  try {
    const json = JSON.stringify(d);
    if (json.length < 900000) {
      store.setString('famelack_c_' + key, JSON.stringify({d, w: Date.now()}));
    }
  } catch {}
}

async function getJson<T>(path: string, cacheKey?: string): Promise<T | null> {
  if (cacheKey) {
    const hit = memGet<T>(cacheKey);
    if (hit != null) {
      return hit;
    }
    const inflight = INFLIGHT.get(cacheKey);
    if (inflight) {
      return inflight as Promise<T | null>;
    }
  }
  const p = (async () => {
    try {
      const res = await fetch(`${BASE}/${path}`);
      if (!res.ok) {
        return null;
      }
      const json = (await res.json()) as T;
      if (cacheKey && json != null) {
        memSet(cacheKey, json);
      }
      return json;
    } catch {
      return null;
    } finally {
      if (cacheKey) {
        INFLIGHT.delete(cacheKey);
      }
    }
  })();
  if (cacheKey) {
    INFLIGHT.set(cacheKey, p);
  }
  return p;
}

/** Country metadata (name, capital, channel count) for a mode. */
export async function famelackCountries(
  kind: FamelackKind,
): Promise<Record<string, FamelackCountryMeta>> {
  const r = await getJson<Record<string, FamelackCountryMeta>>(
    `${kind}/raw/countries_metadata.json`,
    `${kind}_countries`,
  );
  return r || {};
}

/** Channels of one country for a mode. */
export async function famelackChannelsByCountry(
  kind: FamelackKind,
  cc: string,
): Promise<FamelackChannel[]> {
  const r = await getJson<FamelackChannel[]>(
    `${kind}/raw/countries/${cc.toLowerCase()}.json`,
    `${kind}_cc_${cc.toLowerCase()}`,
  );
  return r || [];
}

/** Channels in one category (global list) for a mode. */
export async function famelackByCategory(
  kind: FamelackKind,
  category: string,
): Promise<FamelackChannel[]> {
  const r = await getJson<FamelackChannel[]>(
    `${kind}/raw/categories/${category}.json`,
    `${kind}_cat_${category}`,
  );
  return r || [];
}

// Categories surfaced as rows on the Live screen (in display order).
export const FAMELACK_ROW_CATEGORIES: {key: string; label: string}[] = [
  {key: 'news', label: 'News'},
  {key: 'entertainment', label: 'Entertainment'},
  {key: 'sports', label: 'Sports'},
  {key: 'music', label: 'Music'},
];

/** Full catalogue of a mode (used for search). */
export async function famelackAll(
  kind: FamelackKind,
): Promise<FamelackChannel[]> {
  const r = await getJson<FamelackChannel[]>(
    `${kind}/raw/categories/all.json`,
    `${kind}_all`,
  );
  return r || [];
}

export async function famelackSearch(
  kind: FamelackKind,
  query: string,
): Promise<FamelackChannel[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    return [];
  }
  const all = await famelackAll(kind);
  return all
    .filter(c => (c.name || '').toLowerCase().includes(q))
    .slice(0, 200);
}

/** First playable URL of a channel (direct stream, or a YouTube embed). */
export function famelackStream(ch: FamelackChannel): string {
  const s = ch.sources || {};
  if (s.streams && s.streams.length) {
    return s.streams[0];
  }
  if (s.youtube && s.youtube.length) {
    return s.youtube[0];
  }
  return '';
}

export function isYouTubeStream(url: string): boolean {
  return /youtube(-nocookie)?\.com|youtu\.be/i.test(url);
}

// ---------------------------------------------------------------------------
// 3D globe geometry
//
// Famelack ships a custom binary globe (custom header + positions + indices):
//   [0..4)   uint32 LE = JSON header length
//   [4..4+H) UTF-8 JSON header (params, sections, countries[], adjacency{})
//   then     Float32 positions (vec3 x vertexCount), then u16/u32 indices
// We fetch it once here (no CORS in RN) and hand it to the WebView as base64.
// ---------------------------------------------------------------------------
export const FAMELACK_GLOBE_URL =
  'https://famelack.com/assets/globeGeometry--2nxcY32.bin';

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

let globeB64: string | null = null;
let globeInflight: Promise<string | null> | null = null;

/** Base64 of the globe geometry binary (cached for the session). */
export function famelackGlobeGeometryBase64(): Promise<string | null> {
  if (globeB64) {
    return Promise.resolve(globeB64);
  }
  if (globeInflight) {
    return globeInflight;
  }
  globeInflight = (async () => {
    try {
      // famelack.com rejects requests with no User-Agent (403).
      const res = await fetch(FAMELACK_GLOBE_URL, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
          Referer: 'https://famelack.com/',
        },
      });
      if (!res.ok) {
        return null;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      globeB64 = toBase64(bytes);
      return globeB64;
    } catch {
      return null;
    } finally {
      globeInflight = null;
    }
  })();
  return globeInflight;
}

/** Emoji flag for an ISO2 country code (with the dataset's UK -> GB quirk). */
export function famelackFlag(cc?: string): string {
  if (!cc || cc.length !== 2) {
    return '🌐';
  }
  const c = cc.toUpperCase() === 'UK' ? 'GB' : cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) {
    return '🌐';
  }
  return String.fromCodePoint(
    ...[...c].map(ch => 0x1f1e6 + (ch.charCodeAt(0) - 65)),
  );
}
