# vega-backend

Vega app ka data, ek REST API ke roop me — **wahi providers** jo app ke andar hain
(Vedu, FilmTV, Moj shorts, MicroTV drama, Famelack live channels), Node + Express
me port kiye hue, Render par deploy karne ke liye tayyar.

App ki koi file is project ne badli nahi. Provider files app se **copy** ki gayi
hain aur sirf teen cheezein badli gayi hain:

| App me | Yahan | Kyun |
|---|---|---|
| `react-native-mmkv` (native KV store) | [`src/store/kv.ts`](src/store/kv.ts) | Server par MMKV nahi hota; wahi `getString`/`setString` interface, file ke upar |
| `NativeModules.HttpResolve` (Kotlin module) | [`src/lib/httpResolve.ts`](src/lib/httpResolve.ts) | MicroTV ka 302 redirect server par axios se seedha padha ja sakta hai |
| `expo-crypto` wale helper types | [`src/providers/types.ts`](src/providers/types.ts) | Sirf wahi types jo ye paanch providers use karte hain |

`md5` + AES-CBC decrypt (`filmtvCrypto.ts`) jaisa ka taisa hai, aur Node ke apne
`crypto` ke against test hota hai — ek galat byte bhi FilmTV ko chup-chaap khaali
jawab dene par majboor kar deta.

## Chalane ka tareeka

```bash
npm install
npm run dev            # tsx watch, http://localhost:8080
npm run build && npm start   # jo Render chalata hai
npm test               # 42 tests (routes + crypto + auth)
npm run smoke          # live internet par saare providers ka check
npx tsx scripts/get-token.ts <deployed-url>   # auth ko bahar se test karo
```

`GET /health` liveness ke liye hai, aur `GET /api` khud batata hai ki kaun kaun
se route hain.

## Deploy (Render)

1. Is folder ko GitHub par push karo.
2. Render → **New → Blueprint** → repo chuno. [`render.yaml`](render.yaml) khud hi
   web service bana dega (`npm ci && npm run build`, phir `npm start`,
   health check `/health`, region singapore).
   Manual bhi ho sakta hai: Web Service → build `npm ci && npm run build`, start
   `npm start`, health check `/health`.
3. **Environment** me ye keys daalo:
   - `AUTH_SECRET` — Render khud generate kar deta hai (`render.yaml` me
     `generateValue`). Isse tokens sign hote hain. Iske bina token issue nahi hote.
   - `CLIENT_SECRET` — app ka secret, jo `/api/auth/token` par request sign karta
     hai. App me jo daaloge wahi yahan daalna hoga. Isse API public nahi rahti.
   - `API_KEY` — purana flat key. Chahiye to rakho, warna khaali chhod do; auth ka
     asli tareeka upar wala hai.
   - `VEDU_AUTH_PAIRS` — **Vedu playback ke liye zaroori**, format
     `time:token,time:token`. Code me kuch baked nahi hai, isliye iske bina Vedu
     routes error denge. Neeche Vedu wala note dekho.

Free plan par instance so jaata hai, pehla request phir 30-50 second le sakta hai.
Disk ephemeral hai, aur koi baat nahi: FilmTV apna account khud dobara bana leta
hai, Vedu/Moj ke token dobara le lete hain.

## Sirf app ko data mile (auth)

Ye poocha tha: *"ek aisa system jis se sirf apne app ko hi data mile"*. Seedhi baat
— **koi system 100% unhackable nahi hota.** App ke andar jo bhi secret jaata hai,
usko binary nikaal ke padha ja sakta hai. Jo cheez kaam karti hai wo ye hai ki
abuse **mehnga** ho jaye, aur galat key mile to turant band kiya ja sake. Isliye
yahan teen layer hain, aur teenon by default on ho jaati hain jaise hi aap neeche
wale env vars set karte ho:

| Layer | Kya karta hai | Band kya karta hai |
|---|---|---|
| **Signed request** (HMAC-SHA256) | Client secret se `method + path + time + nonce + body` sign hota hai | Beech me se koi request pakad ke badalna, ya dobara bhejna (replay) |
| **Short-lived token** (15 min) | `/api/auth/token` se milta hai, device se bandha hota hai | Ek leak hamesha ke liye kaam karta rehna; token turant revoke ho sakta hai |
| **Rate limit** (120 req/min per ip + per device) | Gate par hi ginne lagta hai | Ek leaked key se poora provider scraping machine ban jaana |

