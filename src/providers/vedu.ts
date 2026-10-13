import axios from 'axios';
import {Post, Info, Stream, EpisodeLink, Link} from './types';

// ============================================================
// Vedu backend provider (markso.org)
// All endpoints live under /Vedu/Files/. Every request carries
// the app keys plus a device "address" that is registered once
// via znote.php (any 16-hex address works after registration).
// ============================================================

const API = 'https://markso.org/Vedu/Files';
const API_DATA = 'https://markso.org/Vedu/Files/Data';

// ---- 1.0.22 auth ----
// The 1.0.21 body keys (Key / KeyTwo / KeyThree + appKey 'areman') were
// retired server-side, which is why every call suddenly returned
// "Permission Denied". 1.0.22 sends `time` + `token` instead
// (plus the `bodyPart` device block) and uses appKey 'bhagwatnao'.
//
// The server verifies token == F(time) for the SAME time value that is
// sent, but it enforces NO freshness window, so a captured (time, token)
// pair keeps working indefinitely. That is also why a pair is a credential,
// not a constant: it is read from the environment and never baked in here, so
// a leaked repository cannot hand anybody playback.
/**
 * The pairs, from the host's environment only.
 *
 * Format: `VEDU_AUTH_PAIRS=time:token,time:token`. Several pairs are supported
 * so that one rejected pair can never break playback — `post()` rotates through
 * them and remembers the one that was accepted.
 *
 * They are a capture from an app build, and Vedu gates playback per version, so
 * this list has to be refreshed when the gate moves: if `/api/vedu/status`
 * reports `playback: false` while `listing: true`, the capture is from a build
 * Vedu has retired. See the README section on Vedu for how to take a new one.
 */
const AUTH_PAIRS: ReadonlyArray<{time: string; token: string}> = (
  process.env.VEDU_AUTH_PAIRS || ''
)
  .split(',')
  .map(pair => pair.split(':'))
  .filter(parts => parts.length === 2 && parts[0].trim() && parts[1].trim())
  .map(([time, token]) => ({time: time.trim(), token: token.trim()}));

/** Whether the host gave this service anything to sign its Vedu calls with. */
export const veduAuthConfigured = (): boolean => AUTH_PAIRS.length > 0;

const KEYS = {
  appKey: 'bhagwatnao',
  movieName: 'nati.toallasrud.vedu',
  version: '1.0.22',
  versionCode: '1',
  fileCount: '7',
  deviceInfo:
    'MANUFACTURER : Xiaomi , BRAND : Redmi , MODEL : 2201117TI',
  bodyPart:
    '{"device_id":"DB619230CE64103E92FE7C0995FCB1AC1F35C52908C209E9B46760F08B586F8D","app_guid":"d6e0c6a9-27d7-4558-abd6-a91f913637c4"}',
};

// The `address` is not part of the 1.0.22 signature check (the server
// accepts any 16-hex value), so a fixed address is fine.
const DEVICE_ADDRESS = '9abc6408cf6ac1a1';

// NOTE (live-verified): the HTTP User-Agent header is NOT 'VeduDefo' -
// that string is a body param. The real header comes from the
// 'SheetAgent' field of the znote.php registration response (falls
// back to 'FALSE' in prefs). Current server value:
const HEADERS = {'User-Agent': 'ExoPlayerLib/2.11.4_Sheet'};
const STREAM_HEADERS = {'User-Agent': 'ExoPlayerLib/2.11.4'};
const DOWNLOAD_HEADERS = {'User-Agent': 'ExoPlayerLib/2.11.4_Download'};

// React Native's URLSearchParams.toString() is broken (sends an
// incomplete body), so we build the form body manually - exactly
// like curl's -d flags which the Vedu server expects.
const toFormBody = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

// No registration round-trip is needed anymore: the 1.0.22 gate is the
// (time, token) pair, not the device address.
export const ensureAddress = async (): Promise<string> => DEVICE_ADDRESS;

// Shared 1.0.22 body params. `time` + `token` are injected per attempt
// inside post() so a rejected pair can be rotated automatically.
const baseParams = (address: string) => ({
  address,
  firebaseToken: 'false',
  'User-Agent': 'VeduDefo',
  appKey: KEYS.appKey,
  movieName: KEYS.movieName,
  fileCount: KEYS.fileCount,
  version: KEYS.version,
  versionCode: KEYS.versionCode,
  deviceInfo: KEYS.deviceInfo,
  bodyPart: KEYS.bodyPart,
});

