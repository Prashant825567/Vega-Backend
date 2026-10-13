import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

/**
 * The lock on the API.
 *
 * The goal: only the Vega app reads this data. Nothing can make that literally
 * impossible — a secret shipped inside an app can always be extracted from the
 * binary by someone patient — so this file does the three things that make abuse
 * expensive instead of free, which is what real deployments rely on:
 *
 *   1. A shared client secret signs each request (HMAC-SHA256) over the method,
 *      the path, the time and a fresh nonce. A captured request cannot be
 *      replayed (the nonce is spent once) and cannot be edited (the signature
 *      would stop matching).
 *   2. That secret is only ever needed on `POST /api/auth/token`. Everything
 *      else takes a short-lived bearer token, so the long-lived secret travels
 *      rarely and can be rotated or cut off without updating the app's data
 *      paths.
 *   3. Requests are rate limited per ip and per token, so a leaked key cannot be
 *      turned into a scraping machine against the upstream providers.
 *
 * With no `AUTH_SECRET`, `CLIENT_SECRET(S)` and no `API_KEY`, the API is open —
 * that is how it runs locally and how the test suite exercises it.
 *
 * Every secret here lives on the server and in the app, never in this repo:
 * AUTH_SECRET and CLIENT_SECRETS come from the host's environment.
 */

/** Prefix on every token, so a stray string fails loudly instead of parsing. */
export const TOKEN_PREFIX = 'vga1';

export const DEFAULT_TTL_SECONDS = 900; // 15 minutes: short enough to revoke.
export const DEFAULT_SKEW_SECONDS = 300; // ±5 min of clock drift is tolerated.
export const DEFAULT_RATE_LIMIT = 120; // requests per minute per caller.

/** The headers a signed client sends. */
export const SIGN_HEADERS = {
  client: 'x-vega-client',
  timestamp: 'x-vega-timestamp',
  nonce: 'x-vega-nonce',
  signature: 'x-vega-signature',
} as const;

export interface AuthConfig {
  /** Signs the tokens this server hands out. */
  authSecret: string;
  /** client id -> shared secret. The app is normally `app`. */
  clients: Record<string, string>;
  /** The old flat key, still accepted so nothing that works today breaks. */
  apiKey: string;
  ttlSeconds: number;
  skewSeconds: number;
  rateLimitPerMinute: number;
  /** True when nothing is configured at all — local/dev mode. */
  open: boolean;
}

export interface TokenClaims {
  /** The device (or user) the token was minted for. */
  sub: string;
  /** Free-form label: app version, platform — whatever the client sent. */
  dev?: string;
  /** Issued at, seconds. */
  iat: number;
  /** Expires at, seconds. */
  exp: number;
  /** Unique id, which is what revocation works on. */
  jti: string;
}

const trimmed = (value: string | undefined): string => (value || '').trim();

/**
 * Reads `CLIENT_SECRETS` as `id:secret,id:secret` and `CLIENT_SECRET` as the
 * shorthand for the `app` client. Two names because rotating a leaked secret
 * means having an old and a new one alive at the same time, and that is exactly
 * what the list form is for.
 */
const parseClients = (list?: string, single?: string): Record<string, string> => {
  const clients: Record<string, string> = {};
  for (const entry of trimmed(list).split(',')) {
    const at = entry.indexOf(':');
    if (at <= 0) {
      continue;
    }
    const id = entry.slice(0, at).trim();
    const secret = entry.slice(at + 1).trim();
    if (id && secret) {
      clients[id] = secret;
    }
  }
  const one = trimmed(single);
  if (one) {
    clients.app = one;
  }
  return clients;
};

/**
 * The configuration as it is right now. Deliberately re-read on every call: an
 * environment variable set after import (which is how the tests flip modes, and
 * how a host applies a new value) has to take effect without a restart.
 */
export const authConfig = (): AuthConfig => {
  const authSecret = trimmed(process.env.AUTH_SECRET);
  const clients = parseClients(process.env.CLIENT_SECRETS, process.env.CLIENT_SECRET);
  const apiKey = trimmed(process.env.API_KEY);
  const ttl = Number(process.env.AUTH_TTL_SECONDS);
  const skew = Number(process.env.AUTH_CLOCK_SKEW_SECONDS);
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE);
  return {
    authSecret,
    clients,
    apiKey,
    ttlSeconds: Number.isFinite(ttl) && ttl >= 30 ? Math.trunc(ttl) : DEFAULT_TTL_SECONDS,
    skewSeconds: Number.isFinite(skew) && skew >= 0 ? Math.trunc(skew) : DEFAULT_SKEW_SECONDS,
    rateLimitPerMinute:
      Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_RATE_LIMIT,
    open: !authSecret && !apiKey && Object.keys(clients).length === 0,
  };
};

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const sha256Hex = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

const b64url = (buffer: Buffer): string => buffer.toString('base64url');

export const hmac = (secret: string, message: string): Buffer =>
  createHmac('sha256', secret).update(message).digest();

