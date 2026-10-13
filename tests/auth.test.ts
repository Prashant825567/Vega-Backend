import request from 'supertest';
import {createApp} from '../src/app';
import {issueToken, resetAuthState, signRequest} from '../src/lib/auth';

/**
 * The lock, tested through HTTP.
 *
 * What matters here is not that a signature function returns a string but that
 * the door behaves: unsigned requests are refused, a signed request buys a short
 * token, that token opens the content routes, and the three ways in which these
 * schemes are usually defeated — replaying a captured request, tampering with
 * one, and hammering the door — do not work.
 *
 * No provider is touched: the gate sits above every route, so an unknown path
 * answers 404 only once the request is authenticated, which is exactly the lever
 * these tests pull.
 */

const CLIENT_SECRET = 'app-secret-do-not-commit';
const AUTH_SECRET = 'server-signing-secret';
const DEVICE = 'device-abcdef123456';

const app = createApp();

const signed = (path: string, body?: unknown) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const {timestamp, nonce, signature, clientId} = signRequest({
    secret: CLIENT_SECRET,
    method: 'POST',
    path,
    body: payload,
  });
  return {payload, headers: {
    'x-vega-client': clientId,
    'x-vega-timestamp': timestamp,
    'x-vega-nonce': nonce,
    'x-vega-signature': signature,
  }};
};

const tokenFor = async (): Promise<string> => {
  const {payload, headers} = signed('/api/auth/token', {device: DEVICE});
  const res = await request(app)
    .post('/api/auth/token')
    .set(headers)
    .set('content-type', 'application/json')
    .send(payload)
    .expect(200);
  return res.body.data.token;
};

beforeEach(() => {
  resetAuthState();
});

afterEach(() => {
  delete process.env.AUTH_SECRET;
  delete process.env.CLIENT_SECRET;
  delete process.env.CLIENT_SECRETS;
  delete process.env.API_KEY;
  delete process.env.RATE_LIMIT_PER_MINUTE;
  delete process.env.AUTH_TTL_SECONDS;
});

describe('with nothing configured', () => {
  it('serves anyone, which is how it runs locally', async () => {
    const res = await request(app).get('/api').expect(200);
    expect(res.body.ok).toBe(true);

    const status = await request(app).get('/api/auth/status').expect(200);
    expect(status.body.data.enforced).toBe(false);
    expect(status.body.data.note).toContain('accepts anyone');
  });
});

