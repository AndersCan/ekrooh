import fs from 'bare-fs';
import path from 'bare-path';
import crypto from 'bare-crypto';
import { err, ok } from '../messages/errors';
import type { CoreError, Either } from '../messages/types';
import { createInviteCode } from './invite';

export type SyncState = { version: 1; seed: string; room: string };

const FILE_NAME = 'ekrooh-sync.json';
const SEED_PATTERN = /^[0-9a-f]{64}$/;
const ROOM_PATTERN = /^[0-9a-f]{32}$/;

function freshState(): SyncState {
  return {
    version: 1,
    seed: Buffer.from(crypto.randomBytes(32)).toString('hex'),
    room: createInviteCode(),
  };
}

function readRaw(file: string): { found: boolean; text: string } {
  try {
    return { found: true, text: fs.readFileSync(file, 'utf8') as string };
  } catch {
    return { found: false, text: '' };
  }
}

/** Reads (or creates) the device's sync identity and room. Without a storage
 * directory, or when it is unwritable, the state lives in memory. */
export function loadSyncState(
  storage: string | undefined,
): Either<CoreError, SyncState> {
  if (storage === undefined || storage === '') return ok(freshState());
  const file = path.join(storage, FILE_NAME);
  const raw = readRaw(file);
  if (raw.found) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.text);
    } catch {
      parsed = undefined;
    }
    const record =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    if (
      record !== undefined &&
      typeof record.version === 'number' &&
      record.version > 1
    ) {
      return err(
        'sync/state-version',
        `${file} was written by a newer @ekrooh/bare. Update @ekrooh/bare.`,
      );
    }
    if (
      record !== undefined &&
      record.version === 1 &&
      typeof record.seed === 'string' &&
      SEED_PATTERN.test(record.seed) &&
      typeof record.room === 'string' &&
      ROOM_PATTERN.test(record.room)
    ) {
      return ok({ version: 1, seed: record.seed, room: record.room });
    }
    console.warn(
      `[sync] ${file} is unreadable; starting a new identity and room`,
    );
  }
  const state = freshState();
  saveSyncState(storage, state);
  return ok(state);
}

let warnedWrite = false;

/** Writes the state through a tmp file + rename. Returns false (after one
 * warning) when the write fails; callers carry on in memory. */
export function saveSyncState(
  storage: string | undefined,
  state: SyncState,
): boolean {
  if (storage === undefined || storage === '') return false;
  const file = path.join(storage, FILE_NAME);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    if (!warnedWrite) {
      warnedWrite = true;
      console.warn(`[sync] could not write ${file}; continuing in memory`);
    }
    return false;
  }
}
