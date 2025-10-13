import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const MEDIA_DIR = join(process.cwd(), '.media_cache');
const MEMORY_CACHE = new Map();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function ensureMediaCacheDir() {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
}

function diskPathFor(messageId) {
  return join(MEDIA_DIR, messageId);
}

export function diskLoad(messageId) {
  try {
    const base = diskPathFor(messageId);
    if (!existsSync(base + '.bin') || !existsSync(base + '.json')) return null;
    const meta = JSON.parse(readFileSync(base + '.json', 'utf8'));
    const data = readFileSync(base + '.bin');
    return { buffer: data, mimetype: meta.mimetype, filename: meta.filename || `media_${messageId}` };
  } catch {
    return null;
  }
}

export function diskSave(messageId, buffer, mimetype, filename) {
  const base = diskPathFor(messageId);
  writeFileSync(base + '.bin', buffer);
  writeFileSync(base + '.json', JSON.stringify({ mimetype, filename }, null, 2));
}

export function memGet(k) {
  const v = MEMORY_CACHE.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > TTL_MS) { MEMORY_CACHE.delete(k); return null; }
  return v.value;
}

export function memSet(k, value) {
  MEMORY_CACHE.set(k, { value, ts: Date.now() });
}