describe('once a secret exists', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = AUTH_SECRET;
    process.env.CLIENT_SECRET = CLIENT_SECRET;
  });

  it('refuses a content route and says how to get in', async () => {
    const res = await request(app).get('/api').expect(401);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('/api/auth/token');
  });

  it('answers /api/auth/status publicly without leaking a secret', async () => {
    const res = await request(app).get('/api/auth/status').expect(200);

    expect(res.body.data.enforced).toBe(true);
    expect(res.body.data.modes).toEqual({
      apiKey: false,
      signedRequests: true,
      bearerTokens: true,
    });
    expect(res.body.data.clients).toEqual(['app']);
    // The one thing that must never come back: the values themselves.
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(res.body)).not.toContain(AUTH_SECRET);
  });

  it('trades a signed request for a short-lived, device-bound token', async () => {
    const {payload, headers} = signed('/api/auth/token', {
      device: DEVICE,
      app: 'vega/1.0.22',
    });

    const res = await request(app)
      .post('/api/auth/token')
      .set(headers)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(200);

    expect(res.body.data.token).toMatch(/^vga1\./);
    expect(res.body.data.expiresIn).toBe(900);
    expect(res.body.client).toBe('app');

    const claims = JSON.parse(
      Buffer.from(res.body.data.token.split('.')[1], 'base64url').toString('utf8'),
    );
    expect(claims.sub).toBe(DEVICE);
    expect(claims.dev).toBe('vega/1.0.22');
  });

  it('opens the content routes with that token', async () => {
    const token = await tokenFor();

    // An unknown path is the lever: 404 proves the gate let it through.
    await request(app).get('/api/nope').expect(401);
    const res = await request(app)
      .get('/api/nope')
      .set('authorization', `Bearer ${token}`)
      .expect(404);
    expect(res.body.error).toBe('No such route: GET /api/nope');
    await request(app)
      .get('/api')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('needs a device id to mint a token for', async () => {
    const {payload, headers} = signed('/api/auth/token', {app: 'vega/1.0.22'});

    const res = await request(app)
      .post('/api/auth/token')
      .set(headers)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(400);

    expect(res.body.error).toContain('device is required');
  });

  it('refuses a signature made with the wrong secret', async () => {
    const {payload} = signed('/api/auth/token', {device: DEVICE});
    const wrong = signRequest({
      secret: 'not-the-secret',
      method: 'POST',
      path: '/api/auth/token',
      body: payload,
    });

    const res = await request(app)
      .post('/api/auth/token')
      .set('x-vega-timestamp', wrong.timestamp)
      .set('x-vega-nonce', wrong.nonce)
      .set('x-vega-signature', wrong.signature)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(401);

    expect(res.body.error).toBe('Bad signature');
  });

  it('refuses a request whose body was edited after signing', async () => {
    const original = JSON.stringify({device: DEVICE});
    const {headers} = signed('/api/auth/token', {device: DEVICE});

    const res = await request(app)
      .post('/api/auth/token')
      .set(headers)
      .set('content-type', 'application/json')
      .send(JSON.stringify({device: 'someone-elses-device'}))
      .expect(401);

    expect(res.body.error).toBe('Bad signature');
    expect(original).toContain(DEVICE);
  });

  it('refuses a stale signature', async () => {
    const {payload, headers} = signed('/api/auth/token', {device: DEVICE});

    const res = await request(app)
      .post('/api/auth/token')
      .set({...headers, 'x-vega-timestamp': String(Date.now() - 3_600_000)})
      .set('content-type', 'application/json')
      .send(payload)
      .expect(401);

    expect(res.body.error).toContain('window');
  });

  it('refuses a replayed request, even the second time the exact bytes arrive', async () => {
    const {payload, headers} = signed('/api/auth/token', {device: DEVICE});

    const first = await request(app)
      .post('/api/auth/token')
      .set(headers)
      .set('content-type', 'application/json')
      .send(payload);
    expect([200, 201]).toContain(first.status);
    expect(first.body.ok).toBe(true);

    const second = await request(app)
      .post('/api/auth/token')
      .set(headers)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(401);

    expect(second.body.error).toContain('Nonce already used');
  });

  it('refuses a client it does not know', async () => {
    const {payload, headers} = signed('/api/auth/token', {device: DEVICE});

    const res = await request(app)
      .post('/api/auth/token')
      .set({...headers, 'x-vega-client': 'someone-else'})
      .set('content-type', 'application/json')
      .send(payload)
      .expect(401);

    expect(res.body.error).toBe('Unknown client: someone-else');
  });

  it('revokes the token it just replaced, so refresh leaves one live session', async () => {
    const old = await tokenFor();
    const renewed = await request(app)
      .post('/api/auth/refresh')
      .set('authorization', `Bearer ${old}`)
      .expect(200);

    const fresh = renewed.body.data.token;
    expect(fresh).not.toBe(old);

    await request(app)
      .get('/api')
      .set('authorization', `Bearer ${fresh}`)
      .expect(200);
    const dead = await request(app)
      .get('/api')
      .set('authorization', `Bearer ${old}`)
      .expect(401);
    expect(dead.body.error).toContain('revoked');
  });

  it('kills a token on demand', async () => {
    const token = await tokenFor();

    await request(app)
      .post('/api/auth/revoke')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .get('/api')
      .set('authorization', `Bearer ${token}`)
      .expect(401);
    expect(res.body.error).toContain('revoked');
  });

  it('refuses a token that expired', async () => {
    const expired = issueToken({sub: DEVICE, ttlSeconds: -10, authSecret: AUTH_SECRET});

    const res = await request(app)
      .get('/api')
      .set('authorization', `Bearer ${expired.token}`)
      .expect(401);
    expect(res.body.error).toContain('expired');
  });

  it('refuses a token signed with a different secret', async () => {
    const forged = issueToken({sub: DEVICE, authSecret: 'a-secret-guessed-by-someone'});

    const res = await request(app)
      .get('/api')
      .set('authorization', `Bearer ${forged.token}`)
      .expect(401);
    expect(res.body.error).toContain('Bad token signature');
  });

  it('stops answering once one caller burns through the minute', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '2';

    await request(app).get('/api').expect(401);
    await request(app).get('/api').expect(401);
    const limited = await request(app).get('/api').expect(429);

    expect(limited.body.error).toContain('Too many');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('the legacy flat key', () => {
  it('still works on its own, by query and by header', async () => {
    process.env.API_KEY = 's3cret';

    const refused = await request(app).get('/api').expect(401);
    expect(refused.body.error).toContain('Authentication required');

    await request(app).get('/api?key=s3cret').expect(200);
    await request(app).get('/api').set('x-api-key', 's3cret').expect(200);
  });

  it('can still buy a token while the signed flow is rolled out', async () => {
    process.env.API_KEY = 's3cret';
    process.env.AUTH_SECRET = AUTH_SECRET;

    const res = await request(app)
      .post('/api/auth/token')
      .set('x-api-key', 's3cret')
      .send({device: DEVICE})
      .expect(200);

    expect(res.body.client).toBe('api-key');
    await request(app)
      .get('/api')
      .set('authorization', `Bearer ${res.body.data.token}`)
      .expect(200);
  });
});