Kuch bhi set na karo to API **khuli** hai — wahi local testing aur `npm run smoke`
ka case hai. Server boot par khud bata deta hai:

```
vega-backend: auth ON — apiKey=false signedRequests=true tokens=true (clients: app)
vega-backend: auth OFF — no AUTH_SECRET / CLIENT_SECRET / API_KEY set, anyone with the URL is served
```

### Flow

```
app                          backend                        providers
 |  POST /api/auth/token  (signed with CLIENT_SECRET)
 |------------------------------->|  signature + nonce + time check
 |   {token, expiresIn: 900}      |  -> token mint + rate limit
 |<-------------------------------|
 |  GET /api/vedu/home   Authorization: Bearer <token>
 |------------------------------->|  token verify + device rate limit
 |<-------------------------------|------------------------------>|
```

`CLIENT_SECRET` sirf pehli call par jaata hai. Baaki sab par token — yani jo
cheez **turant badli ja sakti hai** wahi har request par travel karti hai, aur jo
secret app me **compile** ho chuki hai wo bahut kam.

### Env vars

| Var | Default | Kya karta hai |
|---|---|---|
| `AUTH_SECRET` | — | Tokens sign karta hai. `openssl rand -hex 32` se banao. Iske bina `/api/auth/token` 503 deta hai. |
| `CLIENT_SECRET` | — | `app` client ka secret. App me wahi value daalni hai. |
| `CLIENT_SECRETS` | — | `id:secret,id:secret` — secret rotate karne ka tareeka: purani aur nayi dono saath zinda rakho jab tak purani build chalti hai. |
| `AUTH_TTL_SECONDS` | `900` | Token kitni der zinda rehta hai (kam se kam 30). |
| `AUTH_CLOCK_SKEW_SECONDS` | `300` | Phone ka ghalat time kitna maaf hai. |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per ip aur per device. |
| `API_KEY` | — | Purana flat key. `/api/auth/token` par bhi chalta hai, to purana client todiye bina signed flow par ja sakte ho. |

### Routes

| Route | Kaun bula sakta hai | Kya deta hai |
|---|---|---|
| `GET /api/auth/status` | sab | auth on hai ya nahi, kaun se mode, token TTL. Secret kabhi wapas nahi jaata. |
| `POST /api/auth/token` | signed request ya `x-api-key` | `{token, tokenType, expiresIn, expiresAt}` — body me `{device, app}` |
| `POST /api/auth/refresh` | valid token | naya token; **purana turant revoke** (rotation) |
| `POST /api/auth/revoke` | valid token | wahi token abhi band |

Device id app ki taraf se aata hai (per-install random). Token usi se bandha hota
hai, isliye ek install revoke karne se baaki users par koi asar nahi padta, aur
rate limit ip ke bajaye device par lag sakti hai.

### Signing recipe (kisi bhi language me)

```
canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + SHA256_HEX(body)
signature = base64url( HMAC_SHA256(CLIENT_SECRET, canonical) )
```

Headers:

| Header | Value |
|---|---|
| `x-vega-client` | client id (`app`; chhodo to `app` maan liya jaata hai) |
| `x-vega-timestamp` | `Date.now()` milliseconds |
| `x-vega-nonce` | har request par naya — 16 random bytes ka hex |
| `x-vega-signature` | upar wala signature |

`PATH` wahi hai jo aap call kar rahe ho (`/api/auth/token`), poora, bina query ke.
Body `GET` me khaali string, `POST` me exactly wahi bytes jo bheje gaye — server
raw body hash karta hai, dobara serialise nahi.

### Deploy ke baad turant check karo

```bash
CLIENT_SECRET=<app ka secret> npx tsx scripts/get-token.ts https://vega-backend.onrender.com
```

Ye status padhta hai, signed request bhejta hai, token laata hai, aur usi token se
`/api` kholta hai. Jawab me hi pata chal jaata hai ki secret match hua ya nahi:

- `401 Bad signature` — app ka secret aur server ka `CLIENT_SECRET` match nahi kar rahe.
- `401 Nonce already used` — request dobara bheji gayi (signing theek kaam kar rahi hai).
- `503 ... CLIENT_SECRET` — server par client secret set hi nahi hai.
- `503 ... AUTH_SECRET` — token issue hi nahi ho sakte, `AUTH_SECRET` daalo.

