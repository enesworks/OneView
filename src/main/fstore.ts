import * as fs from 'fs';
import * as path from 'path';

export function writeAtomic(file: string, data: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[Store] write error:', err);
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    }
  } catch (err) {
    console.error('[Store] read error:', err);
  }
  return fallback;
}
