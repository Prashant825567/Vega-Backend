/**
 * Why is Vedu not playing?
 *
 * The listing endpoints answer (home, search, details, episodes) but the play
 * and download calls come back with nothing that starts with `http`. This script
 * prints the exact request body and the exact response for `Data/NewTop.php`, so
 * the next person does not have to guess whether it is the gate, the quality
 * flag, or the htmlFile it was handed.
 *
 * Run: npx tsx scripts/debug-vedu.ts [query]
 */

import axios from 'axios';
import {getVeduSearchPosts, getVeduStream, parseVeduLink} from '../src/providers/vedu';

const query = process.argv[2] || 'leo';

const originalPost = axios.post.bind(axios);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(axios as any).post = async (url: string, body: any, config: any) => {
  const response = await originalPost(url, body, config);
  console.log(`POST ${url}`);
  console.log(`  body   : ${String(body).slice(0, 400)}`);
  console.log(
    `  answer : ${response.status} ${String(response.data).slice(0, 400)}`,
  );
  console.log('');
  return response;
};

const main = async (): Promise<void> => {
  const posts = await getVeduSearchPosts(query, 1);
  console.log(`search "${query}" -> ${posts.length} row(s)`);

  const first = posts[0];
  if (!first) {
    console.log('nothing to play');
    return;
  }
  const payload = parseVeduLink(first.link);
  console.log(`first row: ${first.title}`);
  console.log(`htmlFile : ${payload?.htmlFile}`);
  console.log('');

  const streams = await getVeduStream(first.link);
  console.log(`streams: ${JSON.stringify(streams)}`);
};

void main();