### App side (jab app chhedni ho)

Aaj app ke paas HMAC nahi hai — `expo-crypto` me sirf digests hain (`md5` to app
ne `src/lib/filmtv/crypto.ts` me khud likha hua hai). Do raste hain:

1. **Aaj ka rasta, zero crypto:** app `POST /api/auth/token` par `x-api-key:
   <API_KEY>` bhejkar token le le, aur phir har call par `Authorization: Bearer`.
   Ek static key se better hai (token chhota, revocable, rate limited), par key
   static hi rehti hai.
2. **Pura signed flow:** `Crypto.digest(SHA256, Uint8Array)` par ~35 line ka HMAC
   likhna padega (ipad/opad wala standard tareeka) — koi nayi dependency nahi,
   kyunki `expo-crypto` pehle se hai aur `digest()` bytes leta hai. Uske baad
   app `/api/auth/token` par signed request bhejti hai, jaisa `scripts/get-token.ts`
   karta hai — us file ko hi client ka reference samajh lo.

### Rotation aur revoke

- **Secret rotate:** `CLIENT_SECRETS=app:newsecret,app-1024:oldsecret` — app update
  hone tak dono chalte hain, phir purani id hata do.
- **Ek token revoke:** `POST /api/auth/revoke` `Authorization: Bearer` ke saath.
  Server restart par revocation list khaali ho jaati hai (memory me hai) — isliye
  token TTL chhota (15 min) rakha gaya hai: sabse bura case bhi 15 minute ka hai.
- **Sab band:** app me `CLIENT_SECRET` badal do, server par bhi wahi daalo, purani
  build ke tokens apne aap expire ho jayenge.

### Isko aur strong karna ho to (agla level)

Signing app ki *copy* ko nahi rokta, sirf traffic ko. "Sirf asli app" ka asli jawab
**device attestation** hai: Android par **Play Integrity API** (aur iOS par App
Attest). App Play se ek integrity token leti hai, backend usko Google ke paas jaake
verify karta hai, aur `PLAY_RECOGNIZED` verdict milne par hi token deta hai — matlab
modded ya repackaged app se data nahi milega. Ye is backend me abhi **nahi** laga
hai; ye ek alag kaam hai (Play Console setup + Google API key chahiye), aur tab
`POST /api/auth/token` me ek extra check add hota hai — baaqi poora design waisa hi
rehta hai.

## Endpoints

Har jawab ka shape ek hi hai: `{ok: true, data, ...}` ya `{ok: false, error,
provider?}`. List wale routes me `count` aur `page` bhi aate hain.

### Vedu — movies + web series (`/api/vedu`)

| Route | Kya deta hai |
|---|---|
| `/home?page=1` | "Just added" list (30 per page) |
| `/search?q=leo&page=1` | Search results |
| `/details?htmlFile=...&type=movie&title=...` | Details (ya `?link=<app ka payload>`) |
| `/episodes?htmlFile=...&type=series&keyName=...&season=S1` | Web series ke episodes |
| `/stream?...` | Play link, saare qualities |
| `/download?...` | Download link (alag sign hota hai play se) |
| `/link?...` | Bina fetch kiye payload link banata hai |
| `/status` | Listing aur playback dono ka asli status |

Vedu content id se nahi, ek JSON payload se address hota hai (`htmlFile` + `title`
+ `type` + `keyName`). Dono chalta hai: app ka ready-made `?link=` bhi, aur alag
alag fields bhi.

### FilmTV — OTT (`/api/filmtv`)

`/channels`, `/home?channelId=520&page=1`, `/feed?page=2&psize=10`, `/home-all`,
`/hot`, `/banners`, `/top10?channelId=520`, `/search?q=`, `/topics`,
`/topic?topicId=&pid=&page=`, `/topic/change`, `/recommend`, `/ott`,
`/ott/home`, `/ott/vods?topicId=&pid=&page=`, `/ott/pids`, `/vod/:id` (episodes ke saath,
signed CDN url ready), `/episodes?vodId=`, `/seasons?vodId=&name=`, `/play?url=`,
`/status`, `/channels-raw`.

