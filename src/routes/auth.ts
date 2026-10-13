import {Router, type Request, type RequestHandler, type Response} from 'express';
import {
  SIGN_HEADERS,
  describeAuth,
  issueToken,
  rateLimit,
  revokeToken,
  safeEquals,
  verifySignature,
  verifyToken,
  type TokenClaims,
} from '../lib/auth';
import {fail, ok, reasonOf, route, str} from './helpers';

/**
 * Getting in.
 *
 * `POST /token` is the only endpoint the app's long-lived secret is ever sent
 * to. It answers with a short-lived bearer token; every content route takes that
 * token instead. That split is the whole point: the secret that is hard to
 * rotate (it is compiled into the app) travels once per session, while the thing
 * that can be cut off instantly is what travels on every request.
 *
 *   GET  /api/auth/status   — public: is auth on, and in which modes
 *   POST /api/auth/token    — signed request (or legacy x-api-key) -> token
 *   POST /api/auth/refresh  — valid token -> a fresh one, old one revoked
 *   POST /api/auth/revoke   — valid token -> dead immediately
 */

const router = Router();

/** The body as it arrived, for the signature. Empty when there is no body. */
const rawBodyOf = (req: Request): string =>
  req.rawBody ? req.rawBody.toString('utf8') : '';

/**
 * The path as the client addressed it. `req.path` inside a mounted router is
 * already stripped of its mount point (`/token`, not `/api/auth/token`), so the
 * signature has to be checked against the url the caller actually signed. The
 * query string is dropped: these endpoints take none, and normalising an absent
 * thing is where signature bugs come from.
 */
const signedPathOf = (req: Request): string => req.originalUrl.split('?')[0];

const bearerOf = (req: Request): string => {
  const header = str(req.header('authorization'));
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

/** Rate limits the door, which is where a guessing attack would hit first. */
const limitDoor = (perMinute: number): RequestHandler => (req, res, next) => {
  const limit = rateLimit(`auth:${req.ip || 'unknown'}`, perMinute);
  res.set('X-RateLimit-Limit', String(limit.limit));
  res.set('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfterSeconds));
    fail(res, 429, 'Too many sign-in attempts — slow down');
    return;
  }
  next();
};

/**
 * Accepts either a properly signed request or the legacy flat `API_KEY`. The
 * fallback exists so an existing client that only knows `?key=` keeps working
 * while the signed flow is rolled out.
 */
const signedIn: RequestHandler = (req, res, next) => {
  const body = rawBodyOf(req);
  const result = verifySignature({
    clientId: str(req.header(SIGN_HEADERS.client)),
    timestamp: str(req.header(SIGN_HEADERS.timestamp)),
    nonce: str(req.header(SIGN_HEADERS.nonce)),
    signature: str(req.header(SIGN_HEADERS.signature)),
    method: req.method,
    path: signedPathOf(req),
    body,
  });

  if (result.ok) {
    res.locals.clientId = result.clientId;
    next();
    return;
  }

  // No signature offered at all: the legacy key can still get a token, but only
  // when it is configured. A 503 from verifySignature means the server itself is
  // not set up for signing, which is exactly when this fallback matters.
  const offeredKey = str(req.query.key) || str(req.header('x-api-key'));
  const configuredKey = (process.env.API_KEY || '').trim();
  if (offeredKey && configuredKey && safeEquals(offeredKey, configuredKey)) {
    res.locals.clientId = 'api-key';
    next();
    return;
  }

  fail(res, result.status, result.reason);
};

/** A content-free middleware: the caller must already hold a live token. */
export const bearerRequired: RequestHandler = (req, res, next) => {
  const token = bearerOf(req);
  if (!token) {
    fail(res, 401, 'Authorization: Bearer <token> is required');
    return;
  }
  const result = verifyToken(token);
  if (!result.ok) {
    fail(res, 401, `Token rejected: ${result.reason}`);
    return;
  }
  req.auth = result.claims;
  next();
};

/** GET /api/auth/status — public, so a client can see what to send. */
router.get(
  '/status',
  route(async (_req: Request, res: Response) => {
    const state = describeAuth();
    ok(res, {
      ...state,
      note: state.enforced
        ? 'Send POST /api/auth/token (signed) once, then Authorization: Bearer <token> on every call.'
        : 'No AUTH_SECRET, CLIENT_SECRET or API_KEY set: this deployment accepts anyone. Set them before going public.',
      tokenEndpoint: '/api/auth/token',
      signatureHeaders: SIGN_HEADERS,
    });
  }),
);

/**
 * POST /api/auth/token  {"device": "<uuid>", "app": "vega/1.0.22"}
 *
 * The token is bound to the device id, so revoking one install does not disturb
 * the others, and the rate limit can key on something more useful than an ip.
 */
router.post(
  '/token',
  limitDoor(30),
  signedIn,
  route(async (req: Request, res: Response) => {
    const device = str(req.body?.device) || str(req.query.device);
    if (device.length < 6) {
      fail(res, 400, 'device is required (a per-install id, at least 6 characters)');
      return;
    }
    if (!(process.env.AUTH_SECRET || '').trim()) {
      fail(res, 503, 'This server has no AUTH_SECRET set, so it cannot issue tokens');
      return;
    }
    try {
      const issued = issueToken({
        sub: device,
        dev: str(req.body?.app) || str(req.query.app) || undefined,
      });
      ok(
        res,
        {
          token: issued.token,
          tokenType: issued.tokenType,
          expiresIn: issued.expiresIn,
          expiresAt: issued.expiresAt,
        },
        {client: String(res.locals.clientId || 'app')},
      );
    } catch (error) {
      fail(res, 503, reasonOf(error));
    }
  }),
);

/**
 * POST /api/auth/refresh — a live token in, a fresh one out.
 *
 * The old token is revoked as the new one is issued, so a copied refresh cannot
 * leave two valid sessions behind.
 */
router.post(
  '/refresh',
  limitDoor(60),
  bearerRequired,
  route(async (req: Request, res: Response) => {
    const claims = req.auth as TokenClaims;
    const issued = issueToken({sub: claims.sub, dev: claims.dev});
    revokeToken(claims.jti, claims.exp * 1000);
    ok(res, {
      token: issued.token,
      tokenType: issued.tokenType,
      expiresIn: issued.expiresIn,
      expiresAt: issued.expiresAt,
      renewedFrom: claims.jti,
    });
  }),
);

/** POST /api/auth/revoke — kill the token that was sent, right now. */
router.post(
  '/revoke',
  bearerRequired,
  route(async (req: Request, res: Response) => {
    const claims = req.auth as TokenClaims;
    revokeToken(claims.jti, claims.exp * 1000);
    ok(res, {revoked: claims.jti, device: claims.sub});
  }),
);

export default router;
