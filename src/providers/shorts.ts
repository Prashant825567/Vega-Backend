const MOJ_API = 'https://moj-apis.sharechat.com';
const REFRESH_TOKEN_URL = `${MOJ_API}/account-service/v1.0.0/refreshToken`;
const REFRESH_TOKEN = '04895d816383011d9bdc';
let currentAccessToken = '945e1c3bc3f3e86a7ec3';

export async function refreshMojToken(): Promise<string> {
  try {
    const res = await fetch(REFRESH_TOKEN_URL, {
      method: 'POST',
      headers: {...getHeaders(''), 'content-type': 'application/json'},
      body: JSON.stringify({
        access_token: currentAccessToken,
        refresh_token: REFRESH_TOKEN,
      }),
    });
    if (!res.ok) throw new Error(`refreshToken ${res.status}`);
    const data = await res.json();
    if (data?.payload?.access_token) {
      currentAccessToken = data.payload.access_token;
      console.log('Moj token refreshed:', currentAccessToken);
      return currentAccessToken;
    }
  } catch (e: any) {
    console.log('Token refresh failed:', e?.message);
  }
  return currentAccessToken;
}

function getHeaders(sessionId: string): Record<string, string> {
  return {
    'identity-version': 'V2',
    'x-sharechat-userid': '96860294461',
    'user-preferred-language': 'Hindi',
    'x-sharechat-auth': currentAccessToken,
    'device-id': '12345678900',
    'client-type': 'Android',
    'package-name': 'in.mohalla.video',
    'app-version': '253010',
    'app-version-name': '2025.30.10',
    'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 9; ASUS_Z01QD Build/PI)',
    'x-tenant': 'moj',
    baggage: 'x-tenant=moj',
    'device-high-performing': 'false',
    'device-ram-gb': '2',
    'advertising-id': '62593e57-c0b6-45d0-ba22-30d8ecf730e6',
      'x-app-instance-id': 'd8d6089fb4ceed0fc5f5499602b28a10',
      'radiotype': 'wifi',
      'session-id': sessionId,
      'codepush-version': 'v252900',
      'content-type': 'application/json',
      'accept': 'application/json',
    };
}

export type MojShort = {
  id: string;
  author: string;
  videoUrl: string;
  thumbnail: string;
  caption: string;
  likes: string;
  comments: string;
  shares: string;
  duration: string;
  audioName: string;
  isSeries?: boolean;
  seriesName?: string;
  episodeNumber?: number;
  totalParts?: number;
  listId?: string;
  allEpisodes?: {postId: string; title: string; videoUrl: string; thumbnail: string; episodeNumber: number; duration: number}[];
};

function makeSessionId(): string {
  const uid = '96860294461';
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  return `${uid}_${uuid}`;
}

function parseItems(data: any): MojShort[] {
  const items = data?.payload?.d || data?.d || [];
  return items
    .filter((it: any) => it && (it.v || it.compressedVideoUrl))
    .map((it: any) => {
      const isSeries = it.st === 'EPISODIC_CONTENT' && it.listMeta?.length > 0;
      const lm = isSeries ? it.listMeta[0] : null;
      return {
        id: it.i || String(Date.now()),
        author: it.n || 'Moj Creator',
        videoUrl: it.compressedVideoUrl || it.v || '',
        thumbnail: it.y || it.b || '',
        caption: it.c || '',
        likes: it.s || '0',
        comments: it.lc || '0',
        shares: it.z || '0',
        duration: it.d || '0',
        audioName: it.musicMeta?.audioName || 'Original Sound',
        isSeries,
        seriesName: lm?.listName || '',
        episodeNumber: lm?.partNo || 0,
        totalParts: lm?.totalParts || 0,
        listId: lm?.listId || '',
        nextItemId: lm?.nextItemId || '',
      };
    });
}

export async function fetchMojFeed(): Promise<MojShort[]> {
  const sid = makeSessionId();
  const url = `${MOJ_API}/videoFeed?firstFetch=true&useOffset=true&postsAfterAd=0&ads=true&pacs=0&adsShown=0&adsFetched=0&rcsp=false`;

  const doFetch = async () =>
    fetch(url, {
      method: 'POST',
      headers: {...getHeaders(sid), 'content-type': 'application/json'},
      body: JSON.stringify({
        message: {
          r: 'VideoFeed_Prefetch',
          lang: 'Hindi',
          networkMeta: {networkType: 'wifi', bitrate: 5800000},
        },
        userId: '96860294461',
      }),
    });

  try {
    let res = await doFetch();
    if (res.status === 401 || res.status === 403) {
      await refreshMojToken();
      res = await doFetch();
    }
    if (!res.ok) throw new Error(`videoFeed ${res.status}`);
    const json = await res.json();
    const parsed = parseItems(json);
    if (parsed.length) return parsed;
  } catch (e: any) {
    console.log('videoFeed fail:', e?.message);
  }

  try {
    let res2 = await fetch(`${MOJ_API}/instream-content-feed`, {
      headers: getHeaders(sid),
    });
    if (res2.status === 401 || res2.status === 403) {
      await refreshMojToken();
      res2 = await fetch(`${MOJ_API}/instream-content-feed`, {
        headers: getHeaders(sid),
      });
    }
    if (!res2.ok) throw new Error(`instream ${res2.status}`);
    const json2 = await res2.json();
    return parseItems(json2);
  } catch (e: any) {
    console.log('instream fail:', e?.message);
  }

  return [];
}
