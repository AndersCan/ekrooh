import { describe, expect, it, vi } from 'vite-plus/test';
import fs from 'node:fs';
import path from 'node:path';
import type { HashOptions } from 'node:crypto';
import pkg from './package.json';
import { VERSION } from './core/messages';

// The `./runtime` public surface is a worklet module that imports bare-*;
// map them to Node equivalents so the export-names snapshot can load it.
vi.mock('bare-http1', async () => ({
  default: (await import('node:http')).default,
}));
vi.mock('bare-fs', async () => ({
  default: (await import('node:fs')).default,
}));
vi.mock('bare-path', async () => ({
  default: (await import('node:path')).default,
}));
vi.mock('bare-crypto', async () => {
  const crypto = await import('node:crypto');
  return {
    default: {
      ...crypto,
      createHash(algorithm: string, options?: HashOptions) {
        if (algorithm === 'blake2b-256') algorithm = 'sha256';
        return crypto.createHash(algorithm, options);
      },
    },
  };
});
vi.mock('bare-ws', async () => ({
  default: {
    Server: {
      handshake() {},
    },
    Socket: class {
      on() {}
      destroy() {}
      write() {
        return true;
      }
    },
  },
}));

const FRAMEWORK_CORE_ROOTS = [
  'core/messages',
  'core/lib',
  'core/server',
  'plugins',
  'web/transports',
];

const EXEMPT: Record<string, string> = {
  'core/messages/index.ts': 'barrel re-export',
  'core/messages/protocol.ts': 'barrel re-export',
  'core/messages/constants.ts':
    'wire constants; exercised via wire-codec tests',
  'core/messages/types.ts':
    'type definitions and CoreError; exercised indirectly',
  'web/transports/index.ts': 'barrel re-export',
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const PUBLIC_SURFACES: Record<string, { entry: string; exports: string[] }> = {
  core: {
    entry: './core/messages/index.ts',
    exports: [
      'CoreError',
      'ErrorCode',
      'MAX_FRAME_BYTES',
      'MAX_HEADER_BYTES',
      'MessageProtocol',
      'MessageType',
      'VERSION',
      'coerceErrorCode',
      'createBareRuntimeContext',
      'createPluginBus',
      'createPluginRegistry',
      'createPluginRouter',
      'createProtocolMessenger',
      'definePlugin',
      'dispatchEvent',
      'err',
      'invokeEvent',
      'ok',
    ],
  },
  plugins: {
    entry: './plugins/index.ts',
    exports: ['createDefaultPlugins'],
  },
  'plugins/health/events': {
    entry: './plugins/health/events.ts',
    exports: ['healthEvents', 'healthSpecs'],
  },
  'plugins/discovery/events': {
    entry: './plugins/discovery/events.ts',
    exports: ['discoveryEvents', 'discoverySpecs'],
  },
  'plugins/permissions/events': {
    entry: './plugins/permissions/events.ts',
    exports: ['permissionEvents', 'permissionSpecs'],
  },
  'plugins/media/events': {
    entry: './plugins/media/events.ts',
    exports: ['mediaEvents', 'mediaSpecs'],
  },
  transports: {
    entry: './web/transports/index.ts',
    exports: ['createMockTransport', 'createWebSocketTransport'],
  },
  runtime: {
    entry: './core/runtime.ts',
    exports: [
      'attachWebSocketProtocol',
      'createLoopbackServer',
      'createWorkletRuntime',
      'getIPC',
      'resolveWorkletConfig',
    ],
  },
};

describe('presence manifest', () => {
  it('every framework-core module ships a co-located test', () => {
    const missing: string[] = [];
    for (const root of FRAMEWORK_CORE_ROOTS) {
      for (const file of listSourceFiles(root)) {
        const rel = path.relative('.', file).split(path.sep).join('/');
        if (EXEMPT[rel]) continue;
        const sibling = file.replace(/\.ts$/, '.test.ts');
        if (!fs.existsSync(sibling)) missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('export-surface integrity', () => {
  it('every package.json exports entry resolves to a real path', () => {
    const missing: string[] = [];
    for (const [key, rel] of Object.entries(pkg.exports)) {
      if (typeof rel !== 'string') continue;
      if (!fs.existsSync(path.join('.', rel))) missing.push(`${key} -> ${rel}`);
    }
    expect(missing).toEqual([]);
  });

  it('every package.json files entry resolves to a real path', () => {
    const missing: string[] = [];
    for (const entry of pkg.files) {
      if (entry.startsWith('!')) continue;
      if (!fs.existsSync(path.join('.', entry))) missing.push(entry);
    }
    expect(missing).toEqual([]);
  });
});

describe('public API snapshot', () => {
  for (const [key, { entry, exports }] of Object.entries(PUBLIC_SURFACES)) {
    it(`@ekrooh/bare/${key} exports are frozen`, async () => {
      const mod = await import(entry);
      const actual = Object.keys(mod)
        .filter((k) => k !== 'default' && k !== '__esModule')
        .sort();
      expect(actual).toEqual([...exports].sort());
    });
  }

  it('wire protocol VERSION is pinned at 1', () => {
    expect(VERSION).toBe(1);
  });

  it('the built dist surface matches the source exports', async () => {
    for (const [key, { entry }] of Object.entries(PUBLIC_SURFACES)) {
      const distRel = (pkg.exports as Record<string, string>)[`./${key}`];
      if (typeof distRel !== 'string' || !distRel.startsWith('./dist/')) {
        continue;
      }
      const names = (m: unknown) =>
        Object.keys(m as Record<string, unknown>)
          .filter((k) => k !== 'default' && k !== '__esModule')
          .sort();
      const sourceMod = await import(entry);
      const distMod = await import(distRel);
      expect(names(distMod), `@ekrooh/bare/${key} dist === source`).toEqual(
        names(sourceMod),
      );
    }
  });
});
