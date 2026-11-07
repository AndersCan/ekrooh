import crypto from 'bare-crypto';
import { err, ok } from '../messages/errors';
import type { CoreError, Either } from '../messages/types';

const INVITE_PATTERN = /^[0-9a-f]{32}$/;

/** A fresh room code: 16 random bytes as 32 lowercase hex characters. */
export function createInviteCode(): string {
  return Buffer.from(crypto.randomBytes(16)).toString('hex');
}

/** Normalises pasted text (trim, lowercase) and checks its shape. */
export function parseInviteCode(text: string): Either<CoreError, string> {
  const code = typeof text === 'string' ? text.trim().toLowerCase() : '';
  if (!INVITE_PATTERN.test(code)) {
    return err(
      'sync/bad-invite',
      'Invite codes are 32 letters and digits (0-9, a-f). Copy the whole code from the other device.',
    );
  }
  return ok(code);
}

/** DHT topic for a room: the code itself never reaches the network. */
export function topicForInvite(code: string): Buffer {
  return Buffer.from(
    crypto.createHash('sha-256').update(`ekrooh/sync/v1\n${code}`).digest(),
  );
}