// A request whose (time, token) pair does not verify comes back as the
// literal body "Permission Denied". Rotate through the captured pairs
// until one is accepted.
let activePair = 0;

const post = async <T = any>(
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
  timeout = 25000,
): Promise<T> => {
  if (!AUTH_PAIRS.length) {
    // Fail loudly and once, with the fix in the message. Rotating through an
    // empty list would silently return `null` and every Vedu route would look
    // like "no content" instead of "not configured".
    throw new Error(
      'VEDU_AUTH_PAIRS is not set, so no Vedu request can be signed. Set it to ' +
        'a capture from the current app build as time:token,time:token — see ' +
        '.env.example and the Vedu section of the README.',
    );
  }
  let lastBody: any = null;
  for (let attempt = 0; attempt < AUTH_PAIRS.length; attempt++) {
    const index = (activePair + attempt) % AUTH_PAIRS.length;
    const pair = AUTH_PAIRS[index];
    const {data} = await axios.post<T>(
      url,
      toFormBody({...params, time: pair.time, token: pair.token}),
      {
        headers: {
          ...HEADERS,
          'Content-Type':
            'application/x-www-form-urlencoded; charset=UTF-8',
        },
        signal,
        timeout,
      },
    );
    if (typeof data !== 'string' || !data.includes('Permission Denied')) {
      activePair = index;
      return data;
    }
    lastBody = data;
  }
  return lastBody as T;
};

// ---- Vedu item shape (shared by all list endpoints) ----
interface VeduItem {
  id: string;
  activity: string;
  ImageUrlHorizontal: string;
  ImageUrlVertical: string;
  movieName: string;
  htmlFile: string; // "https://www.57940" (movie) or comma separated (series episodes)
  directOne: string; // genre / language
  directSecond: string; // trailer id or "FALSE"
  imbd: string; // rating
  rating: string; // quality, e.g. "pDVDRip", "HD 1080p"
  catergory: string;
  Industry: string;
  latest: string;
  latestCatergory: string;
  keyName: string;
  pathName: string;
  driveImageUrlHorizontal: string;
  driveImageUrlVertical: string;
}

const isRealItem = (m: VeduItem): boolean =>
  Boolean(m?.movieName) &&
  /^https:\/\/www\.\d+/.test(m?.htmlFile || '') &&
  // Skip category-banner rows (htmlFile like https://www.00000)
  !/^https:\/\/www\.0+$/.test(m?.htmlFile || '');

const isSeriesItem = (m: VeduItem): boolean =>
  m?.keyName !== 'FALSE' && m?.pathName !== 'FALSE' && Boolean(m?.keyName);

// ---- payload link (compatible with isBackendLink) ----
interface VeduPayload {
  backend: true;
  vedu: true;
  htmlFile: string;
  title: string;
  image: string;
  type: 'movie' | 'series';
  imbd?: string;
  rating?: string;
  catergory?: string;
  Industry?: string;
  keyName?: string;
  pathName?: string;
  trailer?: string;
}

export const createVeduLink = (m: VeduItem): string =>
  JSON.stringify({
    backend: true,
    vedu: true,
    htmlFile: m.htmlFile,
    title: m.movieName,
    image: m.ImageUrlVertical || m.ImageUrlHorizontal,
    type: isSeriesItem(m) ? 'series' : 'movie',
    imbd: m.imbd,
    rating: m.rating,
    catergory: m.catergory,
    Industry: m.Industry,
    keyName: isSeriesItem(m) ? m.keyName : undefined,
    pathName: isSeriesItem(m) ? m.pathName : undefined,
    trailer: m.directSecond !== 'FALSE' ? m.directSecond : undefined,
  } as VeduPayload);

export const createEpisodeLink = (
  htmlFile: string,
  title: string,
  seasonTitle?: string,
): string =>
  JSON.stringify({
    backend: true,
    vedu: true,
    htmlFile,
    title,
    type: 'series',
    pathName: seasonTitle,
  } as VeduPayload);

export const parseVeduLink = (link: string): VeduPayload | null => {
  try {
    const parsed = JSON.parse(link);
    if (parsed?.vedu === true && parsed?.htmlFile) {
      return parsed as VeduPayload;
    }
    return null;
  } catch {
    return null;
  }
};

const toPost = (m: VeduItem): Post => ({
  title: m.movieName,
  link: createVeduLink(m),
  image: m.ImageUrlVertical || m.ImageUrlHorizontal,
  provider: 'vedu',
});

const extractYear = (title: string): string => {
  const match = title.match(/\((\d{4})\)/);
  return match ? match[1] : '';
};

