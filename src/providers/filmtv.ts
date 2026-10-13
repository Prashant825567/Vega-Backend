import {md5, decryptResponse} from './filmtvCrypto';
import {store} from '../store/kv';

const BASE = 'https://moviein.ajfysu.com/';
// Header sign secret (MD5 of SECRET + device_id + cur_time).
const SECRET = '47Q8tBqO4YqrMHf4';
// Body sign secret used by the `api/vod/info_new` gate. Recovered from the
// decrypted libpp_hls.so runtime state: the native `/control?msg=verify` handler
// computes MD5(SIGN_SECRET + (device_id + vod_id) + ts).
const SIGN_SECRET = 'Zox882LYjEn4Rqpa';
// CDN edge (CloudFront) only requires the signed-URL query params to be present;
// any non-empty values serve the object.
const CDN_SIG_PARAMS = (): string =>
  `Expires=${Math.floor(Date.now() / 1000) + 86400}&Signature=x&Key-Pair-Id=x`;
const APP_ID = 'moviein';
const PKG = 'com.fvvcl.flickverse';
const VER = '40001';

const K_DEV = 'filmtv_device_id';
const K_TOK = 'filmtv_token';
const K_ACC = 'filmtv_account';
const K_PWD = 'filmtv_password';

function genDeviceId(): string {
  const hex = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 16; i++) id += hex[Math.floor(Math.random() * 16)];
  return id;
}

export function getDeviceId(): string {
  let id = store.getString(K_DEV);
  if (!id) {
    id = genDeviceId();
    store.setString(K_DEV, id);
  }
  return id;
}

function makeSign(deviceId: string, time: string): string {
  return md5(SECRET + deviceId + time).toUpperCase();
}

/** Body sign for `api/vod/info_new`: MD5(secret + device_id + vod_id + ts). */
function bodySign(vodId: number | string, ts: string): string {
  return md5(SIGN_SECRET + getDeviceId() + String(vodId) + ts).toUpperCase();
}

interface FtHeaders {
  [k: string]: string;
}

function buildHeaders(token?: string | null): FtHeaders {
  const deviceId = getDeviceId();
  const now = Math.floor(Date.now() / 1000).toString();
  const h: FtHeaders = {
    app_id: APP_ID,
    package_name: PKG,
    version: VER,
    sys_platform: '2',
    device_id: deviceId,
    channel_code: 'moviein_2001',
    androidid: deviceId,
    cur_time: now,
    is_vvv: '0',
    is_language: 'en',
    is_display: '1080x2400',
    app_language: 'en',
    en_al: '0',
    sign: makeSign(deviceId, now),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (token) h['token'] = token;
  return h;
}

async function post<T = any>(
  path: string,
  body?: Record<string, any>,
  useToken = false,
): Promise<T | null> {
  const token = useToken ? store.getString(K_TOK) : undefined;
  const headers = buildHeaders(token);
  const params = new URLSearchParams();
  if (body)
    Object.entries(body).forEach(([k, v]) => {
      if (v != null) params.append(k, String(v));
    });
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers,
      body: params.toString(),
    });
    const txt = await res.text();
    if (!txt || txt.length < 10) return null;
    const first = txt.charCodeAt(0);
    if (first >= 65 && first <= 122) return decryptResponse(txt) as T;
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache layer
// Fast in-memory cache (instant within a session) + MMKV mirror (instant across
// app restarts). In-flight de-duplication means N simultaneous callers of the
// same endpoint share ONE network request instead of firing N.
// ---------------------------------------------------------------------------
const MEM = new Map<string, {v: any; exp: number}>();
const INFLIGHT = new Map<string, Promise<any>>();
const CK = (key: string) => 'ftv_c_' + key;

function memGet<T>(key: string): T | null {
  const c = MEM.get(key);
  if (!c) return null;
  if (c.exp <= Date.now()) {
    MEM.delete(key);
    return null;
  }
  return c.v as T;
}

function diskGet<T>(key: string, ttl: number): T | null {
  try {
    const raw = store.getString(CK(key));
    if (!raw) return null;
    const o = JSON.parse(raw) as {d: T; w: number};
    if (ttl >= 0 && Date.now() - o.w > ttl) return null;
    return o.d;
  } catch {
    return null;
  }
}