/**
 * Compares two strings without leaking how far they matched through timing.
 * Signatures and keys are the only things compared this way — never a piece of
 * user data, where the length shortcut is harmless.
 */
export const safeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

/**
 * What exactly is signed. The path (not the full url) keeps the client's job
 * simple: these are fixed endpoints with no query string, so there is nothing
 * to normalise and no way for a param order to change the signature.
 */
export const canonicalRequest = (parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string =>
  [
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodyHash,
  ].join('\n');

// ---------------------------------------------------------------------------
// Signed requests — the app's half and the server's half of one function pair
// ---------------------------------------------------------------------------

export interface SignedRequest {
  clientId: string;
  timestamp: string;
  nonce: string;
  signature: string;
  bodyHash: string;
}

/**
 * Builds the signature for one request. This is the client side of the protocol
 * — it lives here too so the app's copy, the tests and the docs can all point at
 * one implementation. The secret never leaves the app and the server.
 */
export const signRequest = (input: {
  secret: string;
  method: string;
  path: string;
  body?: string;
  clientId?: string;
  timestamp?: string;
  nonce?: string;
}): SignedRequest => {
  const clientId = input.clientId || 'app';
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const bodyHash = sha256Hex(input.body ?? '');
  const signature = b64url(
    hmac(
      input.secret,
      canonicalRequest({
        method: input.method,
        path: input.path,
        timestamp,
        nonce,
        bodyHash,
      }),
    ),
  );
  return {clientId, timestamp, nonce, signature, bodyHash};
};

export type SignatureResult =
  | {ok: true; clientId: string}
  | {ok: false; status: number; reason: string};

/**
 * Checks a signed request. The order matters: the signature is verified *before*
 * the nonce is spent, so an unauthenticated caller cannot burn a real client's
 * nonces and lock it out.
 */
export const verifySignature = (input: {
  clientId?: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  method: string;
  path: string;
  body?: string;
}): SignatureResult => {
  const config = authConfig();
  const ids = Object.keys(config.clients);
  if (!ids.length) {
    return {
      ok: false,
      status: 503,
      reason: 'No client secret configured (set CLIENT_SECRET or CLIENT_SECRETS)',
    };
  }

  const clientId = trimmed(input.clientId) || 'app';
  const secret = config.clients[clientId];
  if (!secret) {
    return {ok: false, status: 401, reason: `Unknown client: ${clientId}`};
  }

  const timestamp = trimmed(input.timestamp);
  const nonce = trimmed(input.nonce);
  const signature = trimmed(input.signature);
  if (!timestamp || !nonce || !signature) {
    return {
      ok: false,
      status: 401,
      reason: `Signed request needs ${SIGN_HEADERS.timestamp}, ${SIGN_HEADERS.nonce} and ${SIGN_HEADERS.signature}`,
    };
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || sent <= 0) {
    return {ok: false, status: 401, reason: `${SIGN_HEADERS.timestamp} is not a timestamp`};
  }
  const driftMs = Math.abs(Date.now() - sent);
  if (driftMs > config.skewSeconds * 1000) {
    return {
      ok: false,
      status: 401,
      reason: `Request is outside the ±${config.skewSeconds}s window`,
    };
  }
  if (nonce.length < 8) {
    return {ok: false, status: 401, reason: `${SIGN_HEADERS.nonce} is too short`};
  }

  const expected = b64url(
    hmac(
      secret,
      canonicalRequest({
        method: input.method,
        path: input.path,
        timestamp,
        nonce,
        bodyHash: sha256Hex(input.body ?? ''),
      }),
    ),
  );
  if (!safeEquals(expected, signature)) {
    return {ok: false, status: 401, reason: 'Bad signature'};
  }

  if (!spendNonce(`${clientId}:${nonce}`, config.skewSeconds * 1000)) {
    return {ok: false, status: 401, reason: 'Nonce already used (replayed request)'};
  }

  return {ok: true, clientId};
};

// ---------------------------------------------------------------------------
// Anti-replay: a nonce is good once, for as long as a signature stays valid
// ---------------------------------------------------------------------------

const spentNonces = new Map<string, number>();
const MAX_NONCES = 50_000; // a cap, because this box has 512 MB and no Redis.
let lastNonceSweep = 0;

/** True the first time this nonce is seen; false for every replay after that. */
export const spendNonce = (nonce: string, ttlMs: number): boolean => {
  const now = Date.now();
  if (now - lastNonceSweep > 5_000) {
    for (const [key, expires] of spentNonces) {
      if (expires <= now) {
        spentNonces.delete(key);
      }
    }
    lastNonceSweep = now;
  }
  const seen = spentNonces.get(nonce);
  if (seen && seen > now) {
    return false;
  }
  if (spentNonces.size >= MAX_NONCES) {
    const oldest = spentNonces.keys().next().value;
    if (oldest !== undefined) {
      spentNonces.delete(oldest);
    }
  }
  spentNonces.set(nonce, now + ttlMs);
  return true;
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface IssuedToken {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: number;
  jti: string;
}

/**
 * Mints a bearer token: `vga1.<payload>.<signature>`. Deliberately not a JWT
 * library — this is one HMAC over one payload, and Node already has HMAC.
 * `ttlSeconds` is only ever passed by the tests; callers use the config value.
 */
export const issueToken = (input: {
  sub: string;
  dev?: string;
  ttlSeconds?: number;
  authSecret?: string;
}): IssuedToken => {
  const secret = input.authSecret ?? authConfig().authSecret;
  if (!secret) {
    throw new Error('AUTH_SECRET is not set — cannot issue tokens');
  }
  const ttlSeconds = input.ttlSeconds ?? authConfig().ttlSeconds;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    sub: input.sub,
    dev: input.dev,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: randomBytes(12).toString('hex'),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signature = b64url(hmac(secret, `${TOKEN_PREFIX}.${payload}`));
  return {
    token: `${TOKEN_PREFIX}.${payload}.${signature}`,
    tokenType: 'Bearer',
    expiresIn: ttlSeconds,
    expiresAt: claims.exp * 1000,
    jti: claims.jti,
  };
};

export type TokenResult =
  | {ok: true; claims: TokenClaims}
  | {ok: false; reason: string};

export const verifyToken = (token: string): TokenResult => {
  const config = authConfig();
  if (!config.authSecret) {
    return {ok: false, reason: 'This server has no AUTH_SECRET, so it cannot accept tokens'};
  }
  const parts = trimmed(token).split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return {ok: false, reason: 'Not a vega token'};
  }
  const [, payload, signature] = parts;
  const expected = b64url(hmac(config.authSecret, `${TOKEN_PREFIX}.${payload}`));
  if (!safeEquals(expected, signature)) {
    return {ok: false, reason: 'Bad token signature'};
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {ok: false, reason: 'Token payload is not readable'};
  }
  if (!claims?.sub || typeof claims.exp !== 'number' || typeof claims.jti !== 'string') {
    return {ok: false, reason: 'Token payload is incomplete'};
  }
  if (claims.exp * 1000 <= Date.now()) {
    return {ok: false, reason: 'Token expired'};
  }
  if (isRevoked(claims.jti)) {
    return {ok: false, reason: 'Token revoked'};
  }
  return {ok: true, claims};
};

const revoked = new Map<string, number>(); // jti -> when it would have expired

/** Kills one token now, until the moment it would have expired anyway. */
export const revokeToken = (jti: string, expiresAtMs: number): void => {
  const now = Date.now();
  for (const [key, expires] of revoked) {
    if (expires <= now) {
      revoked.delete(key);
    }
  }
  revoked.set(jti, Math.max(expiresAtMs, now + 1000));
};

export const isRevoked = (jti: string): boolean => {
  const expires = revoked.get(jti);
  if (expires === undefined) {
    return false;
  }
  if (expires <= Date.now()) {
    revoked.delete(jti);
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Rate limiting — a fixed window per caller, in memory
// ---------------------------------------------------------------------------

export interface RateLimit {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

const windows = new Map<string, {count: number; resetAt: number}>();

export const rateLimit = (key: string, perMinute: number): RateLimit => {
  const now = Date.now();
  if (windows.size > 20_000) {
    for (const [k, window] of windows) {
      if (window.resetAt <= now) {
        windows.delete(k);
      }
    }
  }
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, {count: 1, resetAt: now + 60_000});
    return {allowed: true, limit: perMinute, remaining: perMinute - 1, retryAfterSeconds: 60};
  }
  current.count += 1;
  const remaining = Math.max(0, perMinute - current.count);
  return {
    allowed: current.count <= perMinute,
    limit: perMinute,
    remaining,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
};

/** What the startup log and `GET /api/auth/status` report. Never a secret. */
export const describeAuth = () => {
  const config = authConfig();
  return {
    enforced: !config.open,
    modes: {
      apiKey: Boolean(config.apiKey),
      signedRequests: Object.keys(config.clients).length > 0,
      bearerTokens: Boolean(config.authSecret),
    },
    clients: Object.keys(config.clients),
    ttlSeconds: config.ttlSeconds,
    clockSkewSeconds: config.skewSeconds,
    rateLimitPerMinute: config.rateLimitPerMinute,
  };
};

/** Used by the tests: forget spent nonces, revocations and rate windows. */
export const resetAuthState = (): void => {
  spentNonces.clear();
  revoked.clear();
  windows.clear();
  lastNonceSweep = 0;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the gate when a request arrives with a valid bearer token. */
      auth?: TokenClaims;
      /**
       * The body exactly as it arrived, kept by `express.json`'s verify hook so a
       * signature can be checked over the same bytes the client signed. Re-serialising
       * a parsed body would depend on key order, which the client did not promise.
       */
      rawBody?: Buffer;
    }
  }
}
