import { describe, expect, it } from 'vite-plus/test';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode } from './core/messages/constants';

// The hosts mirror the canonical `ErrorCode` table by hand. Their own parity
// tests can only compare a file with itself, so this one reads the Kotlin and
// Swift sources and compares them with the TypeScript values (H-10).

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** `const val NAME = "VALUE"` inside `object ErrorCodes { … }`. */
function kotlinCodes(source: string): Record<string, string> {
  const body = /object\s+ErrorCodes\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  return Object.fromEntries(
    [
      ...body.matchAll(
        /const\s+val\s+(\w+)\s*(?::\s*String\s*)?=\s*"([^"]*)"/g,
      ),
    ].map(([, name, value]) => [name, value]),
  );
}

/** `static let name = "VALUE"` inside `enum ErrorCodes { … }`. */
function swiftCodes(source: string): Record<string, string> {
  const body = /enum\s+ErrorCodes\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  return Object.fromEntries(
    [
      ...body.matchAll(
        /static\s+let\s+(\w+)\s*(?::\s*String\s*)?=\s*"([^"]*)"/g,
      ),
    ].map(([, name, value]) => [name, value]),
  );
}

/** `UNSUPPORTED_CAPABILITY` → `unsupportedCapability`. */
const camel = (name: string) =>
  name.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('host ErrorCodes match core/messages ErrorCode', () => {
  const canonical = { ...ErrorCode } as Record<string, string>;

  it('Kotlin ErrorCodes has every code, with the same name and value', () => {
    const kt = kotlinCodes(
      read('android/src/main/java/to/holepunch/bare/android/ErrorCodes.kt'),
    );
    expect(kt).toEqual(canonical);
  });

  it('Swift ErrorCodes has every code, with the camelCase name and same value', () => {
    const swift = swiftCodes(read('ios/Sources/BareHost/ErrorCodes.swift'));
    const expected = Object.fromEntries(
      Object.entries(canonical).map(([name, value]) => [camel(name), value]),
    );
    expect(swift).toEqual(expected);
  });

  it('the parsers see a drifted value or a missing code', () => {
    const kt = kotlinCodes(
      'object ErrorCodes {\n    const val HOST_ERROR = "HOST_ERR"\n}\n',
    );
    expect(kt).toEqual({ HOST_ERROR: 'HOST_ERR' });
    expect(kt).not.toEqual(canonical);
    const swift = swiftCodes(
      'public enum ErrorCodes {\n  public static let hostError = "HOST_ERROR"\n}\n',
    );
    expect(swift).toEqual({ hostError: 'HOST_ERROR' });
  });
});
