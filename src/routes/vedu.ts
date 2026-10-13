import {Router} from 'express';
import {
  createEpisodeLink,
  createVeduLink,
  ensureAddress,
  getVeduDownloadStreams,
  getVeduEpisodes,
  getVeduHomePosts,
  getVeduMetaData,
  getVeduSearchPosts,
  getVeduStream,
  parseVeduLink,
} from '../providers/vedu';
import {cacheFor, clamp, fail, num, ok, route, str, veduLink} from './helpers';

/**
 * Vedu — the movie and series catalogue the app's Home and Search are built on.
 *
 * Every endpoint here is the provider function the app calls, with query
 * parameters instead of JavaScript arguments. The one thing worth understanding
 * is the `link`: Vedu content is addressed by a JSON payload (htmlFile + title +
 * type + keyName) rather than by an id, and that payload is what the app stores
 * in its own lists. These routes accept either that payload (`?link=...`) or the
 * fields it is made of, so both the app and a plain HTTP caller can use them.
 *
 * A `quality` is not a choice to make here: the play and download routes ask for
 * every quality the provider knows and answer with the ones that resolved, which
 * is what the app's player does with its quality menu.
 */

const router = Router();

/** The payload a caller asked about, or 400 when there is nothing to look up. */
const payloadOf = (link: string): Record<string, unknown> | null =>
  parseVeduLink(link) as Record<string, unknown> | null;

const listOf = async (
  res: Parameters<typeof ok>[0],
  rows: unknown[],
  page: number,
  extra: Record<string, unknown> = {},
): Promise<void> => {
  ok(res, rows, {page, count: rows.length, ...extra});
};

/** GET /api/vedu/home?page=1 — "just added", 30 a page. */
router.get(
  '/home',
  cacheFor(120),
  route(async (req, res) => {
    const page = clamp(num(req.query.page, 1), 1, 500);
    const posts = await getVeduHomePosts(page, undefined);
    await listOf(res, posts, page, {provider: 'vedu'});
  }),
);

/** GET /api/vedu/search?q=...&page=1 */
router.get(
  '/search',
  route(async (req, res) => {
    const query = str(req.query.q);
    if (!query) {
      fail(res, 400, 'q is required');
      return;
    }
    const page = clamp(num(req.query.page, 1), 1, 100);
    const posts = await getVeduSearchPosts(query, page, undefined);
    await listOf(res, posts, page, {provider: 'vedu', query});
  }),
);

/** GET /api/vedu/details?link=... | ?htmlFile=...&type=&title=... */
router.get(
  '/details',
  cacheFor(300),
  route(async (req, res) => {
    const link = veduLink(req);
    if (!payloadOf(link)) {
      fail(res, 400, 'htmlFile (or a ready link) is required');
      return;
    }
    const info = await getVeduMetaData(link, undefined);
    ok(res, info, {provider: 'vedu'});
  }),
);

/**
 * GET /api/vedu/episodes?link=... | ?htmlFile=...&keyName=...&type=series
 *
 * Series only — a movie has one file and the provider answers an empty list.
 */
router.get(
  '/episodes',
  cacheFor(300),
  route(async (req, res) => {
    const link = veduLink(req);
    if (!payloadOf(link)) {
      fail(res, 400, 'htmlFile (or a ready link) is required');
      return;
    }
    const episodes = await getVeduEpisodes(link, undefined);
    ok(res, episodes, {provider: 'vedu', count: episodes.length});
  }),
);

/** GET /api/vedu/stream?link=... — every playable quality that resolved. */
router.get(
  '/stream',
  route(async (req, res) => {
    const link = veduLink(req);
    if (!payloadOf(link)) {
      fail(res, 400, 'htmlFile (or a ready link) is required');
      return;
    }
    const streams = await getVeduStream(link, undefined);
    ok(res, streams, {provider: 'vedu', count: streams.length});
  }),
);

/** GET /api/vedu/download?link=... — the same, signed for downloading. */
router.get(
  '/download',
  route(async (req, res) => {
    const link = veduLink(req);
    if (!payloadOf(link)) {
      fail(res, 400, 'htmlFile (or a ready link) is required');
      return;
    }
    const streams = await getVeduDownloadStreams(link, undefined);
    ok(res, streams, {provider: 'vedu', count: streams.length});
  }),
);

/**
 * GET /api/vedu/link?htmlFile=...&title=...&type=series&keyName=...
 *
 * Builds the payload link without fetching anything: a client that has just
 * listed the home page can turn a row into a link to store, exactly as the app
 * does, and hand it back to /details, /episodes or /stream later.
 */
router.get(
  '/link',
  route(async (req, res) => {
    const htmlFile = str(req.query.htmlFile);
    if (!htmlFile) {
      fail(res, 400, 'htmlFile is required');
      return;
    }
    const keyName = str(req.query.keyName);
    const pathName = str(req.query.season) || str(req.query.pathName);
    const link =
      str(req.query.type) === 'series' && keyName
        ? keyName && pathName
          ? createEpisodeLink(htmlFile, str(req.query.title), pathName)
          : createVeduLink({
              id: '',
              activity: '',
              ImageUrlHorizontal: str(req.query.image),
              ImageUrlVertical: str(req.query.image),
              movieName: str(req.query.title),
              htmlFile,
              directOne: '',
              directSecond: str(req.query.trailer, 'FALSE') || 'FALSE',
              imbd: str(req.query.imbd),
              rating: str(req.query.rating),
              catergory: str(req.query.category),
              Industry: str(req.query.industry),
              latest: '',
              latestCatergory: '',
              keyName,
              pathName,
              driveImageUrlHorizontal: '',
              driveImageUrlVertical: '',
            } as never)
        : JSON.stringify({
            backend: true,
            vedu: true,
            htmlFile,
            title: str(req.query.title),
            image: str(req.query.image),
            type: 'movie',
          });
    ok(res, {link, parsed: payloadOf(link)}, {provider: 'vedu'});
  }),
);

/**
 * GET /api/vedu/status — which half of Vedu is actually working right now.
 *
 * Vedu gates its endpoints per app version, and the two halves fail separately:
 * the listing endpoints (home, search, details, episodes) answer with the
 * captured 1.0.22 keys, while the play endpoint (`Data/NewTop.php`) answers an
 * empty `200` for everything — which is the state the vendor's own config
 * describes as the "video not playing" problem fixed in 1.0.24.
 *
 * So this route asks both questions for real: it lists a page, then tries to
 * resolve a stream for the first row it got. `listing` and `playback` in the
 * answer are what a caller needs to know before blaming their own client.
 */
router.get(
  '/status',
  route(async (_req, res) => {
    const address = await ensureAddress();
    const listing = await getVeduHomePosts(1, undefined).catch(() => []);
    const first = listing.find(post => post.link);
    const streams = first ? await getVeduStream(first.link, undefined) : [];
    ok(
      res,
      {
        address,
        listing: listing.length > 0,
        listedRows: listing.length,
        playback: streams.length > 0,
        playableQualities: streams.length,
        // What to do about it, in the answer itself.
        note:
          streams.length > 0
            ? 'Both halves answer.'
            : 'Listing works but play resolves nothing: Vedu has retired this build\'s keys for playback. Set VEDU_AUTH_PAIRS with a capture from the current app version to unlock it.',
      },
      {provider: 'vedu'},
    );
  }),
);

export default router;
