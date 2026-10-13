/**
 * A live smoke test: every provider, over the real internet, through the real
 * routes — the same app the server runs, driven by supertest so nothing has to
 * bind a port.
 *
 * Run it with `npm run smoke`. It is deliberately not a pass/fail gate in one
 * direction: each provider is owned by somebody else, and two of them are known
 * to be unreliable from a server (Vedu gates its data per app version, and
 * MicroTV's download host may refuse a datacentre IP). What the script does is
 * say exactly which of them answered and what came back, so a red line is a
 * fact about the upstream rather than a mystery about this code.
 *
 * Some checks are chained, and that is the point: taking the first item a home
 * call returned and asking the details route about it is what proves the pieces
 * fit together — a link built by the provider is a link the next route accepts.
 */

import request from 'supertest';
import {createApp} from '../src/app';

const app = createApp();

type Outcome = {
  name: string;
  status: number;
  ms: number;
  summary: string;
  /** A value worth printing: a first title, a playable url, a count. */
  sample?: string;
};

const results: Outcome[] = [];

const shape = (body: any): {list?: any[]; sample?: string} => {
  const data = body?.data;
  if (Array.isArray(data)) {
    const first = data[0];
    return {
      list: data,
      sample: first?.title || first?.name || first?.vod_name || undefined,
    };
  }
  if (data && typeof data === 'object') {
    const sample =
      data.title ||
      data.vod_name ||
      (Array.isArray(data.rows) ? `${data.rows.length} rows` : undefined);
    return {sample};
  }
  return {};
};

const call = async (
  name: string,
  path: string,
  describe?: (body: any) => string,
): Promise<any> => {
  const started = Date.now();
  let res: request.Response | null = null;
  let failure = '';
  try {
    res = await request(app).get(path);
  } catch (error) {
    failure = (error as Error)?.message || String(error);
  }
  const ms = Date.now() - started;
  const body = res?.body;
  const {list, sample} = res ? shape(body) : {};

  let summary = failure
    ? `threw: ${failure}`
    : !res?.ok
    ? `${res?.status}: ${body?.error || 'failed'}`
    : describe
    ? describe(body)
    : Array.isArray(list)
    ? `${list.length} item(s)`
    : 'ok';

  results.push({
    name,
    status: res?.status ?? 0,
    ms,
    summary,
    sample: sample ? String(sample).slice(0, 90) : undefined,
  });

  return body;
};