function diskSet(key: string, d: any): void {
  try {
    store.setString(CK(key), JSON.stringify({d, w: Date.now()}));
  } catch {}
}

function hasData(v: any): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Synchronous best-effort read for an instant first paint (may be stale). */
export function peekCache<T>(key: string): T | null {
  const m = memGet<T>(key);
  if (m !== null) return m;
  return diskGet<T>(key, -1);
}

async function cached<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const mem = memGet<T>(key);
  if (mem !== null) return mem;
  const infl = INFLIGHT.get(key);
  if (infl) return infl as Promise<T>;
  const p = (async () => {
    try {
      const fresh = await fetcher();
      if (hasData(fresh)) {
        MEM.set(key, {v: fresh, exp: Date.now() + ttl});
        diskSet(key, fresh);
      }
      return fresh;
    } finally {
      INFLIGHT.delete(key);
    }
  })();
  INFLIGHT.set(key, p);
  return p;
}

// Stable cache keys exported so screens can paint instantly from disk.
export const FTV_CACHE = {
  HOME: 'home_v1',
  FT_HOME: 'ft_home_v1',
  OTTS: 'otts_v1',
  ottVods: (topicId: number, pid: number) => `ott_${topicId}_${pid}`,
};

const TTL_HOME = 3 * 60 * 1000; // 3 min — fresh enough, avoids refetch on every nav
const TTL_OTTS = 60 * 60 * 1000; // 1 h — OTT list changes rarely
const TTL_OTT_VODS = 5 * 60 * 1000; // 5 min for first page of an OTT

async function autoRegister(): Promise<string | null> {
  const account = 'vuser' + Math.floor(Math.random() * 900000 + 100000);
  const password = 'Vega@' + Math.floor(Math.random() * 900000 + 100000);
  const res = await post<{
    code: number;
    message: string;
    result: {token: string};
  }>('api/public/register', {account, password, device_id: getDeviceId()});
  if (res?.code === 10000) {
    store.setString(K_ACC, account);
    store.setString(K_PWD, password);
    store.setString(K_TOK, res.result.token);
    return res.result.token;
  }
  return null;
}

async function autoLogin(): Promise<string | null> {
  const acc = store.getString(K_ACC);
  const pwd = store.getString(K_PWD);
  if (!acc || !pwd) return autoRegister();
  const deviceId = getDeviceId();
  const res = await post<{code: number; result: {token: string}}>(
    'api/public/login',
    {account: acc, password: pwd, device_id: deviceId},
  );
  if (res?.code === 10000 && res.result?.token) {
    store.setString(K_TOK, res.result.token);
    return res.result.token;
  }
  return autoRegister();
}

// `api/vod/info_new` requires a real logged-in token; a stored token is only
// trusted after the server confirms it once per app run.
let tokenVerified = false;

export async function ensureToken(): Promise<string> {
  const tok = store.getString(K_TOK);
  if (tok && tokenVerified) return tok;
  if (tok) {
    const chk = await post<{code: number}>('api/user/info', {}, true);
    if (chk?.code === 10000) {
      tokenVerified = true;
      return tok;
    }
  }
  const next =
    (await autoLogin().catch(() => null)) ||
    (await autoRegister().catch(() => null)) ||
    '';
  if (next) tokenVerified = true;
  return next;
}

export interface FtVod {
  vod_id: number; // normalized: server sends `id` in recommend/topic, `vod_id` in hot_search
  vod_name: string;
  vod_pic: string;
  vod_year?: string;
  vod_douban_score?: string;
  vod_blurb?: string;
  vod_lang?: string;
  vod_area?: string;
  type_pid?: number;
  series_info?: any[];
  vod_collection?: any[];
  // Series metadata FilmTV ships with every list item (no detail call needed).
  vod_serial?: number | string;
  vod_total?: number | string;
  vod_isend?: number | string;
  vod_is_update?: number | string;
  vod_version?: any; // {"is_update":0,"update_episode":"11,0,0"}
  vod_actor?: string;
  vod_director?: string;
  vod_tag?: string;
  vod_en?: string;
  audio_language_tag?: string;
}

