import fs from 'bare-fs';
import path from 'bare-path';
import { err, ok } from '../messages/errors';
import type { CoreError, Either } from '../messages/types';

const FILE_NAME = 'ekrooh-sync-values.json';

/** Reads this device's last published value. Missing, unreadable or rejected
 * values give undefined (one warning when a file existed but is unusable). */
export function loadSelfValue<T>(
  storage: string | undefined,
  parse: (raw: unknown) => T | undefined,
): T | undefined {
  if (storage === undefined || storage === '') return undefined;
  const file = path.join(storage, FILE_NAME);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8') as string;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      console.warn(`[sync] could not read ${file}; starting without it`);
    }
    return undefined;
  }
  let value: T | undefined;
  try {
    const record: unknown = JSON.parse(text);
    if ((record as { version?: unknown }).version === 1) {
      value = parse((record as { self?: unknown }).self);
    }
  } catch {
    value = undefined;
  }
  if (value === undefined) {
    console.warn(`[sync] ${file} is unreadable; starting without it`);
  }
  return value;
}

/** Writes this device's value through a tmp file + rename. Without a storage
 * directory nothing is written (in memory by design). */
export function saveSelfValue(
  storage: string | undefined,
  value: unknown,
): Either<CoreError, true> {
  if (storage === undefined || storage === '') return ok(true);
  const file = path.join(storage, FILE_NAME);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, self: value }));
    fs.renameSync(tmp, file);
    return ok(true);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return err('sync/save-failed', `Could not save ${file}: ${reason}`);
  }
}