const main = async (): Promise<void> => {
  console.log('vega-backend smoke test — live providers\n');

  // ---- the service itself -------------------------------------------------
  await call('health', '/health', () => 'up');
  await call('index', '/api', () => 'providers listed');

  // ---- vedu ---------------------------------------------------------------
  const veduHome = await call('vedu.home', '/api/vedu/home?page=1', b =>
    Array.isArray(b?.data) ? `${b.data.length} rows` : 'no rows',
  );
  // Which half of Vedu is alive today: listing, playback, or only listing.
  await call('vedu.status', '/api/vedu/status', b =>
    `listing ${b?.data?.listing ? 'yes' : 'no'}, playback ${
      b?.data?.playback ? 'yes' : 'no'
    }`,
  );
  const veduRows: any[] = Array.isArray(veduHome?.data) ? veduHome.data : [];
  const veduSearch = await call('vedu.search', '/api/vedu/search?q=leo&page=1');
  const searchRows: any[] = Array.isArray(veduSearch?.data) ? veduSearch.data : [];
  const candidates = [...searchRows, ...veduRows].filter(row => row?.link);

  const firstVedu = candidates[0] ?? null;
  if (firstVedu?.link) {
    const link = encodeURIComponent(firstVedu.link);
    await call('vedu.details', `/api/vedu/details?link=${link}`);
    await call('vedu.stream', `/api/vedu/stream?link=${link}`, b => {
      const first = b?.data?.[0];
      return first?.link
        ? `${b.data.length} quality(ies), first ${String(first.link).slice(0, 48)}`
        : 'no playable url';
    });
    await call('vedu.download', `/api/vedu/download?link=${link}`, b =>
      `${b?.data?.length ?? 0} quality(ies)`,
    );
  }

  // A series is not the first row every day, so the episode list is tried over
  // a handful of rows until one of them really is one — and the first episode it
  // finds is then played and downloaded, which is the whole point of this block.
  let episodeSource: {title: string; link: string; episodes: any[]} | null = null;
  for (const row of candidates.slice(0, 12)) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(row.link);
    } catch {
      continue;
    }
    if (parsed?.type !== 'series' || !parsed?.keyName) {
      continue;
    }
    const listed = await request(app).get(
      `/api/vedu/episodes?link=${encodeURIComponent(row.link)}`,
    );
    const episodes = listed.body?.data || [];
    if (episodes.length) {
      episodeSource = {title: row.title, link: row.link, episodes};
      break;
    }
  }

  if (episodeSource) {
    results.push({
      name: 'vedu.episodes',
      status: 200,
      ms: 0,
      summary: `${episodeSource.episodes.length} episode(s)`,
      sample: episodeSource.title,
    });
    const firstEpisodeLink = encodeURIComponent(episodeSource.episodes[0].link);
    await call(
      'vedu.episode.stream',
      `/api/vedu/stream?link=${firstEpisodeLink}`,
      b => `${b?.data?.length ?? 0} quality(ies)`,
    );
    await call(
      'vedu.episode.download',
      `/api/vedu/download?link=${firstEpisodeLink}`,
      b => `${b?.data?.length ?? 0} quality(ies)`,
    );
  } else {
    results.push({
      name: 'vedu.episodes',
      status: 200,
      ms: 0,
      summary: 'no series among the first rows today',
    });
  }

  // ---- filmtv -------------------------------------------------------------
  await call('filmtv.status', '/api/filmtv/status', b =>
    b?.data?.authenticated ? 'signed in' : 'no token',
  );
  await call('filmtv.channels', '/api/filmtv/channels');
  const filmHome = await call('filmtv.home', '/api/filmtv/home?channelId=520', b =>
    `${b?.data?.rows?.length ?? 0} rows, ${b?.data?.feed?.length ?? 0} in feed`,
  );
  await call('filmtv.feed', '/api/filmtv/feed?page=2&psize=10');
  await call('filmtv.hot', '/api/filmtv/hot');
  const search = await call('filmtv.search', '/api/filmtv/search?q=avatar');
  await call('filmtv.ott', '/api/filmtv/ott');
  const vod = Array.isArray(search?.data) ? search.data[0] : null;
  const vodId =
    vod?.vod_id || (Array.isArray(filmHome?.data?.feed) ? filmHome.data.feed[0]?.vod_id : 0);
  if (vodId) {
    await call(`filmtv.vod(${vodId})`, `/api/filmtv/vod/${vodId}`, b =>
      `${b?.data?.episodes?.length ?? 0} episode(s)`,
    );
    await call(`filmtv.episodes(${vodId})`, `/api/filmtv/episodes?vodId=${vodId}`, b => {
      const first = b?.data?.[0];
      return first?.playUrl ? `plays from ${String(first.playUrl).slice(0, 60)}` : 'no url';
    });
  }

  // ---- shorts (moj) -------------------------------------------------------
  await call('shorts.feed', '/api/shorts/feed?limit=5');

  // ---- drama (microtv) ----------------------------------------------------
  const dramaHome = await call('drama.home', '/api/drama/home?page=1');
  await call('drama.search', '/api/drama/search?q=love');
  const drama = Array.isArray(dramaHome?.data) ? dramaHome.data[0] : null;
  if (drama?.link) {
    const details = await call(
      'drama.details',
      `/api/drama/details?link=${encodeURIComponent(drama.link)}`,
    );
    const downloadLink = details?.data?.downloadLink;
    if (downloadLink) {
      await call(
        'drama.stream',
        `/api/drama/stream?downloadLink=${encodeURIComponent(downloadLink)}`,
        b => (b?.data?.url ? `direct url ${String(b.data.url).slice(0, 60)}` : 'no url'),
      );
    }
  }

  // ---- live (famelack) ----------------------------------------------------
  await call('live.kinds', '/api/live/kinds');
  await call('live.countries', '/api/live/countries?kind=tv', b =>
    `${Object.keys(b?.data || {}).length} countries`,
  );
  await call('live.channels', '/api/live/channels?kind=tv&country=in');
  await call('live.category', '/api/live/category?kind=tv&category=news');
  await call('live.search', '/api/live/search?kind=tv&q=bbc');
  await call('live.rows', '/api/live/rows?kind=tv', b => `${b?.data?.length ?? 0} rows`);
  await call('live.globe/countries', '/api/live/globe/countries', b =>
    `${b?.data?.countries?.length ?? 0} countries`,
  );

  // ---- the report ---------------------------------------------------------
  console.log('');
  const pad = (text: string, width: number) => text.padEnd(width);
  console.log(
    `${pad('check', 26)} ${pad('status', 7)} ${pad('ms', 7)} result`,
  );
  console.log('-'.repeat(90));
  for (const row of results) {
    const mark = row.status >= 200 && row.status < 300 ? 'ok' : 'FAIL';
    console.log(
      `${pad(row.name, 26)} ${pad(`${row.status} ${mark}`, 7)} ${pad(
        String(row.ms),
        7,
      )} ${row.summary}`,
    );
    if (row.sample) {
      console.log(`${' '.repeat(26)} ${' '.repeat(7)} ${' '.repeat(7)}   e.g. ${row.sample}`);
    }
  }

  const good = results.filter(r => r.status >= 200 && r.status < 300).length;
  console.log('-'.repeat(90));
  console.log(`${good}/${results.length} checks answered 2xx.`);

  const unhealthy = results.filter(r => r.status === 0 || r.status >= 500);
  if (unhealthy.length) {
    console.log(
      '\nUpstream failures (not necessarily this code): ' +
        unhealthy.map(r => r.name).join(', '),
    );
  }

  // The service itself has to be healthy — that is the one thing this script
  // can honestly fail on.
  const service = results.find(r => r.name === 'health');
  process.exit(service && service.status === 200 ? 0 : 1);
};

void main();
