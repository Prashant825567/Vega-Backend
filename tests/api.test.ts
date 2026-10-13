import request from 'supertest';
import {createApp} from '../src/app';

/**
 * The API's own contract, with the providers stood in for.
 *
 * What is worth testing at this level is not the scraping — that lives in the
 * provider files, verbatim from the app — but the layer this project adds: one
 * answer shape, one failure shape, validation that refuses a request before it
 * reaches a provider, a 404 that says which route was asked for, and the
 * optional key that decides whether the deployment is public.
 */

jest.mock('../src/providers/vedu', () => ({
  getVeduHomePosts: jest.fn(async (page: number) => [
    {title: `row ${page}`, link: '{"vedu":true,"htmlFile":"x"}', image: 'i'},
  ]),
  getVeduSearchPosts: jest.fn(async (query: string) => [
    {title: `search ${query}`, link: 'l', image: 'i'},
  ]),
  getVeduMetaData: jest.fn(async (link: string) => ({
    title: 'A Film',
    image: 'i',
    synopsis: '',
    imdbId: '',
    type: 'movie',
    linkList: [],
  })),
  getVeduEpisodes: jest.fn(async () => []),
  getVeduStream: jest.fn(async () => [
    {server: '1080p', link: 'https://cdn/1.mp4', type: 'mp4', quality: '1080'},
  ]),
  getVeduDownloadStreams: jest.fn(async () => [
    {server: '720p', link: 'https://cdn/d.mp4', type: 'mp4', quality: '720'},
  ]),
  createVeduLink: jest.fn(() => '{"vedu":true,"htmlFile":"made"}'),
  createEpisodeLink: jest.fn(() => '{"vedu":true,"htmlFile":"ep"}'),
  parseVeduLink: jest.fn((link: string) => {
    try {
      const parsed = JSON.parse(link);
      return parsed?.vedu === true && parsed?.htmlFile ? parsed : null;
    } catch {
      return null;
    }
  }),
  ensureAddress: jest.fn(async () => '9abc6408cf6ac1a1'),
}));

jest.mock('../src/providers/live', () => ({
  FAMELACK_KINDS: [{key: 'tv', label: 'TV', icon: 'tv-outline'}],
  FAMELACK_ROW_CATEGORIES: [{key: 'news', label: 'News'}],
  FAMELACK_GLOBE_URL: 'https://famelack.com/assets/globe.bin',
  famelackCountries: jest.fn(async () => ({IN: {country: 'India'}})),
  famelackChannelsByCountry: jest.fn(async () => [
    {
      nanoid: 'abc',
      name: 'A Channel',
      country: 'in',
      sources: {streams: ['https://stream/1.m3u8']},
    },
  ]),
  famelackByCategory: jest.fn(async () => [
    {
      nanoid: 'yt',
      name: 'A YouTube Channel',
      country: 'us',
      sources: {youtube: ['https://youtube.com/watch?v=1']},
    },
  ]),
  famelackAll: jest.fn(async () => []),
  famelackSearch: jest.fn(async () => [
    {nanoid: 'bbc', name: 'BBC News', country: 'gb'},
  ]),
  famelackStream: jest.fn(
    (channel: {sources?: {streams?: string[]; youtube?: string[]}}) =>
      channel.sources?.streams?.[0] || channel.sources?.youtube?.[0] || '',
  ),
  isYouTubeStream: jest.fn((url: string) => /youtube\.com/i.test(url)),
  famelackFlag: jest.fn(() => '🇮🇳'),
  famelackGlobeGeometryBase64: jest.fn(async () => null),
}));

const app = createApp();

afterEach(() => {
  delete process.env.API_KEY;
});

