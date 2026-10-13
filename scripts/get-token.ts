/**
 * Buys a token from a running server, the way the app will.
 *
 * This is the reference client for the signed flow: it is the same
 * `signRequest` the server verifies against, pointed at a url you name. Use it
 * to prove a deployment is locked correctly without touching the app:
 *
 *   CLIENT_SECRET=<the app secret> \
 *   npx tsx scripts/get-token.ts https://vega-backend.onrender.com
 *
 * Then call anything with what it prints:
 *
 *   curl -H "Authorization: Bearer <token>" https://vega-backend.onrender.com/api/vedu/home
 *
 * With no secret in the environment it talks to a local server with no auth at
 * all, which is also worth seeing: that is what an unlocked deployment looks
 * like.
 */

import {signRequest} from '../src/lib/auth';

const baseUrl = (process.argv[2] || `http://localhost:${process.env.PORT || 8080}`).replace(
  /\/$/,
  '',
);
const secret = (process.env.CLIENT_SECRET || '').trim();
const clientId = (process.env.CLIENT_ID || 'app').trim();
const device = (process.env.DEVICE || `cli-${Date.now().toString(36)}`).trim();

const main = async (): Promise<void> => {
  console.log(`base url : ${baseUrl}`);
  console.log(`client   : ${clientId}`);
  console.log(`device   : ${device}`);
  console.log(
    secret
      ? 'secret   : from CLIENT_SECRET (the same value the server has)'
      : 'secret   : none — the signed request will be sent unsigned, and the server should answer 401',
  );
  console.log('');

  const status = await fetch(`${baseUrl}/api/auth/status`).catch(error => {
    throw new Error(`cannot reach ${baseUrl}: ${(error as Error).message}`);
  });
  const statusBody = await status.json().catch(() => null);
  console.log(`GET  /api/auth/status -> ${status.status}`);
  console.log(JSON.stringify(statusBody?.data ?? statusBody, null, 2));
  console.log('');

  if (!statusBody?.data?.enforced) {
    console.log('This deployment is OPEN — no token needed for anything.');
    const home = await fetch(`${baseUrl}/api/pub-check`).catch(() => null);
    if (home) {
      console.log(`(probed an unknown route: ${home.status})`);
    }
    return;
  }

  const path = '/api/auth/token';
  const body = JSON.stringify({device, app: 'vega-backend/cli'});
  const signed = signRequest({secret, method: 'POST', path, body});

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vega-client': signed.clientId,
      'x-vega-timestamp': signed.timestamp,
      'x-vega-nonce': signed.nonce,
      'x-vega-signature': signed.signature,
      ...(process.env.API_KEY ? {'x-api-key': process.env.API_KEY} : {}),
    },
    body,
  });
  const tokenBody = await response.json().catch(() => null);
  console.log(`POST ${path} -> ${response.status}: ${tokenBody?.error || 'token issued'}`);

  if (!response.ok) {
    console.log('');
    console.log('A 401 here means the secret does not match the server\'s, or the');
    console.log('server has no CLIENT_SECRET set. A 503 means it has no AUTH_SECRET,');
    console.log('so it cannot hand out tokens at all.');
    process.exitCode = 1;
    return;
  }

  const token = tokenBody.data.token as string;
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  );
  console.log(`     token: ${token.slice(0, 32)}… (${claims.exp - claims.iat}s)`);

  const me = await fetch(`${baseUrl}/api`, {
    headers: {authorization: `Bearer ${token}`},
  });
  console.log(`GET  /api with that token -> ${me.status}`);
  console.log('');
  console.log(`export TOKEN='${token}'`);
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