// ---------------------------------------------------------------------------
// Series seasons / episodes
//
// FilmTV stores EACH SEASON as its own vod entry (e.g. "India's Got Latent -
// Season 2", vod_area = "Season 2"), so a series' seasons are found by looking
// up its siblings in search results. Episodes per season come from the list
// metadata (vod_version.update_episode / vod_total). This is the data the
// FilmTV app itself shows without opening a gated detail call.
// ---------------------------------------------------------------------------
export interface FtSeason {
  season: number;
  vodId: number;
  title: string;
  poster: string;
  episodes: number;
  isEnd: boolean;
  item: FtVod;
}

/** Season number of a vod item (1 when the item is not labelled). */
export function ftvSeasonOf(v: FtVod): number {
  const m =
    (v.vod_area || '').match(/season\s*(\d+)/i) ||
    (v.vod_name || '').match(/season\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 1;
}

/** Episode count for a series item, from the list metadata only. */
export function ftvEpisodeCountOf(v: FtVod): number {
  try {
    if (v.vod_version) {
      const j =
        typeof v.vod_version === 'string'
          ? JSON.parse(v.vod_version)
          : v.vod_version;
      const first = String(j?.update_episode || '').split(',')[0];
      const n = parseInt(first, 10);
      if (n > 0) return n;
    }
  } catch {}
  const total = parseInt(String(v.vod_total ?? ''), 10);
  if (total > 0) return total;
  const serial = parseInt(String(v.vod_serial ?? ''), 10);
  if (serial > 0) return serial;
  return 1;
}

/** Show name without the "Season N" suffix. */
export function ftvBaseTitle(v: FtVod): string {
  return (v.vod_name || '')
    .replace(/[\s\-–—:]*(?:-\s*)?season\s*\d+.*$/i, '')
    .replace(/[\s\-–—:]+$/, '')
    .trim();
}

export interface FtChannel {
  id: number;
  name: string;
  pid: number;
}

export async function ftvChannels(): Promise<FtChannel[]> {
  // NOTE: server returns a BARE LIST [{id, channel_name, vod_type_id}] (verified live)
  const res = await post<{code: number; result: any}>('api/channel/get_list', {
    cgl: 1,
  });
  const r = res?.result;
  return Array.isArray(r) ? r : r?.list || [];
}

// Server sends items with `id` (recommend/topic) or `vod_id` (hot_search) — normalize to vod_id
function normVod(it: any): FtVod {
  return {...it, vod_id: it.vod_id ?? it.id};
}

export async function ftvHot(): Promise<FtVod[]> {
  const res = await post<{code: number; result: any[]}>(
    'api/search/hot_search',
  );
  return (res?.result || []).map(normVod);
}

// pid: 0 = All, 1 = Movies, 2 = Series (verified live)
export async function ftvTopicList(
  topicId: number,
  pid = 0,
  pn = 1,
  psize = 20,
): Promise<FtVod[]> {
  const res = await post<{code: number; result: any}>('api/topic/vod_list', {
    topic_id: topicId,
    pid,
    pn,
    psize,
  });
  // NOTE: server returns { vod_list: [...] } (NOT { list }) — verified live
  const lst = res?.result?.vod_list || res?.result?.list || [];
  return lst.map(normVod);
}

export async function ftvSearch(
  wd: string,
  pn = 1,
  psize = 20,
): Promise<FtVod[]> {
  // NOTE: search param is `kw` (NOT `wd`); returns a BARE LIST (verified live)
  const res = await post<{code: number; result: any}>('api/search/result', {
    kw: wd,
    pn,
    psize,
  });
  const r = res?.result;
  const lst = Array.isArray(r) ? r : r?.list || [];
  return lst.map(normVod);
}

/**
 * All seasons of a series, built from FilmTV's own list data: each season is a
 * separate vod entry, so we search the show name and group the matches by their
 * season number. Falls back to just the given item when nothing else is found.
 */
export async function ftvSeasons(vod: FtVod): Promise<FtSeason[]> {
  const base = ftvBaseTitle(vod);
  let candidates: FtVod[] = [vod];
  if (base) {
    const found = await ftvSearch(base, 1, 20).catch(() => [] as FtVod[]);
    const norm = (s: string) =>
      (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nb = norm(base);
    const siblings = found.filter(
      f => nb.length > 2 && norm(ftvBaseTitle(f)).startsWith(nb),
    );
    if (siblings.length) candidates = siblings;
  }

  // Several entries can share a season number (e.g. "(Special edition)");
  // prefer the cleanest match so the selector stays tidy.
  const rank = (it: FtVod): number => {
    const name = it.vod_name || '';
    const area = (it.vod_area || '').trim().toLowerCase();
    let score = 0;
    if (area === `season ${ftvSeasonOf(it)}`) score += 3;
    if (!/[()\[\]]/.test(name)) score += 2;
    score -= name.length / 1000; // shorter names win ties
    return score;
  };

  const bySeason = new Map<number, FtVod>();
  for (const it of candidates) {
    const s = ftvSeasonOf(it);
    const current = bySeason.get(s);
    if (!current || rank(it) > rank(current)) bySeason.set(s, it);
  }
  const ownSeason = ftvSeasonOf(vod);
  if (!bySeason.has(ownSeason)) bySeason.set(ownSeason, vod);

  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, item]) => ({
      season,
      vodId: item.vod_id,
      title: `Season ${season}`,
      poster: item.vod_pic,
      episodes: ftvEpisodeCountOf(item),
      isEnd: !!Number(item.vod_isend),
      item,
    }));
}