describe('the service itself', () => {
  it('answers a health check a host can use as a liveness probe', async () => {
    const res = await request(app).get('/health').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('up');
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
  });

  it('explains every provider when the base url is opened', async () => {
    const res = await request(app).get('/api').expect(200);

    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.data.providers)).toEqual([
      'vedu',
      'filmtv',
      'shorts',
      'drama',
      'live',
    ]);
  });

  it('names the route it could not find instead of answering blank', async () => {
    const res = await request(app).get('/api/nope').expect(404);

    expect(res.body).toEqual({
      ok: false,
      error: 'No such route: GET /api/nope',
    });
  });
});

describe('the gate in front of the whole API', () => {
  it('lets everything through while nothing is configured', async () => {
    await request(app).get('/api/live/kinds').expect(200);
  });

  it('refuses without a credential, and points at the token endpoint', async () => {
    process.env.API_KEY = 's3cret';

    const refused = await request(app).get('/api/live/kinds').expect(401);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toContain('/api/auth/token');
  });

  it('accepts the legacy flat key by query and by header', async () => {
    process.env.API_KEY = 's3cret';

    await request(app).get('/api/live/kinds?key=s3cret').expect(200);
    await request(app)
      .get('/api/live/kinds')
      .set('x-api-key', 's3cret')
      .expect(200);
  });
});

describe('vedu routes', () => {
  it('pages the home list and says which page it answered', async () => {
    const res = await request(app).get('/api/vedu/home?page=3').expect(200);

    expect(res.body.page).toBe(3);
    expect(res.body.count).toBe(1);
    expect(res.body.provider).toBe('vedu');
    expect(res.body.data[0].title).toBe('row 3');
  });

  it('refuses an empty search before the provider is called', async () => {
    const res = await request(app).get('/api/vedu/search').expect(400);

    expect(res.body).toEqual({ok: false, error: 'q is required'});
  });

  it('passes the query and the page to the provider', async () => {
    const res = await request(app)
      .get('/api/vedu/search?q=leo&page=2')
      .expect(200);

    expect(res.body.query).toBe('leo');
    expect(res.body.data[0].title).toBe('search leo');
  });

  it('refuses a details call that names no content at all', async () => {
    const res = await request(app).get('/api/vedu/details').expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('htmlFile');
  });

  it('builds a payload link the provider can parse back', async () => {
    const res = await request(app)
      .get('/api/vedu/link?htmlFile=https://www.57940&title=A%20Film')
      .expect(200);

    expect(res.body.data.parsed.htmlFile).toBe('https://www.57940');
    expect(res.body.data.parsed.type).toBe('movie');
  });

  it('answers the playable qualities a stream call resolved', async () => {
    const res = await request(app)
      .get('/api/vedu/stream?htmlFile=https://www.57940')
      .expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      link: 'https://cdn/1.mp4',
      quality: '1080',
    });
  });
});

describe('live routes', () => {
  it('refuses a country list with no country', async () => {
    const res = await request(app).get('/api/live/channels?kind=tv').expect(400);

    expect(res.body.error).toContain('country');
  });

  it('decorates a channel with the url a player needs', async () => {
    const res = await request(app)
      .get('/api/live/channels?kind=tv&country=IN')
      .expect(200);

    expect(res.body.country).toBe('in');
    expect(res.body.data[0]).toMatchObject({
      name: 'A Channel',
      stream: 'https://stream/1.m3u8',
      isYouTube: false,
      flag: '🇮🇳',
    });
  });

  it('marks a YouTube-backed channel so a client can embed it', async () => {
    const res = await request(app)
      .get('/api/live/category?kind=tv&category=news')
      .expect(200);

    expect(res.body.data[0].isYouTube).toBe(true);
  });

  it('answers the four screen rows in one call', async () => {
    const res = await request(app).get('/api/live/rows?kind=tv').expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({key: 'news', label: 'News'});
  });

  it('falls back to a plain kind when a caller invents one', async () => {
    const res = await request(app)
      .get('/api/live/kinds?kind=podcasts')
      .expect(200);

    expect(res.body.data).toEqual([{key: 'tv', label: 'TV', icon: 'tv-outline'}]);
  });
});
