import {Router} from 'express';
import {
  OTT_PIDS,
  ftvChannels,
  ftvEpisodes,
  ftvHome,
  ftvHomeAll,
  ftvHomeBanners,
  ftvHomeChannels,
  ftvHomeFeed,
  ftvHot,
  ftvOttHome,
  ftvOttList,
  ftvOttVods,
  ftvPlayUrl,
  ftvRecommend,
  ftvSearch,
  ftvSeasons,
  ftvTop10,
  ftvTopicChange,
  ftvTopicList,
  ftvTopics,
  ftvVodInfo,
  ftvSeasonOf,
  ftvEpisodeCountOf,
  initAuth,
} from '../providers/filmtv';
import {cacheFor, clamp, fail, num, ok, route, str} from './helpers';

/**
 * FilmTV — the OTT provider (moviein / flickverse).
 *
 * Two of its endpoints are gated: `api/vod/info_new` needs a body signature that
 * binds the device id to the vod id, and the stream is served from a CDN that
 * only answers once the signed-URL query parameters are present. Both of those
 * already live in the provider (`bodySign`, `ftvPlayUrl`), which is why the
 * detail and episode routes below return playable URLs rather than a list of
 * vod ids to sign by hand.
 *
 * The account FilmTV needs is registered automatically on first use
 * (`ensureToken`, a throwaway account) and kept in the key/value store, so a
 * cold Render instance signs itself in again without any configuration.
 */

const router = Router();

const audioTypeOf = (value: unknown): number => clamp(num(value, 0), 0, 2);

/** GET /api/filmtv/channels — the channel tabs the home screen is built from. */
router.get(
  '/channels',
  cacheFor(3600),
  route(async (_req, res) => {
    ok(res, await ftvHomeChannels(), {provider: 'filmtv'});
  }),
);

/** GET /api/filmtv/home?channelId=520&page=1 — rows, banners and OTT blocks. */
router.get(
  '/home',
  cacheFor(60),
  route(async (req, res) => {
    const channelId = clamp(num(req.query.channelId, 520), 0, 100000);
    const page = clamp(num(req.query.page, 1), 1, 200);
    ok(res, await ftvHome(channelId, page), {provider: 'filmtv'});
  }),
);

/** GET /api/filmtv/feed?page=1&psize=20 — the endless scroll behind Home. */
router.get(
  '/feed',
  cacheFor(60),
  route(async (req, res) => {
    const page = clamp(num(req.query.page, 1), 1, 500);
    const psize = clamp(num(req.query.psize, 20), 1, 50);
    const posts = await ftvHomeFeed(page, psize);
    ok(res, posts, {provider: 'filmtv', page, count: posts.length});
  }),
);

/** GET /api/filmtv/home-all — page one of the feed on its own. */
router.get(
  '/home-all',
  cacheFor(60),
  route(async (_req, res) => {
    const posts = await ftvHomeAll();
    ok(res, posts, {provider: 'filmtv', count: posts.length});
  }),
);

/** GET /api/filmtv/hot — the provider's hot list. */
router.get(
  '/hot',
  cacheFor(300),
  route(async (_req, res) => {
    const posts = await ftvHot();
    ok(res, posts, {provider: 'filmtv', count: posts.length});
  }),
);

/** GET /api/filmtv/banners — the posters the home hero rotates. */
router.get(
  '/banners',
  cacheFor(300),
  route(async (_req, res) => {
    const posts = await ftvHomeBanners();
    ok(res, posts, {provider: 'filmtv', count: posts.length});
  }),
);

/** GET /api/filmtv/top10?channelId=520 — the chart row, resolved to ten vods. */
router.get(
  '/top10',
  cacheFor(120),
  route(async (req, res) => {
    const channelId = clamp(num(req.query.channelId, 520), 0, 100000);
    const home = await ftvHome(channelId, 1);
    const posts = await ftvTop10(home);
    ok(res, posts, {provider: 'filmtv', count: posts.length});
  }),
);