const formatSeasonTitle = (season?: string): string => {
  const normalized = (season || '').trim();
  const seasonNumber = normalized.match(/^S(?:EASON)?\s*(\d+)$/i)?.[1];
  return seasonNumber ? `Season ${seasonNumber}` : normalized || 'Episodes';
};

const normalizeQuality = (q?: string): Stream['quality'] | undefined => {
  if (!q) return undefined;
  const match = q.match(/(\d{3,4})/i);
  if (!match) return undefined;
  const num = parseInt(match[1], 10);
  if (num >= 2160) return '2160';
  if (num >= 1080) return '1080';
  if (num >= 720) return '720';
  if (num >= 480) return '480';
  if (num >= 360) return '360';
  return undefined;
};

// ============================================================
// HOME (Just Added – supports pagination via start offset)
// ============================================================
export const getVeduHomePosts = async (
  page: number = 1,
  signal?: AbortSignal,
): Promise<Post[]> => {
  try {
    const address = await ensureAddress();
    const start = (page - 1) * 30;
    const data = await post<any>(
      `${API}/JustAddedListNew.php`,
      {...baseParams(address), start: String(start)},
      signal,
    );
    const list: VeduItem[] = data?.JustAddedList || [];
    return list.filter(isRealItem).map(toPost);
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') {
      throw error;
    }
    console.error('Vedu home error:', error);
    return [];
  }
};

// ============================================================
// SEARCH (server-side - exactly like the original Vedu app)
// ============================================================
// The original app posts the search word in the `htmlFile` field of
// SearchWordList.php and the server returns matching movies + series.
// This is fast (no full-catalog download) and matches the real app.
let lastSearchWord = '';
let searchCache: Post[] | null = null;
let searchPromise: Promise<Post[]> | null = null;

export const getVeduSearchPosts = async (
  query: string,
  page: number = 1,
  signal?: AbortSignal,
): Promise<Post[]> => {
  try {
    const q = (query || '').trim();
    if (!q) {
      return [];
    }
    // Reuse the in-memory result when the same word is searched again.
    if (searchCache && lastSearchWord === q) {
      return searchCache;
    }
    if (searchPromise && lastSearchWord === q) {
      return searchPromise;
    }
    lastSearchWord = q;
    searchPromise = (async () => {
      const address = await ensureAddress();
      const data = await post<any>(
        `${API}/SearchWordList.php`,
        {...baseParams(address), htmlFile: q},
        signal,
        30000,
      );
      const list: VeduItem[] = data?.SearchWordList || [];
      const posts = list.filter(isRealItem).map(toPost);
      searchCache = posts;
      return posts;
    })().finally(() => {
      searchPromise = null;
    });
    return searchPromise;
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') {
      throw error;
    }
    console.error('Vedu search error:', error);
    return [];
  }
};

// ============================================================
// EPISODES (web series)
// ============================================================
const fetchEpisodes = async (
  keyName: string,
  pathName: string,
  signal?: AbortSignal,
): Promise<VeduItem[]> => {
  const address = await ensureAddress();
  const first = await post<any>(
    `${API}/WebSeriesEpisodeListNew.php`,
    {
      ...baseParams(address),
      key: keyName,
      season: pathName,
      flag: '1',
      start: '0',
    },
    signal,
  );
  const arr = first?.alldata || [];
  const epObj = arr.find((x: any) => x?.WebSeriesEpisodeList);
  let episodes: VeduItem[] = epObj?.WebSeriesEpisodeList || [];
  const sizeObj = arr.find((x: any) => x?.EpisodeListSize);
  const total = parseInt(sizeObj?.EpisodeListSize?.size || '0', 10) || 0;

  // paginate remaining episodes if the series has more than one page
  let start = 30;
  while (episodes.length < total && start < 2000) {
    const next = await post<any>(
      `${API}/WebSeriesEpisodeListNew.php`,
      {
        ...baseParams(address),
        key: keyName,
        season: pathName,
        flag: '1',
        start: String(start),
      },
      signal,
    );
    const nextArr = next?.alldata || [];
    const nextObj = nextArr.find((x: any) => x?.WebSeriesEpisodeList);
    const nextEps: VeduItem[] = nextObj?.WebSeriesEpisodeList || [];
    if (nextEps.length === 0) break;
    episodes = [...episodes, ...nextEps];
    start += 30;
  }

  const seenFiles = new Set<string>();
  return episodes.filter(episode => {
    if (!episode?.htmlFile || seenFiles.has(episode.htmlFile)) {
      return false;
    }
    seenFiles.add(episode.htmlFile);
    return true;
  });
};