const HOME_QUERIES = [
  'movie',
  'series',
  'show',
  'love',
  'action',
  'drama',
  'comedy',
  'thriller',
  'horror',
  'anime',
];
// PAGINATED search recommend — 20 items per page, ENDLESS
export async function ftvRecommend(
  page: number = 1,
  psize = 20,
): Promise<FtVod[]> {
  const res = await post<{code: number; result: any[]}>(
    'api/search/recommend',
    {pn: page, psize},
  );
  return (res?.result || []).map(normVod);
}

// Banners from channel 520 (Home hero)
export async function ftvHomeBanners(): Promise<FtVod[]> {
  const res = await post<{code: number; result: any[]}>(
    'api/channel/get_info',
    {channel_id: 520},
  );
  const modules = res?.result || [];
  const banners: FtVod[] = [];
  for (const m of modules) {
    if (m.module_name === 'banner') {
      for (const b of m.block_list || []) {
        if (b.vod_info?.vod_name) banners.push(b.vod_info);
      }
    }
  }
  return banners;
}

// ---------------------------------------------------------------------------
// OTT section (FilmTV "Streaming" module)
// ---------------------------------------------------------------------------
export interface FtOtt {
  topic_id: number;
  name: string;
  pic: string;
}

// Fallback list in case the home module is unavailable (topic_ids verified live).
const DEFAULT_OTTS: FtOtt[] = [
  {topic_id: 7738, name: 'Netflix', pic: ''},
  {topic_id: 7737, name: 'Amazon', pic: ''},
  {topic_id: 7736, name: 'Apple TV', pic: ''},
  {topic_id: 7835, name: 'Apple TV+', pic: ''},
  {topic_id: 7833, name: 'Zee5', pic: ''},
  {topic_id: 7834, name: 'Sony Liv', pic: ''},
  {topic_id: 7830, name: 'Crunchyroll', pic: ''},
  {topic_id: 7896, name: 'JioHotstar', pic: ''},
  {topic_id: 7897, name: 'Aha', pic: ''},
];

// The OTT type filter tabs shown on the OTT page (verified live).
export const OTT_PIDS: {pid: number; name: string}[] = [
  {pid: 0, name: 'All'},
  {pid: 1, name: 'Movies'},
  {pid: 2, name: 'Series'},
];

// Raw home modules for a channel (520 = Recommend).
// This is EXACTLY the route FilmTV's home screen uses (HomeContentMultipleListViewModel
// -> channel/get_info with {channel_id, pn, cgi}). De-duped + cached: repeated callers
// (home + OTT row) share ONE request.
export async function ftvHomeModules(
  channelId = 520,
  pn = 1,
  psize = 50,
): Promise<any[]> {
  const fetcher = async () => {
    const res = await post<{code: number; result: any[]}>(
      'api/channel/get_info',
      {channel_id: channelId, cgi: 1, pn, psize},
    );
    return res?.result || [];
  };
  if (pn === 1) return cached(`modules_${channelId}`, TTL_HOME, fetcher);
  return fetcher();
}

