import {createApp} from './app';
import {describeAuth} from './lib/auth';
import {flushStore} from './store/kv';

/**
 * The process itself: listen, and shut down without losing anything.
 *
 * The port comes from the environment because that is how a host assigns one
 * (Render sets `PORT`); 8080 is the local default. On the way out the key/value
 * store is flushed, which matters for the tokens the providers keep there — a
 * restart that starts with them still on disk skips a registration round-trip.
 */

const port = Number(process.env.PORT || 8080);

// Said out loud at boot, because the difference between an open deployment and a
// locked one is invisible until someone finds the URL.
const auth = describeAuth();
console.log(
  auth.enforced
    ? `vega-backend: auth ON — apiKey=${auth.modes.apiKey} signedRequests=${auth.modes.signedRequests} tokens=${auth.modes.bearerTokens} (clients: ${auth.clients.join(', ') || 'none'})`
    : 'vega-backend: auth OFF — no AUTH_SECRET / CLIENT_SECRET / API_KEY set, anyone with the URL is served',
);

const server = createApp().listen(port, () => {
  console.log(`vega-backend listening on :${port}`);
});

const shutdown = (signal: string): void => {
  console.log(`${signal} received — shutting down`);
  flushStore();
  server.close(() => process.exit(0));
  // A keep-alive connection must not hold the process open forever.
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
