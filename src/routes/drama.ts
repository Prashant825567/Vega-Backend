import {Router} from 'express';
import {
  getMicroTVDetails,
  getMicroTVHome,
  getMicroTVSearch,
  resolveMicroTVStream,
  toMicroTVStreamFailure,
} from '../providers/drama';
import {cacheFor, clamp, fail, num, ok, reasonOf, route, str} from './helpers';

/**
 * Drama — MicroTV (`new.microtv.st`), the provider behind the app's Drama tab.
 *
 * The story pages are ordinary HTML, so home, search and details are scrapes.
 * Playback is the interesting part: the page links to an `xdl.my.id` download
 * page, and only a POST to that page reveals where the episode really is. In the
 * app that POST had to run in native Kotlin (`HttpResolve`); here the server
 * simply makes the POST without following the redirect, which is why
 * `/stream` works with nothing installed on the device.
 */

const router = Router();

/** GET /api/drama/home?page=1 — the story grid. */
router.get(
  '/home',
  cacheFor(300),
  route(async (req, res) => {
    const page = clamp(num(req.query.page, 1), 1, 200);
    const posts = await getMicroTVHome(page, undefined);
    ok(res, posts, {provider: 'microtv', page, count: posts.length});
  }),
);

/** GET /api/drama/search?q=... */
router.get(
  '/search',
  route(async (req, res) => {
    const query = str(req.query.q);
    if (!query) {
      fail(res, 400, 'q is required');
      return;
    }
    const posts = await getMicroTVSearch(query, undefined);
    ok(res, posts, {provider: 'microtv', query, count: posts.length});
  }),
);

/**
 * GET /api/drama/details?link=https://new.microtv.st/post/...
 *
 * The story page: title, poster, and the download page its episode plays from.
 */
router.get(
  '/details',
  cacheFor(300),
  route(async (req, res) => {
    const link = str(req.query.link);
    if (!link) {
      fail(res, 400, 'link is required');
      return;
    }
    const details = await getMicroTVDetails(link, undefined);
    ok(res, details, {provider: 'microtv'});
  }),
);

/**
 * GET /api/drama/stream?downloadLink=https://xdl.my.id/...
 *
 * Answers the direct episode url. The failure reason travels with the error so a
 * caller can tell "the page did not redirect" from "the host refused us".
 */
router.get(
  '/stream',
  route(async (req, res) => {
    const downloadLink = str(req.query.downloadLink);
    if (!downloadLink) {
      fail(res, 400, 'downloadLink is required');
      return;
    }
    try {
      const url = await resolveMicroTVStream(downloadLink);
      ok(res, {url}, {provider: 'microtv'});
    } catch (error) {
      fail(
        res,
        502,
        `${toMicroTVStreamFailure(error)}: ${reasonOf(error)}`,
        'microtv',
      );
    }
  }),
);

export default router;