// Home channels / tabs — FilmTV's HomePageViewModel route channel/get_list.
export async function ftvHomeChannels(): Promise<FtChannel[]> {
  return cached('channels', TTL_OTTS, async () => {
    const res = await post<{code: number; result: any}>(
      'api/channel/get_list',
      {cgl: 1},
    );
    const r = res?.result;
    const list = Array.isArray(r) ? r : r?.list || [];
    return list.map((c: any) => ({
      id: c.id,
      name: c.channel_name,
      pid: c.vod_type_id,
    }));
  });
}

// A single home content row (FilmTV "module"), e.g. "Trending Now".
export interface FtHomeRow {
  topic_id?: number;
  name: string;
  vods: FtVod[];
}

export interface FtHome {
  hero: FtVod[]; // banner items (banner_pic used as vod_pic)
  otts: FtOtt[]; // Streaming row
  rows: FtHomeRow[]; // content rows, each already carrying its vod_list
  feed: FtVod[]; // flat de-duped list for the poster grid
}

// Parse channel/get_info modules into hero + OTT row + content rows + flat feed.
// Module shapes (LIVE-VERIFIED):
//   banner    (type 1)  : block_list[i] = {banner_pic, vod_info}
//   Streaming (type 10) : block_list[i] = {topic_id, block_name, banner_pic}
//   others    (type 7/9): block_list[i] = {topic_id, block_name, config_num, vod_list[]}
function parseHomeModules(modules: any[]): FtHome {
  const hero: FtVod[] = [];
  const otts: FtOtt[] = [];
  const rows: FtHomeRow[] = [];
  const feed: FtVod[] = [];
  const seen = new Set<number>();

  const add = (it: any): FtVod | null => {
    if (!it || !it.vod_name) return null;
    const v = normVod(it);
    if (v?.vod_id && !seen.has(v.vod_id)) {
      seen.add(v.vod_id);
      feed.push(v);
    }
    return v;
  };

  for (const m of modules || []) {
    const name: string = m?.module_name || '';
    const blocks: any[] = m?.block_list || [];

    if (name === 'banner' || m?.type === 1) {
      for (const b of blocks) {
        const vi = b?.vod_info;
        const v = add(vi);
        if (v) hero.push({...v, vod_pic: b?.banner_pic || v.vod_pic});
      }
    } else if (name === 'Streaming' || m?.type === 10) {
      for (const b of blocks) {
        if (!b?.topic_id) continue;
        otts.push({
          topic_id: b.topic_id,
          name: b.block_name || b.name || 'OTT',
          pic: b.banner_pic || b.block_pic || b.vod_pic || '',
        });
      }
    } else {
      const vods: FtVod[] = [];
      for (const b of blocks) {
        const list: any[] = b?.vod_list || [];
        if (list.length) {
          for (const it of list) {
            const v = add(it);
            if (v) vods.push(v);
          }
        } else {
          const v = add(b);
          if (v) vods.push(v);
        }
      }
      if (vods.length) {
        rows.push({
          topic_id: blocks[0]?.topic_id,
          name: blocks[0]?.block_name || name || '',
          vods,
        });
      }
    }
  }

  return {hero, otts, rows, feed};
}

/**
 * The ranked chart row of a home payload — FilmTV ships it as "Hot Chart"
 * (topic 7746 live). Reads from `rows`, so it also works with home payloads
 * cached by an older build.
 */
export function ftvChartRow(home: FtHome | null | undefined): FtHomeRow | null {
  const rows = home?.rows || [];
  return (
    rows.find(r => /hot\s*chart/i.test(r.name)) ||
    rows.find(r => /top\s*10/i.test(r.name)) ||
    rows.find(r => /chart/i.test(r.name)) ||
    null
  );
}

/**
 * Top 10 rail: the first ten titles of the home chart row. The home payload
 * only carries nine of them, so the chart topic is asked for a couple more —
 * with the home row as fallback when that request fails.
 */
export async function ftvTop10(home?: FtHome | null): Promise<FtVod[]> {
  const row = ftvChartRow(home);
  const fallback = (row?.vods || []).slice(0, 10);
  const topicId = row?.topic_id;
  if (!topicId) return fallback;
  try {
    const list = await cached(`top10_${topicId}`, TTL_HOME, () =>
      ftvTopicList(topicId, 0, 1, 12),
    );
    return (list.length ? list : fallback).slice(0, 10);
  } catch {
    return fallback;
  }
}

