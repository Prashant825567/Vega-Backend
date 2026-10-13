import express, {type NextFunction, type Request, type Response} from 'express';
import cors from 'cors';
import routes from './routes';
import {fail, reasonOf} from './routes/helpers';

/**
 * The express app, built separately from the server that listens on it.
 *
 * That split is what makes the tests real: they hand this app to supertest and
 * exercise the actual routes — validation, error shapes, headers — without
 * binding a port, so the suite runs anywhere, including a CI box with nothing
 * open.
 */

export const createApp = () => {
  const app = express();
  app.disable('x-powered-by');
  // Render terminates TLS at its proxy, so the real client ip arrives in
  // X-Forwarded-For and express has to be told to trust it.
  app.set('trust proxy', true);
  app.use(cors({origin: true}));
  // `verify` keeps the raw bytes of the body. A signed request has to be checked
  // over exactly what the client sent: re-serialising the parsed object would
  // depend on key order, which is not part of the protocol.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buffer) => {
        (req as Request).rawBody = buffer;
      },
    }),
  );

  // One line per request. On a host where the only view into the process is its
  // log, this is what tells a 502 apart from a route that was never called.
  // Silent while the tests run: there they would be noise around the assertions.
  const quiet = process.env.NODE_ENV === 'test';
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      if (quiet) {
        return;
      }
      console.log(
        `${req.method} ${req.originalUrl} ${res.statusCode} ${
          Date.now() - started
        }ms`,
      );
    });
    next();
  });

  /** GET /health — what a host's health check and a browser both ask for. */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      data: {
        status: 'up',
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
      },
    });
  });

  app.use('/api', routes);

  app.use((req: Request, res: Response) => {
    fail(res, 404, `No such route: ${req.method} ${req.path}`);
  });

  // Anything a provider threw lands here. A provider that is down (or refuses
  // the keys) is an upstream failure, which is a 502 — not a 500 that would
  // suggest this service is broken.
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = (error as {status?: number})?.status;
      console.error('request failed:', error);
      if (res.headersSent) {
        return;
      }
      fail(
        res,
        typeof status === 'number' && status >= 400 && status < 600
          ? status
          : 502,
        reasonOf(error),
      );
    },
  );

  return app;
};