export const getVeduEpisodes = async (
  link: string,
  signal?: AbortSignal,
): Promise<EpisodeLink[]> => {
  const payload = parseVeduLink(link);
  if (!payload || payload.type !== 'series' || !payload.keyName) {
    return [];
  }
  try {
    const episodes = await fetchEpisodes(payload.keyName, payload.pathName || 'S1', signal);
    const uniqueNames = new Set(episodes.map(ep => ep.movieName));
    return episodes.map((ep, index) => ({
      id: ep.id,
      title:
        uniqueNames.size > 1
          ? ep.movieName
          : `Episode ${index + 1}${ep.rating && ep.rating !== 'FALSE' ? ` • ${ep.rating}` : ''}`,
      sourceLink: ep.htmlFile,
      link: createEpisodeLink(ep.htmlFile, ep.movieName || `Episode ${index + 1}`, payload.pathName),
    }));
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') {
      throw error;
    }
    console.error('Vedu episodes error:', error);
    return [];
  }
};

// ============================================================
// META DATA (details page)
// ============================================================
export const getVeduMetaData = async (
  linkOrPayload: string,
  signal?: AbortSignal,
): Promise<Info> => {
  const payload = parseVeduLink(linkOrPayload);
  if (!payload) {
    throw new Error('Vedu: invalid content link');
  }

  const isSeries = payload.type === 'series';
  const linkList: Link[] = [];

  if (isSeries) {
    // Season container – episodes resolved on demand by SeasonList
    linkList.push({
      title: formatSeasonTitle(payload.pathName),
      episodesLink: linkOrPayload,
    });
  } else {
    const htmlFiles = payload.htmlFile
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    linkList.push({
      title: payload.title || 'Watch',
      directLinks: htmlFiles.map(hf => ({
        title: payload.rating || 'Play',
        link: createEpisodeLink(hf, payload.title || '', undefined),
        type: 'movie' as const,
      })),
    });
  }

  const tags: string[] = [
    payload.catergory,
    payload.Industry,
    payload.trailer ? 'Trailer' : '',
  ].filter((t): t is string => Boolean(t));

  return {
    title: payload.title,
    image: payload.image,
    synopsis: '',
    imdbId: '',
    type: isSeries ? 'series' : 'movie',
    webUrl: '',
    tags,
    rating: payload.imbd || '',
    year: extractYear(payload.title),
    linkList,
  };
};

// ============================================================
// STREAMS (play + download)
//
// Mirrors the original Vedu app's behaviour in c4n8v1.smali: it POSTs
// to NewTop.php once per quality (quality = "1" / "2" / "3"). Each
// request resolves a signed stream URL for that specific quality.
// We do all three calls in parallel and return one Stream entry per
// resolved URL so that both the Player and the Downloader sheet can
// offer the user a quality picker.
// ============================================================

const qualityMappings = [
  {key: '1', label: '360p',  quality: '360'  as const},
  {key: '2', label: '720p',  quality: '720'  as const},
  {key: '3', label: '1080p', quality: '1080' as const},
];

const resolveNewTop = async (
  htmlFile: string,
  address: string,
  qualityKey: string,
  download: boolean,
  signal?: AbortSignal,
): Promise<string> => {
  const data = await post<string>(
    `${API_DATA}/NewTop.php`,
    {
      ...baseParams(address),
      htmlFile,
      quality: qualityKey,
      flag: download ? 'out' : 'in',
    },
    signal,
  );
  return String(data || '').replace(/[\r\n\s]+/g, '').trim();
};

