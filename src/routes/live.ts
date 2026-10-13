import {Router} from 'express';
import {
  FAMELACK_GLOBE_URL,
  FAMELACK_KINDS,
  FAMELACK_ROW_CATEGORIES,
  FamelackChannel,
  famelackAll,
  famelackByCategory,
  famelackChannelsByCountry,
  famelackCountries,
  famelackGlobeGeometryBase64,
  famelackSearch,
  famelackStream,
  famelackFlag,
  isYouTubeStream,
} from '../providers/live';
import {cacheFor, clamp, fail, num, ok, route, str} from './helpers';

/**
 * Live channels — the Famelack dataset (TV, radio and webcams).
 *
 * This is the one source with no signing, no token and no scrape: it is a public
 * GitHub dataset of plain JSON, one file per country and per category. That is
 * also why this router is the simplest here — it fetches, decorates each channel
 * with what a player needs (the stream url, whether it is a YouTube embed, the
 * flag) and answers.
 *
 * The 3D globe the app shows is a binary asset on famelack.com; the two globe
 * routes serve it and its parsed country table, so a client does not have to
 * decode the format itself.
 */

const router = Router();

type Kind = 'tv' | 'radio' | 'webcams';

const KINDS: Kind[] = ['tv', 'radio', 'webcams'];

const kindOf = (value: unknown): Kind => {
  const given = str(value, 'tv').toLowerCase() as Kind;
  return KINDS.includes(given) ? given : 'tv';
};

/**
 * A channel with the parts a player needs already worked out, so a client does
 * not have to know the dataset's `sources.streams` / `sources.youtube` order.
 */
const playable = (channel: FamelackChannel) => {
  const stream = famelackStream(channel);
  return {
    ...channel,
    flag: famelackFlag(channel.country),
    stream,
    isYouTube: isYouTubeStream(stream),
  };
};

/** GET /api/live/kinds — tv, radio or webcams. */
router.get('/kinds', (_req, res) => {
  ok(res, FAMELACK_KINDS, {provider: 'famelack'});
});

/** GET /api/live/countries?kind=tv — name, capital and channel count per country. */
router.get(
  '/countries',
  cacheFor(3600),
  route(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const countries = await famelackCountries(kind);
    ok(res, countries, {
      provider: 'famelack',
      kind,
      count: Object.keys(countries).length,
    });
  }),
);

/** GET /api/live/channels?kind=tv&country=in */
router.get(
  '/channels',
  cacheFor(1800),
  route(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const country = str(req.query.country);
    if (!country) {
      fail(res, 400, 'country is required (a two letter code, e.g. in)');
      return;
    }
    const channels = await famelackChannelsByCountry(kind, country);
    ok(res, channels.map(playable), {
      provider: 'famelack',
      kind,
      country: country.toLowerCase(),
      count: channels.length,
    });
  }),
);

/** GET /api/live/category?kind=tv&category=news */
router.get(
  '/category',
  cacheFor(1800),
  route(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const category = str(req.query.category, 'all').toLowerCase();
    const channels = await famelackByCategory(kind, category);
    ok(res, channels.map(playable), {
      provider: 'famelack',
      kind,
      category,
      count: channels.length,
    });
  }),
);

/** GET /api/live/all?kind=tv — the whole catalogue of a mode. */
router.get(
  '/all',
  cacheFor(1800),
  route(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const channels = await famelackAll(kind);
    ok(res, channels.map(playable), {
      provider: 'famelack',
      kind,
      count: channels.length,
    });
  }),
);

/** GET /api/live/search?kind=tv&q=bbc&limit=200 */
router.get(
  '/search',
  cacheFor(600),
  route(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const query = str(req.query.q);
    if (!query) {
      fail(res, 400, 'q is required');
      return;
    }
    const limit = clamp(num(req.query.limit, 200), 1, 500);
    const found = await famelackSearch(kind, query);
    const channels = found.slice(0, limit).map(playable);
    ok(res, channels, {provider: 'famelack', kind, query, count: channels.length});
  }),
);

/**
 * GET /api/live/rows?kind=tv
 *
 * The four rows the app's Live screen shows, in display order, each already
 * filled — so one call is the whole screen.
 */
router.get(
  '/rows',
  cacheFor(1800),
  route(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const rows = await Promise.all(
      FAMELACK_ROW_CATEGORIES.map(async row => ({
        key: row.key,
        label: row.label,
        channels: (await famelackByCategory(kind, row.key)).map(playable),
      })),
    );
    ok(res, rows, {provider: 'famelack', kind, count: rows.length});
  }),
);

/** GET /api/live/globe — the globe geometry the app renders (base64). */
router.get(
  '/globe',
  cacheFor(3600),
  route(async (_req, res) => {
    const base64 = await famelackGlobeGeometryBase64();
    if (!base64) {
      fail(res, 502, 'famelack.com did not answer with the globe geometry', 'famelack');
      return;
    }
    ok(
      res,
      {url: FAMELACK_GLOBE_URL, bytes: Math.floor((base64.length * 3) / 4), base64},
      {provider: 'famelack'},
    );
  }),
);

/**
 * GET /api/live/globe/countries
 *
 * The globe's own country table, read out of the binary's JSON header: iso2/iso3
 * codes, names and the border adjacency the app uses to rotate the globe.
 */
router.get(
  '/globe/countries',
  cacheFor(3600),
  route(async (_req, res) => {
    const base64 = await famelackGlobeGeometryBase64();
    if (!base64) {
      fail(res, 502, 'famelack.com did not answer with the globe geometry', 'famelack');
      return;
    }
    // [0..4) uint32 LE = header length, then that much UTF-8 JSON.
    const bytes = Buffer.from(base64, 'base64');
    const headerLength = bytes.readUInt32LE(0);
    const header = JSON.parse(
      bytes.subarray(4, 4 + headerLength).toString('utf8'),
    ) as {
      version?: number;
      vertexCount?: number;
      countries?: unknown[];
      adjacency?: Record<string, string[]>;
    };
    ok(
      res,
      {
        version: header.version,
        vertexCount: header.vertexCount,
        countries: header.countries ?? [],
        adjacencyCountries: Object.keys(header.adjacency ?? {}).length,
        adjacency: header.adjacency ?? {},
      },
      {provider: 'famelack', count: (header.countries ?? []).length},
    );
  }),
);

export default router;
