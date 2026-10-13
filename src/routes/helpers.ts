import type {NextFunction, Request, RequestHandler, Response} from 'express';
import {authConfig, rateLimit, safeEquals, verifyToken} from '../lib/auth';

/**
 * The few things every route needs: reading a query string without trusting it,
 * one shape for an answer, one shape for a failure, and a wrapper so an async
 * handler's rejection becomes a 502 instead of an unhandled promise.
 */

/** A query value as a string, or the fallback when it is absent or an array. */
export const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

/** A query value as a number, falling back when it is not one. */
export const num = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Clamps a page size so a caller cannot ask the providers for ten thousand rows
 * and hold a Render instance open until it times out.
 */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(value)));

/** Every successful answer looks like this. */
export const ok = <T>(
  res: Response,
  data: T,
  extra: Record<string, unknown> = {},
): void => {
  res.json({ok: true, data, ...extra});
};

/** Every failure looks like this — same keys, so a client parses one shape. */
export type Failure = {
  ok: false;
  error: string;
  /** Which upstream the failure came from, when it was theirs and not ours. */
  provider?: string;
};

export const fail = (
  res: Response,
  status: number,
  error: string,
  provider?: string,
): void => {
  const body: Failure = {ok: false, error};
  if (provider) {
    body.provider = provider;
  }
  res.status(status).json(body);
};

/** Why a request failed, in one line a log or a client can read. */
export const reasonOf = (error: unknown): string =>
  (error as {message?: string})?.message ||
  (error as {code?: string})?.code ||
  String(error);

/**
 * Wraps an async handler: express 4 does not catch a rejected promise, and an
 * unhandled one takes the whole instance down with it on some Node versions.
 */
export const route = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler => {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
};

/** The bearer token on the request, if it sent one. */
const bearerOf = (req: Request): string => {
  const match = str(req.header('authorization')).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

/**
 * The one door every content route sits behind.
 *
 * Three ways in, tried in order: a live bearer token (what the app uses), the
 * legacy flat `API_KEY` (what anything written before the tokens still sends),
 * and — when nothing at all is configured — no check, which is how it runs
 * locally. It is deliberately here rather than per-route: a new provider route
 * added tomorrow is behind the lock by default, not open because someone forgot.
 *
 * Rate limiting happens before the check, keyed on the ip and then on the token's
 * device, so a leaked secret cannot be turned into an infinite request stream.
 */
export const authGate: RequestHandler = (req, res, next) => {
  const config = authConfig();
  if (config.open) {
    next();
    return;
  }

  const byIp = rateLimit(`ip:${req.ip || 'unknown'}`, config.rateLimitPerMinute);
  res.set('X-RateLimit-Limit', String(byIp.limit));
  res.set('X-RateLimit-Remaining', String(byIp.remaining));
  if (!byIp.allowed) {
    res.set('Retry-After', String(byIp.retryAfterSeconds));
    fail(res, 429, 'Too many requests');
    return;
  }

  const givenKey = str(req.query.key) || str(req.header('x-api-key'));
  if (config.apiKey && givenKey && safeEquals(givenKey, config.apiKey)) {
    next();
    return;
  }

  const token = bearerOf(req);
  if (!token) {
    fail(
      res,
      401,
      'Authentication required — get a token from POST /api/auth/token, then send Authorization: Bearer <token> (or a valid x-api-key)',
    );
    return;
  }

  const result = verifyToken(token);
  if (!result.ok) {
    fail(res, 401, `Token rejected: ${result.reason}`);
    return;
  }

  // One device, one budget: the ip limit alone would throttle a whole carrier's
  // NAT of users together.
  const byDevice = rateLimit(`dev:${result.claims.sub}`, config.rateLimitPerMinute);
  if (!byDevice.allowed) {
    res.set('Retry-After', String(byDevice.retryAfterSeconds));
    fail(res, 429, 'Too many requests');
    return;
  }

  req.auth = result.claims;
  next();
};

/** Kept as an alias: the old name still reads well in a log or a diff. */
export const apiKeyGate = authGate;

/** Lets a CDN or the phone's own cache hold a response for a while. */
export const cacheFor = (seconds: number): RequestHandler => {
  return (_req, res, next) => {
    if (seconds > 0) {
      res.set('Cache-Control', `public, max-age=${seconds}`);
    }
    next();
  };
};

/**
 * Builds the JSON payload the Vedu provider speaks, from either a ready `link`
 * (what the app itself stores) or the individual fields (what a plain HTTP
 * caller has). Keeping both means the app's own links work here unchanged.
 */
export const veduLink = (req: Request): string => {
  const ready = str(req.query.link);
  if (ready) {
    return ready;
  }
  const htmlFile = str(req.query.htmlFile);
  const type = str(req.query.type, 'movie') === 'series' ? 'series' : 'movie';
  return JSON.stringify({
    backend: true,
    vedu: true,
    htmlFile,
    title: str(req.query.title),
    image: str(req.query.image),
    type,
    imbd: str(req.query.imbd) || undefined,
    rating: str(req.query.rating) || undefined,
    catergory: str(req.query.category) || str(req.query.catergory) || undefined,
    Industry: str(req.query.industry) || undefined,
    keyName: str(req.query.keyName) || undefined,
    pathName: str(req.query.season) || str(req.query.pathName) || undefined,
    trailer: str(req.query.trailer) || undefined,
  });
};
