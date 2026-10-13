/**
 * Vedu's play endpoint answers `200` with an empty body.
 *
 * `Data/NewTop.php` is the endpoint the app itself calls for both play (`flag=in`)
 * and download (`flag=out`), and the gate passes — the listing endpoints answer
 * fine with the same body — so the question is what shape this one wants. This
 * probe sends a spread of plausible shapes against one real htmlFile and prints
 * the bodies that came back with anything in them.
 *
 * Run: npx tsx scripts/probe-vedu-play.ts
 */

import axios from 'axios';
import {getVeduSearchPosts, parseVeduLink} from '../src/providers/vedu';

const API = 'https://markso.org/Vedu/Files';
const API_DATA = `${API}/Data`;
const HEADERS = {'User-Agent': 'ExpoPlayerLib/2.11.4_Sheet'};

/**
 * The (time, token) pair this probe signs with, from `VEDU_AUTH_PAIRS`.
 *
 * A captured pair is a credential, so it lives in the environment rather than in
 * this file — the same rule the server follows.
 */
const authPair = (): {time: string; token: string} => {
  const [time, token] = ((process.env.VEDU_AUTH_PAIRS || '').split(',')[0] || '').split(':');
  if (!time?.trim() || !token?.trim()) {
    throw new Error('Set VEDU_AUTH_PAIRS=time:token before running this probe.');
  }
  return {time: time.trim(), token: token.trim()};
};

const AUTH = authPair();

const base: Record<string, string> = {
  address: '9abc6408cf6ac1a1',
  firebaseToken: 'false',
  'User-Agent': 'VeduDefo',
  appKey: 'bhagwatnao',
  movieName: 'nati.toallasrud.vedu',
  fileCount: '7',
  version: '1.0.22',
  versionCode: '1',
  deviceInfo: 'MANUFACTURER : Xiaomi , BRAND : Redmi , MODEL : 2201117TI',
  bodyPart:
    '{"device_id":"DB619230CE64103E92FE7C0995FCB1AC1F35C52908C209E9B46760F08B586F8D","app_guid":"d6e0c6a9-27d7-4558-abd6-a91f913637c4"}',
};

const toForm = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const attempt = async (
  label: string,
  url: string,
  extra: Record<string, string>,
): Promise<void> => {
  const body = toForm({...base, ...AUTH, ...extra});
  try {
    const res = await axios.post(url, body, {
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      timeout: 20000,
      transformResponse: [(data: string) => data],
    });
    const text = String(res.data ?? '');
    const trimmed = text.replace(/\s+/g, ' ').trim();
    console.log(
      `${label.padEnd(46)} ${String(res.status).padEnd(4)} ${
        trimmed ? trimmed.slice(0, 120) : '(empty)'
      }`,
    );
  } catch (error) {
    console.log(
      `${label.padEnd(46)} threw  ${(error as Error)?.message?.slice(0, 80)}`,
    );
  }
};

const main = async (): Promise<void> => {
  const posts = await getVeduSearchPosts('leo', 1);
  const payload = posts[0] ? parseVeduLink(posts[0].link) : null;
  const htmlFile = payload?.htmlFile || 'https://www.21686';
  const bare = htmlFile.replace(/^https?:\/\//, '');
  console.log(`htmlFile: ${htmlFile}\n`);

  // Is it the endpoint, or is it this one movie? Ask about a spread of real
  // content — today's home rows, and the episodes of a series — before deciding.
  const {getVeduHomePosts, getVeduEpisodes} = await import(
    '../src/providers/vedu'
  );
  const spread: {label: string; htmlFile: string}[] = [];
  const home = await getVeduHomePosts(1).catch(() => []);
  home.slice(0, 6).forEach((post, index) => {
    const parsed = parseVeduLink(post.link);
    if (parsed?.htmlFile) {
      spread.push({label: `home row ${index + 1}: ${post.title}`, htmlFile: parsed.htmlFile});
    }
  });
  const seriesPost = home.find(post => parseVeduLink(post.link)?.type === 'series');
  if (seriesPost) {
    const episodes = await getVeduEpisodes(seriesPost.link).catch(() => []);
    episodes.slice(0, 4).forEach((episode, index) => {
      const parsed = episode.link ? parseVeduLink(episode.link) : null;
      if (parsed?.htmlFile) {
        spread.push({label: `episode ${index + 1} of ${seriesPost.title}`, htmlFile: parsed.htmlFile});
      }
    });
  }

  console.log('--- other real content ---');
  for (const candidate of spread) {
    await attempt(candidate.label, `${API_DATA}/NewTop.php`, {
      htmlFile: candidate.htmlFile,
      quality: '1',
      flag: 'in',
    });
  }
  console.log('--- one htmlFile, every shape ---');

  const url = `${API_DATA}/NewTop.php`;
  await attempt('quality=1 flag=in (what the app sends)', url, {
    htmlFile,
    quality: '1',
    flag: 'in',
  });
  await attempt('quality=3 flag=in', url, {htmlFile, quality: '3', flag: 'in'});
  await attempt('flag=in, no quality', url, {htmlFile, flag: 'in'});
  await attempt('quality=0 flag=in', url, {htmlFile, quality: '0', flag: 'in'});
  await attempt('quality=1 flag=out', url, {htmlFile, quality: '1', flag: 'out'});
  await attempt('bare htmlFile (no protocol)', url, {
    htmlFile: bare,
    quality: '1',
    flag: 'in',
  });
  await attempt('with type=1', url, {
    htmlFile,
    quality: '1',
    flag: 'in',
    type: '1',
  });
  await attempt('no quality, no flag', url, {htmlFile});

  // Other names the endpoint has carried in other builds of the app.
  for (const candidate of [
    'NewTopNew.php',
    'NewTopSingle.php',
    'Play.php',
    'MoviePlay.php',
    'NewPlay.php',
    'DataList.php',
  ]) {
    await attempt(`Data/${candidate}`, `${API_DATA}/${candidate}`, {
      htmlFile,
      quality: '1',
      flag: 'in',
    });
  }
  await attempt('NewTop.php (without Data/)', `${API}/NewTop.php`, {
    htmlFile,
    quality: '1',
    flag: 'in',
  });
};

void main();