// The full FilmTV-style home for a channel (default 520 = Recommend).
export async function ftvHome(channelId = 520, pn = 1): Promise<FtHome> {
  const fetcher = async () => {
    const modules = await ftvHomeModules(channelId, pn, 50);
    const parsed = parseHomeModules(modules);
    if (!parsed.otts.length) parsed.otts = DEFAULT_OTTS;
    return parsed;
  };
  if (pn === 1) return cached(FTV_CACHE.FT_HOME, TTL_HOME, fetcher);
  return fetcher();
}

/** Sync read of the last-known FilmTV home for an instant first paint. */
export function peekFtHome(): FtHome | null {
  return peekCache<FtHome>(FTV_CACHE.FT_HOME);
}

// Topic block items — FilmTV's HomeContentMultipleListViewModel route topic/change.
// Body: {topic_id, psize, not_vod_ids}. Returns a BARE LIST (verified live).
export async function ftvTopicChange(
  topicId: number,
  psize = 20,
  notVodIds = '',
): Promise<FtVod[]> {
  const res = await post<{code: number; result: any}>('api/topic/change', {
    topic_id: topicId,
    psize,
    not_vod_ids: notVodIds,
  });
  const r = res?.result;
  const lst = Array.isArray(r) ? r : r?.vod_list || r?.list || [];
  return lst.map(normVod);
}

// The OTT row lives in the "Streaming" module (type 10) of channel 520.
// Each item: { topic_id, block_name, banner_pic }.
export async function ftvOttList(): Promise<FtOtt[]> {
  return cached(FTV_CACHE.OTTS, TTL_OTTS, async () => {
    try {
      const modules = await ftvHomeModules(520);
      const stream = modules.find(
        (m: any) => m?.module_name === 'Streaming' || m?.type === 10,
      );
      const items: any[] = stream?.block_list || [];
      const list = items
        .filter(it => it?.topic_id)
        .map((it: any) => ({
          topic_id: it.topic_id,
          name: it.block_name || it.name || 'OTT',
          pic: it.banner_pic || it.block_pic || it.vod_pic || '',
        }));
      return list.length ? list : DEFAULT_OTTS;
    } catch {
      return DEFAULT_OTTS;
    }
  });
}

/** Sync read of the last-known OTT list for an instant first paint. */
export function peekOttList(): FtOtt[] | null {
  return peekCache<FtOtt[]>(FTV_CACHE.OTTS);
}

/** Sync read of the last-known home feed for an instant first paint. */
export function peekHome(): FtVod[] | null {
  const ft = peekCache<FtHome>(FTV_CACHE.FT_HOME);
  if (ft?.feed?.length) return ft.feed;
  return peekCache<FtVod[]>(FTV_CACHE.HOME);
}

/** Sync read of the last-known first page of an OTT for an instant first paint. */
export function peekOttVods(topicId: number, pid = 0): FtVod[] | null {
  return peekCache<FtVod[]>(FTV_CACHE.ottVods(topicId, pid));
}

// Content of a single OTT (e.g. Netflix = 7738). pid: 0 All / 1 Movies / 2 Series.
export async function ftvOttVods(
  topicId: number,
  pid = 0,
  pn = 1,
  psize = 20,
): Promise<FtVod[]> {
  const fetchPage = async () => {
    const res = await post<{code: number; result: any}>('api/topic/vod_list', {
      topic_id: topicId,
      pid,
      pn,
      psize,
    });
    const lst = res?.result?.vod_list || res?.result?.list || [];
    return lst.map(normVod);
  };
  // Only page 1 is cached (instant reopen of the same OTT); later pages always fresh.
  if (pn === 1)
    return cached(FTV_CACHE.ottVods(topicId, pid), TTL_OTT_VODS, fetchPage);
  return fetchPage();
}

// Flat home feed (poster grid) — comes from the same channel/get_info route
// FilmTV's home uses, with search/recommend as a fallback when empty.
export async function ftvHomeAll(): Promise<FtVod[]> {
  return cached(FTV_CACHE.HOME, TTL_HOME, async () => {
    try {
      const home = await ftvHome(520, 1);
      if (home.feed.length) return home.feed;
      const rec = await ftvRecommend(1, 24);
      return rec.length > 0 ? rec : await ftvHot();
    } catch {
      return await ftvHot();
    }
  });
}