export const getVeduStream = async (
  link: string,
  signal?: AbortSignal,
): Promise<Stream[]> => {
  const payload = parseVeduLink(link);
  if (!payload) {
    return [];
  }
  try {
    const address = await ensureAddress();
    const htmlFile = payload.htmlFile.split(',')[0].trim();

    // Hit all three qualities in parallel (matches the real app).
    const results = await Promise.allSettled(
      qualityMappings.map(q => resolveNewTop(htmlFile, address, q.key, false, signal)),
    );

    const streams: Stream[] = [];
    results.forEach((res, idx) => {
      if (res.status !== 'fulfilled') {
        return;
      }
      const url = res.value;
      if (!url.startsWith('http')) {
        return;
      }
      const q = qualityMappings[idx];
      if (streams.some(s => s.link === url)) {
        return; // skip duplicates (server may return same URL for multiple qualities)
      }
      streams.push({
        server: q.label,
        link: url,
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        quality: q.quality,
        headers: STREAM_HEADERS,
      });
    });

    // Fallback: if for some reason no quality-specific call returned a URL
    // (older content sometimes only resolves without the quality flag),
    // fall back to a plain call like the previous behaviour.
    if (streams.length === 0) {
      const fallback = await resolveNewTop(htmlFile, address, '', false, signal).catch(() => '');
      if (fallback.startsWith('http')) {
        const qualityLabel =
          payload.rating && payload.rating !== 'FALSE'
            ? payload.rating
            : 'Vega';
        streams.push({
          server: qualityLabel,
          link: fallback,
          type: fallback.includes('.m3u8') ? 'hls' : 'mp4',
          quality: normalizeQuality(payload.rating),
          headers: STREAM_HEADERS,
        });
      }
    }

    if (streams.length === 0) {
      console.warn('Vedu stream: no URL resolved for', htmlFile);
    }
    return streams;
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') {
      throw error;
    }
    console.error('Vedu stream error:', error);
    return [];
  }
};

// ============================================================
// DOWNLOAD STREAMS
//
// The original Vudu app resolves download URLs separately from
// playback URLs (see c4n8v1.smali `e()` and `f()`): it POSTs to
// NewTop.php with flag="out" and quality="1"/"2"/"3" to get a
// download-optimised signed URL per quality. Some content only
// resolves on the 1080p path (f() method hardcodes quality="2"),
// so we keep the 1080p attempt as a guaranteed fallback.
//
// Each resolved URL is then probed with a HEAD request (using the
// DownloadAgent user-agent) so we can show the REAL file size and
// drop qualities that do not actually exist on the server (404).
// ============================================================

const getDownloadFileSize = async (
  url: string,
  signal?: AbortSignal,
): Promise<number | undefined> => {
  try {
    const res = await axios.head(url, {
      headers: DOWNLOAD_HEADERS,
      signal,
      timeout: 15000,
    });
    const length = Number(res.headers?.['content-length']);
    return Number.isFinite(length) && length > 0 ? length : undefined;
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return 0; // quality does not exist on the server
    }
    return undefined; // size unknown - keep the stream anyway
  }
};

export const getVeduDownloadStreams = async (
  link: string,
  signal?: AbortSignal,
): Promise<Stream[]> => {
  const payload = parseVeduLink(link);
  if (!payload) {
    return [];
  }
  try {
    const address = await ensureAddress();
    const htmlFile = payload.htmlFile.split(',')[0].trim();

    const results = await Promise.allSettled(
      qualityMappings.map(q => resolveNewTop(htmlFile, address, q.key, true, signal)),
    );

    const streams: Stream[] = [];
    results.forEach((res, idx) => {
      if (res.status !== 'fulfilled') {
        return;
      }
      const url = res.value;
      if (!url.startsWith('http')) {
        return;
      }
      const q = qualityMappings[idx];
      if (streams.some(s => s.link === url)) {
        return;
      }
      streams.push({
        server: q.label,
        link: url,
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        quality: q.quality,
        headers: DOWNLOAD_HEADERS,
      });
    });

    // 1080p guaranteed fallback (mirrors c4n8v1.f()).
    if (!streams.some(s => s.quality === '1080')) {
      const forced = await resolveNewTop(htmlFile, address, '2', true, signal).catch(() => '');
      if (forced.startsWith('http') && !streams.some(s => s.link === forced)) {
        streams.push({
          server: '1080p',
          link: forced,
          type: forced.includes('.m3u8') ? 'hls' : 'mp4',
          quality: '1080',
          headers: DOWNLOAD_HEADERS,
        });
      }
    }

    // Probe each quality with a HEAD request to get the real file size
    // and drop qualities that do not exist (404) on the server.
    if (streams.length > 0) {
      const probed = await Promise.allSettled(
        streams.map(s => getDownloadFileSize(s.link, signal)),
      );
      const kept: Stream[] = [];
      probed.forEach((result, idx) => {
        const size = result.status === 'fulfilled' ? result.value : undefined;
        if (size === 0) {
          return; // 404 - quality not available, drop it
        }
        kept.push(size ? {...streams[idx], size} : streams[idx]);
      });
      if (kept.length > 0) {
        return kept.sort((a, b) => (b.size || 0) - (a.size || 0));
      }
    }

    if (streams.length === 0) {
      console.warn('Vedu download: no URL resolved for', htmlFile);
    }
    return streams;
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') {
      throw error;
    }
    console.error('Vedu download error:', error);
    return [];
  }
};
