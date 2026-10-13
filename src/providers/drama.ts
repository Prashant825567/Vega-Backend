import axios from 'axios';
import * as cheerio from 'cheerio';
import {resolvePostRedirect} from '../lib/httpResolve';

// ============================================================
// MicroTV drama provider (new.microtv.st)
//
// Home grid   : GET https://new.microtv.st/?page=N
// Search      : GET https://new.microtv.st/?search=QUERY
// Story page  : GET https://new.microtv.st/post/{slug}
//               - h1                 -> title
//               - .featured-poster   -> poster image
//               - .download-btn href -> xdl.my.id download page
//
// The xdl download page only exposes the real video through a
// POST form (download=1) that answers with a 302 redirect to a
// signed googleusercontent URL. In the app that POST needed a native
// module (React Native's fetch hides redirects); here the server just
// does not follow them — see ../lib/httpResolve.
// ============================================================

const BASE = 'https://new.microtv.st';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export interface MicroTVPost {
  title: string;
  link: string;
  image: string;
}

export interface MicroTVDetails extends MicroTVPost {
  downloadLink: string | null;
}

/**
 * Why a stream could not be resolved. Previously every failure collapsed
 * into a bare `null`, which made a missing native module (release builds)
 * look identical to a dead link and left nothing to debug from.
 */
export type MicroTVStreamFailure =
  | 'details_failed'
  | 'no_download_link'
  | 'no_native_module'
  | 'request_failed'
  | 'no_location';

export class MicroTVStreamError extends Error {
  readonly reason: MicroTVStreamFailure;

  constructor(reason: MicroTVStreamFailure, message: string) {
    super(message);
    this.name = 'MicroTVStreamError';
    this.reason = reason;
  }
}

/**
 * Reads the failure reason without relying on `instanceof`, which is fragile
 * once classes get transpiled into the release bundle.
 */
export const toMicroTVStreamFailure = (error: unknown): MicroTVStreamFailure => {
  const reason = (error as Partial<MicroTVStreamError> | null)?.reason;
  return typeof reason === 'string' && MICROTV_STREAM_FAILURES.includes(reason as MicroTVStreamFailure)
    ? (reason as MicroTVStreamFailure)
    : 'request_failed';
};

const MICROTV_STREAM_FAILURES: MicroTVStreamFailure[] = [
  'details_failed',
  'no_download_link',
  'no_native_module',
  'request_failed',
  'no_location',
];

const cleanTitle = (raw: string): string =>
  raw
    .replace(/\s+/g, ' ')
    .replace(/\s*\|.*$/, '')
    .replace(/\s*Full Episode\s*$/i, '')
    .trim();

const scrapeGrid = (html: string, _baseUrl: string): MicroTVPost[] => {
  const $ = cheerio.load(html);
  const posts: MicroTVPost[] = [];
  const seen = new Set<string>();
  $('a[href*="/post/"]').each((_, el) => {
    const link = $(el).attr('href');
    if (!link || seen.has(link)) {
      return;
    }
    const img = $(el).find('img').first();
    const image = img.attr('src') || '';
    const title = img.attr('alt') || $(el).text().trim();
    if (!title) {
      return;
    }
    seen.add(link);
    posts.push({
      title: cleanTitle(title),
      link,
      image,
    });
  });
  return posts;
};

export const getMicroTVHome = async (
  page = 1,
  signal?: AbortSignal,
): Promise<MicroTVPost[]> => {
  try {
    const url = page > 1 ? `${BASE}/?page=${page}` : `${BASE}/`;
    const res = await axios.get(url, {headers: BROWSER_HEADERS, signal});
    return scrapeGrid(res.data, BASE);
  } catch (error) {
    console.error('MicroTV home error:', error);
    return [];
  }
};

export const getMicroTVSearch = async (
  query: string,
  signal?: AbortSignal,
): Promise<MicroTVPost[]> => {
  try {
    const url = `${BASE}/?search=${encodeURIComponent(query)}`;
    const res = await axios.get(url, {headers: BROWSER_HEADERS, signal});
    return scrapeGrid(res.data, BASE);
  } catch (error) {
    console.error('MicroTV search error:', error);
    return [];
  }
};

export const getMicroTVDetails = async (
  link: string,
  signal?: AbortSignal,
): Promise<MicroTVDetails> => {
  try {
    const res = await axios.get(link, {headers: BROWSER_HEADERS, signal});
    const $ = cheerio.load(res.data);
    const title = cleanTitle($('h1').first().text() || $('title').first().text());
    const image =
      $('img.featured-poster').first().attr('src') ||
      $('meta[property="og:image"]').attr('content') ||
      '';
    const downloadLink = $('a.download-btn').first().attr('href') || null;
    return {title, link, image, downloadLink};
  } catch (error) {
    console.error('MicroTV details error:', error);
    throw new MicroTVStreamError(
      'details_failed',
      `Could not load the story page: ${(error as Error)?.message || error}`,
    );
  }
};

/**
 * Resolves the xdl download page into a direct video URL by POSTing a field to
 * it and reading the 302 `Location` header back (redirects deliberately not
 * followed). The FSL button (Cloudflare R2, range-request friendly) is tried
 * first, then the plain Direct Download button.
 *
 * The one failure the app could only report and not fix — a build where the
 * native module was missing — cannot happen here, because the request is made
 * with axios on the same server that answers the API call.
 */
export const resolveMicroTVStream = async (
  downloadLink: string,
): Promise<string> => {
  try {
    // FSL (fast_cloud_r2_download) -> R2 host with range support
    let res = await resolvePostRedirect(
      downloadLink,
      'fast_cloud_r2_download',
      '1',
    );
    if (res.location && res.location.startsWith('http')) {
      return res.location;
    }
    // Direct Download -> googleusercontent signed URL
    res = await resolvePostRedirect(downloadLink, 'download', '1');
    if (res.location && res.location.startsWith('http')) {
      return res.location;
    }
    throw new MicroTVStreamError(
      'no_location',
      `Download page answered without a redirect (status ${res.status || 'unknown'}).`,
    );
  } catch (error) {
    if (
      error instanceof MicroTVStreamError ||
      typeof (error as any)?.reason === 'string'
    ) {
      throw error;
    }
    console.error('resolveMicroTVStream error:', error);
    throw new MicroTVStreamError(
      'request_failed',
      `Download request failed: ${(error as Error)?.message || error}`,
    );
  }
};