/** GET /api/filmtv/search?q=...&page=1&psize=20 */
router.get(
  '/search',
  route(async (req, res) => {
    const query = str(req.query.q);
    if (!query) {
      fail(res, 400, 'q is required');
      return;
    }
    const page = clamp(num(req.query.page, 1), 1, 100);
    const psize = clamp(num(req.query.psize, 20), 1, 50);
    const posts = await ftvSearch(query, page, psize);
    ok(res, posts, {provider: 'filmtv', query, page, count: posts.length});
  }),
);

/** GET /api/filmtv/topics — every topic id, for a client that browses by row. */
router.get(
  '/topics',
  cacheFor(3600),
  route(async (_req, res) => {
    ok(res, await ftvTopics(), {provider: 'filmtv'});
  }),
);

/** GET /api/filmtv/topic?topicId=...&pid=0&page=1&psize=20 */
router.get(
  '/topic',
  cacheFor(120),
  route(async (req, res) => {
    const topicId = num(req.query.topicId, 0);
    if (!topicId) {
      fail(res, 400, 'topicId is required');
      return;
    }
    const pid = clamp(num(req.query.pid, 0), 0, 100);
    const page = clamp(num(req.query.page, 1), 1, 200);
    const psize = clamp(num(req.query.psize, 20), 1, 50);
    const posts = await ftvTopicList(topicId, pid, page, psize);
    ok(res, posts, {provider: 'filmtv', topicId, page, count: posts.length});
  }),
);

/** GET /api/filmtv/topic/change?topicId=...&psize=20&notVodIds=1,2 */
router.get(
  '/topic/change',
  route(async (req, res) => {
    const topicId = num(req.query.topicId, 0);
    if (!topicId) {
      fail(res, 400, 'topicId is required');
      return;
    }
    const psize = clamp(num(req.query.psize, 20), 1, 50);
    const posts = await ftvTopicChange(
      topicId,
      psize,
      str(req.query.notVodIds),
    );
    ok(res, posts, {provider: 'filmtv', topicId, count: posts.length});
  }),
);

/** GET /api/filmtv/recommend?page=1&psize=20 */
router.get(
  '/recommend',
  cacheFor(120),
  route(async (req, res) => {
    const page = clamp(num(req.query.page, 1), 1, 200);
    const psize = clamp(num(req.query.psize, 20), 1, 50);
    const posts = await ftvRecommend(page, psize);
    ok(res, posts, {provider: 'filmtv', page, count: posts.length});
  }),
);

/** GET /api/filmtv/ott — the streaming services shown as a row. */
router.get(
  '/ott',
  cacheFor(600),
  route(async (_req, res) => {
    ok(res, await ftvOttList(), {provider: 'filmtv'});
  }),
);

/** GET /api/filmtv/ott/home — the OTT row plus the home feed in one call. */
router.get(
  '/ott/home',
  cacheFor(60),
  route(async (_req, res) => {
    ok(res, await ftvOttHome(), {provider: 'filmtv'});
  }),
);

/** GET /api/filmtv/ott/vods?topicId=...&pid=0&page=1&psize=20 */
router.get(
  '/ott/vods',
  cacheFor(120),
  route(async (req, res) => {
    const topicId = num(req.query.topicId, 0);
    if (!topicId) {
      fail(res, 400, 'topicId is required');
      return;
    }
    const pid = clamp(num(req.query.pid, 0), 0, 100);
    const page = clamp(num(req.query.page, 1), 1, 200);
    const psize = clamp(num(req.query.psize, 20), 1, 50);
    const posts = await ftvOttVods(topicId, pid, page, psize);
    ok(res, posts, {provider: 'filmtv', topicId, pid, page, count: posts.length});
  }),
);

/** GET /api/filmtv/ott/pids — the Movie / Series filter a row is shown with. */
router.get('/ott/pids', (_req, res) => {
  ok(res, OTT_PIDS, {provider: 'filmtv'});
});

