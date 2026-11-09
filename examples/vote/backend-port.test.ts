import { expect, test } from 'vite-plus/test';
import { backendPort } from './src/backend-port';

test('uses the port from ?backend=', () => {
  expect(backendPort('?backend=8082', 8080)).toBe('8082');
});

test('falls back without ?backend=', () => {
  expect(backendPort('', 8080)).toBe('8080');
});

test('rejects anything but 1 to 5 digits', () => {
  for (const bad of [
    '1@evil.com',
    '123456',
    'abc',
    '80 80',
    '',
    '-1',
    '8080/x',
  ]) {
    expect(backendPort(`?backend=${encodeURIComponent(bad)}`, 8080)).toBe(
      '8080',
    );
  }
});
