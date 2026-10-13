import axios from 'axios';

/**
 * The server's stand-in for the app's `HttpResolve` native module.
 *
 * MicroTV hands out its drama episodes through an `xdl.my.id` download page: you
 * POST it a form field, it answers `302` with the real signed URL in the
 * `Location` header, and the file itself lives on that URL. On Android the app
 * had to do this in Kotlin (`native-src/android/com/vega/HttpResolveModule.kt`)
 * because React Native's fetch follows redirects and never shows you where they
 * went. A server has no such problem: axios can be told not to follow, and the
 * header is then right there in the response.
 *
 * The request is copied field for field from the Kotlin module so the two agree
 * on what the download host is asked for: a urlencoded form body of one field,
 * the same mobile Chrome User-Agent, redirects off, and the same timeouts.
 */

/** The User-Agent the download host was written against (mobile Chrome). */
export const MOBILE_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

export type ResolveResult = {
  /** The status the download page answered with — normally 302. */
  status: number;
  /** Where it points, or null when it answered without a redirect. */
  location: string | null;
  /** The url that was asked, for the response the API hands back. */
  requestUrl: string;
};

/** The Kotlin module's 20s connect/read budget, in milliseconds. */
const TIMEOUT_MS = 20000;

/**
 * POSTs `[field]=[value]` and reads the raw redirect back instead of following
 * it. Throws when the host cannot be reached at all — a refused connection is a
 * different thing from a page that simply did not redirect, and the caller
 * reports them differently.
 */
export const resolvePostRedirect = async (
  url: string,
  field: string,
  value: string,
): Promise<ResolveResult> => {
  const body = new URLSearchParams();
  body.append(field, value);

  const res = await axios.post(url, body.toString(), {
    headers: {
      'User-Agent': MOBILE_CHROME_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // The whole point: the 302 is the answer, not a step on the way to it.
    maxRedirects: 0,
    timeout: TIMEOUT_MS,
    // 3xx must not be treated as a failure; it is the success case here.
    validateStatus: () => true,
    responseType: 'text',
    transitional: {silentJSONParsing: false},
  });

  const location = res.headers?.location;
  return {
    status: res.status,
    location: typeof location === 'string' && location.length ? location : null,
    requestUrl: url,
  };
};
