import { describe, expect, it } from 'vite-plus/test';
import { createInviteCode, parseInviteCode, topicForInvite } from './invite';

describe('invite codes', () => {
  it('creates 32 lowercase hex characters', () => {
    expect(createInviteCode()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('parse trims and lowercases', () => {
    const [error, code] = parseInviteCode(
      '  3F9A0C11223344556677889900AABBCC \n',
    );
    expect(error).toBeNull();
    expect(code).toBe('3f9a0c11223344556677889900aabbcc');
  });

  it.each(['', 'a'.repeat(31), 'g'.repeat(32), 'a'.repeat(33)])(
    'rejects %j',
    (text) => {
      const [error] = parseInviteCode(text);
      expect(error?.code).toBe('sync/bad-invite');
    },
  );

  it('topic is 32 bytes, stable, and not the code bytes', () => {
    const code = 'ab'.repeat(16);
    const topic = topicForInvite(code);
    expect(topic.length).toBe(32);
    expect(topicForInvite(code).equals(topic)).toBe(true);
    expect(topic.subarray(0, 16).equals(Buffer.from(code, 'hex'))).toBe(false);
    expect(topicForInvite('cd'.repeat(16)).equals(topic)).toBe(false);
  });
});
