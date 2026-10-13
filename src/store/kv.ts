import fs from 'node:fs';
import path from 'node:path';

/**
 * The key/value store the ported providers expect.
 *
 * Both FilmTV and Famelack in the app keep their cache and their FilmTV account
 * in MMKV — a native key/value store that a Node server does not have. This is
 * the same interface (`getString` / `setString`) backed by a JSON file, so the
 * provider code did not have to change a single line beyond the import.
 *
 * Two things are worth knowing about it:
 *
 * - **writes are debounced and best-effort.** The providers call `setString` on
 *   every cache fill, which can be many times a second; writing the file that
 *   often would be pointless work. A failed write is swallowed on purpose — a
 *   full disk must not take a request down with it, exactly as in the app.
 * - **on a host with an ephemeral disk (Render's free tier) it survives only for
 *   the life of the instance.** That is fine, and it is why nothing here is the
 *   only copy of anything: the FilmTV account is re-registered on a cold start
 *   and the caches are simply filled again.
 */

const FILE = process.env.KV_FILE
  ? path.resolve(process.env.KV_FILE)
  : path.join(process.cwd(), 'data', 'kv.json');

/** How long a change may sit in memory before it is written out. */
const FLUSH_MS = 1000;

const read = (): Record<string, string> => {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // No file yet, or one we cannot read: start empty.
    return {};
  }
};

let doc: Record<string, string> = read();
let timer: NodeJS.Timeout | null = null;

const flush = (): void => {
  timer = null;
  try {
    fs.mkdirSync(path.dirname(FILE), {recursive: true});
    // Written through a temporary file so a crash halfway cannot leave a
    // half-written document behind for the next boot to parse.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    // A cache that could not be persisted is still a working cache.
  }
};

const schedule = (): void => {
  if (timer) {
    return;
  }
  timer = setTimeout(flush, FLUSH_MS);
  // A pending flush must not hold the process open at shutdown.
  timer.unref?.();
};

export const store = {
  getString: (key: string): string | undefined => {
    const value = doc[key];
    return value === undefined ? undefined : value;
  },
  setString: (key: string, value: string): void => {
    doc[key] = String(value);
    schedule();
  },
  getBool: (key: string): boolean => doc[key] === 'true',
  setBool: (key: string, value: boolean): void => {
    doc[key] = value ? 'true' : 'false';
    schedule();
  },
  remove: (key: string): void => {
    delete doc[key];
    schedule();
  },
  getAllKeys: (): string[] => Object.keys(doc),
};

/** Writes anything still in memory out now — used on shutdown and by tests. */
export const flushStore = (): void => {
  if (timer) {
    clearTimeout(timer);
  }
  flush();
};
