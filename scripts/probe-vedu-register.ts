/**
 * Does Vedu's play endpoint want a *registered* device?
 *
 * Listing works with the captured 1.0.22 (time, token) pairs, but
 * `Data/NewTop.php` answers an empty 200 for every movie and episode tried. One
 * theory fits that: the play endpoint looks the device up (the app registers its
 * ANDROID_ID at startup via znote.php and then sends the SheetAgent it was given
 * as the HTTP User-Agent), while the listing endpoints do not care.
 *
 * This script registers a fresh random address the way the app's splash screen
 * does, prints what comes back, and then retries a play call with the address and
 * the header it got. If that starts returning URLs, the provider should register
 * once and keep the answer — which is a backend fix, not an app change.
 *
 * Run: npx tsx scripts/probe-vedu-register.ts
 */

import axios from 'axios';
import {getVeduSearchPosts, parseVeduLink} from '../src/providers/vedu';

const API = 'https://markso.org/Vedu/Files';

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

const randomAddress = (): string => {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
};

const toForm = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const post = async (
  url: string,
  params: Record<string, string>,
  userAgent: string,
): Promise<string> => {
  const res = await axios.post(url, toForm({...params, ...AUTH}), {
    headers: {
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    timeout: 20000,
    transformResponse: [(data: string) => data],
  });
  return String(res.data ?? '');
};

const main = async (): Promise<void> => {
  const address = randomAddress();
  console.log(`registering address ${address}\n`);

  const body: Record<string, string> = {
    address,
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

  for (const name of ['znote.php', 'Note.php', 'zNote.php']) {
    try {
      const answer = await post(`${API}/${name}`, body, 'VeduDefo');
      console.log(`${name} -> ${answer.slice(0, 600)}\n`);
    } catch (error) {
      console.log(`${name} -> threw ${(error as Error)?.message}\n`);
    }
  }

  // Whatever came back, the useful question is whether a play call changes when
  // the header carries a SheetAgent the server itself handed out.
  const posts = await getVeduSearchPosts('leo', 1);
  const htmlFile = posts[0] ? parseVeduLink(posts[0].link)?.htmlFile : '';
  if (!htmlFile) {
    console.log('nothing to play');
    return;
  }

  const sheet = 'ExoPlayerLib/2.11.4_Sheet';
  for (const agent of [
    sheet,
    'ExoPlayerLib/2.11.4',
    'Dalvik/2.1.0 (Linux; U; Android 11; ASUS_Z01QD Build/PI)',
  ]) {
    const answer = await post(
      `${API}/Data/NewTop.php`,
      {...body, htmlFile, quality: '1', flag: 'in'},
      agent,
    ).catch(error => `threw ${(error as Error)?.message}`);
    console.log(
      `NewTop.php as "${agent.slice(0, 34)}" -> ${
        String(answer).replace(/\s+/g, ' ').trim().slice(0, 160) || '(empty)'
      }`,
    );
  }
};

void main();