Detail aur episode routes **chalne wale URL** dete hain — body sign aur CDN ke
signed params provider ke andar hi lagte hain, isliye client ko kuch sign nahi
karna padta.

### Shorts — Moj (`/api/shorts`)

`/feed?limit=20&offset=0`, `/refresh-token`.

### Drama — MicroTV (`/api/drama`)

`/home?page=1`, `/search?q=`, `/details?link=<post url>`,
`/stream?downloadLink=<xdl url>`. Stream route asli direct URL deta hai (R2 /
googleusercontent), aur failure ka reason bhi (`no_location`, `request_failed`,
`details_failed`, …).

### Live channels — Famelack (`/api/live`)

`/kinds`, `/countries?kind=tv`, `/channels?kind=tv&country=in`,
`/category?kind=tv&category=news`, `/all?kind=tv`, `/search?kind=tv&q=bbc`,
`/rows?kind=tv` (screen ke chaar rows ek call me), `/globe`,
`/globe/countries` (globe ka country table + border adjacency).

Har channel ke saath `stream`, `isYouTube` aur `flag` bhi aa jaate hain, taaki
client ko dataset ka `sources.streams`/`sources.youtube` order khud na samajhna pade.

## Testing

- `npm test` — routes ka contract (ek hi answer shape, validation, 404, API key
  gate) + FilmTV crypto Node ke `crypto` ke against. Providers mock hote hain, is
  liye ye offline chalta hai.
- `npm run smoke` — asli internet par har provider, chained: home se ek item utha
  kar usi ke details/stream poochta hai. Ye hi batata hai ki kaun upstream aaj
  kaam kar raha hai.
- `npx tsx scripts/probe-vedu-play.ts` — Vedu ka play endpoint kya maangta hai,
  ye pata karne ke liye.
- `npx tsx scripts/probe-vedu-config.ts` — Vedu ka znote.php config (endpoint list
  + update notice).
- `npx tsx scripts/debug-vedu.ts [query]` — har Vedu request/response print karta hai.

### Last smoke run (live)

31/31 checks 2xx. Ye sab asli data laaye:

| Provider | Kya mila |
|---|---|
| Vedu | home 29 rows, search 3, details, series ke 6 episodes |
| FilmTV | signed in, home 16 rows / 136 feed, vod ke 7 episodes + signed CDN url |
| Moj shorts | 5 shorts |
| MicroTV drama | 50 stories, details, aur direct video URL |
| Famelack live | 246 countries, India ke 590 channels, 926 news channels, globe ke 176 countries |

## Do cheezein jo sach me adhoori hain

1. **Vedu ka play/download aaj khaali aata hai.** Listing (home, search, details,
   episodes) bilkul theek chalta hai, magar `Data/NewTop.php` — jo Vedu ke apne
   config me `LinkGetter` hai — har movie/episode par `200` ke saath khaali body
   deta hai, chahe koi bhi param combination bhejo. Vedu ka apna `znote.php`
   isi build (1.0.22) ko purana kehta hai aur 1.0.24 ke features me likhta hai
   *"Video not Playing Problem Solved"* — matlab playback us version me theek
   hua, aur is build ke keys se play endpoint khulta hi nahi. App ka provider
   bhi yahi pairs use karta hai, to wahan bhi play isi wajah se khaali aata hoga.
   Naya capture milte hi `VEDU_AUTH_PAIRS` set kar do, code chhedne ki zaroorat
   nahi: `/api/vedu/status` turant `playback: true` dikhane lagega.

   **Ye pairs ab code me nahi hain.** Pehle ek capture build ke saath ship hota
   tha; ab sirf environment se aata hai, kyunki ek capture asal me credential
   hai — jo repo public ho jaye to usse koi bhi playback nikal sakta hai. Set na
   ho to Vedu routes saaf error dete hain (`VEDU_AUTH_PAIRS is not set …`),
   chupchap khaali content nahi.
2. **Code GitHub par hai:** <https://github.com/Prashant825567/Vega-Backend>.
   Render usi repo se deploy hota hai. Root directory **khaali** chhodo —
   `package.json`, `src/` aur `render.yaml` repo ke root me hi hain, to Render
   ko alag se kuch batane ki zaroorat nahi (`render.yaml` khud build/start/health
   de deta hai).