/**
 * GET /api/filmtv/vod/:id?audioType=0
 *
 * The detail screen in one call: the vod itself, plus its real episodes with the
 * signed CDN url each one plays from. A movie answers with a single episode,
 * which is exactly how the app treats it.
 */
router.get(
  '/vod/:id',
  route(async (req, res) => {
    const vodId = num(req.params.id, 0);
    if (!vodId) {
      fail(res, 400, 'a numeric vod id is required');
      return;
    }
    const detail = await ftvVodInfo(vodId, audioTypeOf(req.query.audioType));
    if (!detail) {
      fail(res, 404, 'FilmTV has no such vod', 'filmtv');
      return;
    }
    const episodes = ftvEpisodes(detail);
    ok(
      res,
      {...detail, episodes},
      {
        provider: 'filmtv',
        vodId,
        season: ftvSeasonOf(detail),
        episodeCount: episodes.length || ftvEpisodeCountOf(detail),
      },
    );
  }),
);

/** GET /api/filmtv/episodes?vodId=...&audioType=0 — just the playable parts. */
router.get(
  '/episodes',
  route(async (req, res) => {
    const vodId = num(req.query.vodId, 0);
    if (!vodId) {
      fail(res, 400, 'vodId is required');
      return;
    }
    const detail = await ftvVodInfo(vodId, audioTypeOf(req.query.audioType));
    if (!detail) {
      fail(res, 404, 'FilmTV has no such vod', 'filmtv');
      return;
    }
    const episodes = ftvEpisodes(detail);
    ok(res, episodes, {provider: 'filmtv', vodId, count: episodes.length});
  }),
);

/**
 * GET /api/filmtv/seasons?vodId=...&name=...
 *
 * FilmTV keeps a series' seasons as separate vods, so this looks up every vod
 * that shares the base title and answers them in order, each with how many
 * episodes it holds. `name` is what the lookup searches on — the vod's own name
 * is the right value, and it is what the app passes.
 */
router.get(
  '/seasons',
  cacheFor(300),
  route(async (req, res) => {
    const vodId = num(req.query.vodId, 0);
    const name = str(req.query.name);
    if (!vodId || !name) {
      fail(res, 400, 'vodId and name are both required');
      return;
    }
    const seasons = await ftvSeasons({
      vod_id: vodId,
      vod_name: name,
      vod_pic: str(req.query.pic),
      vod_area: str(req.query.area),
    });
    ok(
      res,
      seasons.map(season => ({
        season: season.season,
        title: season.title,
        vodId: season.vodId,
        poster: season.poster,
        episodes: season.episodes,
        isEnd: season.isEnd,
        // The vod itself, so a client can open any season with one more call.
        vod: season.item,
      })),
      {provider: 'filmtv', count: seasons.length},
    );
  }),
);

/**
 * GET /api/filmtv/play?url=...
 *
 * Adds the CDN query parameters to a raw stream url. The detail and episode
 * routes already do this; the route exists for a client that stored a url
 * earlier and needs a fresh one (the parameters carry an expiry).
 */
router.get(
  '/play',
  route(async (req, res) => {
    const url = str(req.query.url);
    if (!url) {
      fail(res, 400, 'url is required');
      return;
    }
    ok(res, {url: ftvPlayUrl(url)}, {provider: 'filmtv'});
  }),
);

/**
 * GET /api/filmtv/status — proves the provider's account and signing work.
 *
 * `initAuth` is the same call the first real request makes, so a 200 here means
 * the tokens and the CDN signing are live; a failure here explains every 404 the
 * detail route would otherwise answer on its own.
 */
router.get(
  '/status',
  route(async (_req, res) => {
    const token = await initAuth();
    ok(res, {authenticated: Boolean(token)}, {provider: 'filmtv'});
  }),
);

/** GET /api/filmtv/channels-raw — the provider's own channel list, unfiltered. */
router.get(
  '/channels-raw',
  cacheFor(3600),
  route(async (_req, res) => {
    const channels = await ftvChannels();
    ok(res, channels, {provider: 'filmtv', count: channels.length});
  }),
);

export default router;
