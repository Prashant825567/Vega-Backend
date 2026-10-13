import {Router} from 'express';
import auth from './auth';
import vedu from './vedu';
import filmtv from './filmtv';
import shorts from './shorts';
import drama from './drama';
import live from './live';
import {authGate, ok} from './helpers';

/**
 * Every route the backend serves, under `/api`.
 *
 * The split is by provider, which is also how the app is organised: one provider
 * file per content source, one router per provider. `GET /api` below is the
 * index — it exists so that opening the deployed URL in a browser explains what
 * is here instead of answering 404.
 */

const router = Router();

// Auth sits above the gate because signing in cannot require being signed in:
// /auth/status answers publicly and /auth/token checks its own signature.
router.use('/auth', auth);

// One gate for the whole content API. With nothing configured it lets everything
// through, which is how it runs locally.
router.use(authGate);

router.use('/vedu', vedu);
router.use('/filmtv', filmtv);
router.use('/shorts', shorts);
router.use('/drama', drama);
router.use('/live', live);

/** GET /api — what this service is and where to start. */
router.get('/', (_req, res) => {
  ok(res, {
    service: 'vega-backend',
    providers: {
      vedu: {
        home: '/api/vedu/home?page=1',
        search: '/api/vedu/search?q=leo&page=1',
        details: '/api/vedu/details?htmlFile=https://www.57940&title=...&type=movie',
        episodes: '/api/vedu/episodes?htmlFile=...&type=series&keyName=...',
        stream: '/api/vedu/stream?htmlFile=...',
        download: '/api/vedu/download?htmlFile=...',
      },
      filmtv: {
        home: '/api/filmtv/home?channelId=520&page=1',
        feed: '/api/filmtv/feed?page=1&psize=20',
        channels: '/api/filmtv/channels',
        search: '/api/filmtv/search?q=...',
        vod: '/api/filmtv/vod/12345',
        episodes: '/api/filmtv/episodes?vodId=12345',
        seasons: '/api/filmtv/seasons?vodId=12345&name=...',
        ott: '/api/filmtv/ott',
      },
      shorts: {feed: '/api/shorts/feed?limit=20'},
      drama: {
        home: '/api/drama/home?page=1',
        search: '/api/drama/search?q=...',
        details: '/api/drama/details?link=https://new.microtv.st/post/...',
        stream: '/api/drama/stream?downloadLink=https://xdl.my.id/...',
      },
      live: {
        kinds: '/api/live/kinds',
        countries: '/api/live/countries?kind=tv',
        channels: '/api/live/channels?kind=tv&country=in',
        category: '/api/live/category?kind=tv&category=news',
        search: '/api/live/search?kind=tv&q=bbc',
        rows: '/api/live/rows?kind=tv',
        globe: '/api/live/globe',
      },
    },
    health: '/health',
  });
});

export default router;
