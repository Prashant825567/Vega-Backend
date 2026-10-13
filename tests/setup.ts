import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tests must not write into the project — the key/value store would otherwise
 * leave a `data/kv.json` behind with whatever a test put in it. Pointing it at a
 * throwaway file in the system temp directory also makes each run start clean.
 *
 * This runs before any test module is imported, which matters: the store reads
 * its file the moment it is loaded.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vega-backend-test-'));
process.env.KV_FILE = path.join(dir, 'kv.json');
