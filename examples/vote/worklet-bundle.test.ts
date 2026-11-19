import { expect, test } from 'vite-plus/test';
// @ts-expect-error plain .mjs helper without types
import {
  bundlePath,
  createBundleRoute,
  etagFor,
} from './scripts/worklet-bundle.mjs';

function call(route: any, url: string, headers: Record<string, string> = {}) {
  const out = {
    status: 200,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    nexted: false,
  };
  const res = {
    set statusCode(code: number) {
      out.status = code;
    },
    setHeader(name: string, value: unknown) {
      out.headers[name] = value;
    },
    end(body?: unknown) {
      out.body = body;
    },
  };
  route.handle({ url, method: 'GET', headers }, res, () => {
    out.nexted = true;
  });
  return out;
}

test('serves the bytes with an etag, then 304 for a matching If-None-Match', () => {
  const route = createBundleRoute();
  const bytes = Buffer.from('bundle one');
  route.set(bytes);
  const etag = etagFor(bytes);
  const first = call(route, bundlePath);
  expect(first.status).toBe(200);
  expect(first.headers.ETag).toBe(etag);
  expect(first.body).toBe(bytes);
  expect(call(route, bundlePath, { 'if-none-match': etag }).status).toBe(304);
  expect(
    call(route, `${bundlePath}?x=1`, { 'if-none-match': etag }).status,
  ).toBe(304);
});

test('a new bundle changes the etag and a stale one gets 200', () => {
  const route = createBundleRoute();
  route.set(Buffer.from('one'));
  const old = etagFor(Buffer.from('one'));
  route.set(Buffer.from('two'));
  const next = call(route, bundlePath, { 'if-none-match': old });
  expect(next.status).toBe(200);
  expect(next.headers.ETag).toBe(etagFor(Buffer.from('two')));
  expect(next.headers.ETag).not.toBe(old);
});

test('503 before the first pack, other paths', () => {
  const route = createBundleRoute();
  expect(call(route, bundlePath).status).toBe(503);
  expect(call(route, '/index.html').nexted).toBe(true);
});
