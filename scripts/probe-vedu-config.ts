/**
 * The Vedu znote.php config, in full.
 *
 * The app's own notes say this response carries the endpoint list and the
 * `SheetAgent` header, and it answers here — so the fastest way to find out what
 * the play endpoint is actually called (rather than guessing names until one
 * stops answering 404) is to read it.
 *
 * Run: npx tsx scripts/probe-vedu-config.ts
 */

import axios from 'axios';

const API = 'https://markso.org/Vedu/Files';

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

const main = async (): Promise<void> => {
  const address = randomAddress();
  const body = {
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
    ...authPair(),
  };

  const res = await axios.post(`${API}/znote.php`, toForm(body), {
    headers: {
      'User-Agent': 'VeduDefo',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    timeout: 25000,
  });

  const data = res.data;
  const list = data?.allMixDataList || data;
  console.log(`config blocks: ${Array.isArray(list) ? list.length : 1}\n`);
  console.log(JSON.stringify(list, null, 1).slice(0, 12000));
};

void main();
