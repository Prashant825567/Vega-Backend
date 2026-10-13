import {Router} from 'express';
import {fetchMojFeed, refreshMojToken} from '../providers/shorts';
import {cacheFor, clamp, num, ok, route} from './helpers';

/**
 * Moj shorts — the vertical feed the app's Shorts screen scrolls.
 *
 * The feed is a private app API: it wants an Android set of headers and an
 * access token that expires, and the provider already refreshes that token when
 * the feed answers 401/403. There is nothing to configure here; a cold instance
 * fetches its token on the first call.
 *
 * The whole feed comes back in one response (it is a prefetch endpoint, not a
 * paged one), so the routes below fetch it and then slice, which keeps a caller
 * from re-fetching the same list just to show fewer items.
 */

const router = Router();

/** Fetches the feed once per request and hands back at most `limit` items. */
const feed = async (limit: number, offset: number) => {
  const items = await fetchMojFeed();
  return items.slice(offset, offset + limit);
};

/** GET /api/shorts/feed?limit=20&offset=0 */
router.get(
  '/feed',
  cacheFor(60),
  route(async (req, res) => {
    const limit = clamp(num(req.query.limit, 20), 1, 200);
    const offset = clamp(num(req.query.offset, 0), 0, 5000);
    const items = await feed(limit, offset);
    ok(res, items, {provider: 'moj', count: items.length, offset});
  }),
);

/** GET /api/shorts/refresh-token — forces a new access token. */
router.get(
  '/refresh-token',
  route(async (_req, res) => {
    const token = await refreshMojToken();
    ok(res, {refreshed: Boolean(token)}, {provider: 'moj'});
  }),
);

export default router;