// Cached home + OTT list in parallel for the OTT screen bootstrap.
export async function ftvOttHome(): Promise<{posts: FtVod[]; otts: FtOtt[]}> {
  const [home, posts] = await Promise.all([ftvHome(520, 1), ftvHomeAll()]);
  return {posts, otts: home.otts};
}

// ENDLESS scroll.
// page 1 = the channel/get_info home (161 items already), so further pages walk
// the home's own topic blocks via topic/change (LIVE-VERIFIED: channel/get_info
// pn>1 returns empty, so pn is NOT the pagination mechanism).
// Topic ids below are the real "type 7/9" row topic_ids from channel 520.
const HOME_TOPIC_IDS = [
  7753, 7959, 7745, 7821, 7746, 7809, 8041, 7781, 8049, 8046, 7810, 7896, 7833,
  7835, 7733, 7729,
];

export async function ftvHomeFeed(page: number, psize = 20): Promise<FtVod[]> {
  if (page <= 1) return ftvHomeAll();
  const idx = (page - 2) % HOME_TOPIC_IDS.length;
  const topicVods = await ftvTopicChange(HOME_TOPIC_IDS[idx], psize).catch(
    () => [] as FtVod[],
  );
  if (topicVods.length) return topicVods;
  const q = HOME_QUERIES[(page - 2) % HOME_QUERIES.length];
  return ftvSearch(q, 1, psize);
}

// ---------------------------------------------------------------------------
// Detail + playback (self-contained)
//
// The `api/vod/info_new` gate is an in-body sign generated by the native lib
// libpp_hls.so (via local /control?msg=verify). We reproduce it directly:
//   sign     = MD5(SIGN_SECRET + (device_id + vod_id) + cur_time).upper()
//   body     = { vod_id, cur_time, sign, audio_type }   + a logged-in token
// Response carries `vod_collection[]` with the real CDN mp4 urls (movies too).
//
// The CDN (CloudFront) serves an object as soon as the signed-url query params
// are present, so any non-empty Expires/Signature/Key-Pair-Id works.
// ---------------------------------------------------------------------------

/** Wrap a raw CDN url so it plays/downloads directly (no native helper needed). */
export function ftvPlayUrl(cdn: string): string {
  if (!cdn) return '';
  if (!/^https?:/i.test(cdn)) return cdn;
  const sep = cdn.includes('?') ? '&' : '?';
  return `${cdn}${sep}${CDN_SIG_PARAMS()}`;
}

export interface FtEpisode {
  index: number;
  title: string;
  cdn: string;
  playUrl: string;
  duration?: string;
}

/** Real episodes of a vod from an info_new payload (movies return a single one). */
export function ftvEpisodes(detail: any): FtEpisode[] {
  const raw = detail?.vod_collection || detail?.series_info || [];
  if (!Array.isArray(raw)) return [];
  const out: FtEpisode[] = [];
  raw.forEach((e: any, i: number) => {
    const cdn =
      e?.vod_url ||
      e?.orginal_url ||
      e?.down_url ||
      e?.play_url ||
      e?.url ||
      '';
    if (!cdn) return;
    out.push({
      index: out.length,
      title: String(e?.title ?? e?.name ?? i + 1),
      cdn,
      playUrl: ftvPlayUrl(cdn),
      duration: e?.duration ? String(e.duration) : undefined,
    });
  });
  return out;
}

/** Full detail for a vod, including the real CDN stream urls. */
export async function ftvVodInfo(
  vodId: number,
  audioType = 0,
): Promise<FtVod | null> {
  await ensureToken();
  const ts = Date.now().toString();
  const res = await post<{code: number; result: any}>(
    'api/vod/info_new',
    {
      vod_id: vodId,
      cur_time: ts,
      sign: bodySign(vodId, ts),
      audio_type: audioType,
    },
    true,
  );
  const r = res?.result;
  if (!r || (res?.code !== 10000 && res?.code != null)) return null;
  return {...r, vod_id: r.vod_id ?? r.id} as FtVod;
}

export async function ftvTopics(): Promise<any[]> {
  const res = await post<{code: number; result: any[]}>('api/topic/list');
  return res?.result || [];
}

export function initAuth(): Promise<string> {
  return ensureToken();
}
