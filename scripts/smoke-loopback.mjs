import fs from 'bare-fs';
import os from 'bare-os';
import path from 'bare-path';
import http from 'bare-http1';
import tcp from 'bare-tcp';
import ws from 'bare-ws';
import { TextEncoder, TextDecoder } from 'bare-encoding';
import { createLoopbackServer } from '../core/server/static-file-server';
import { MessageType, MessageProtocol } from '../core/messages';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-smoke-'));
fs.writeFileSync(path.join(dir, 'index.html'), '<html>index</html>');
fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("app")');
fs.mkdirSync(path.join(dir, 'assets'));
fs.writeFileSync(path.join(dir, 'assets', 'main.js'), 'export const x = 1');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const server = createLoopbackServer({ auth: true });
server.mountDir('/', dir);
// Media is a session-scoped file mount: requires auth even with the public
// web app.
server.mount('/media/sample.png', path.join(dir, 'app.js'));
// Echo handler so the WS path round-trips without the plugin router.
server.onConnection((socket) => {
  socket.on('data', (raw) => socket.write(raw));
});
const creds = await server.credentials();
console.log('origin:', creds.origin, 'token len:', creds.token.length);

function request(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${creds.origin}${urlPath}`, { method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on('error', reject);
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      req.setHeader(k, v);
    if (opts.body) req.end(opts.body);
    else req.end();
  });
}

// 1. Web app (directory mount) is public: a fresh WebView must load the page
// before it can /login.
let r = await request('GET', '/');
check(
  'public web app -> 200 index',
  r.status === 200 && r.body === '<html>index</html>',
);

// 2. Media (file mount) without auth -> 401
r = await request('GET', '/media/sample.png');
check('media without auth -> 401', r.status === 401);

// 3. Login with token -> cookie
r = await request('POST', '/login', { body: creds.token });
check('login -> 200', r.status === 200);
const setCookie = r.headers['set-cookie'];
check(
  'login sets bare_session cookie',
  typeof setCookie === 'string' && setCookie.startsWith('bare_session='),
);
check('cookie is HttpOnly', setCookie.includes('HttpOnly'));
check('cookie is SameSite=Lax', setCookie.includes('SameSite=Lax'));

// 4. Wrong token -> 401
r = await request('POST', '/login', { body: 'nope' });
check('bad login -> 401', r.status === 401);

// 5. Cookie auth serves media
const cookie = setCookie.split(';')[0];
r = await request('GET', '/media/sample.png', { headers: { cookie } });
check(
  'media with cookie -> 200',
  r.status === 200 && r.body === 'console.log("app")',
);

// 6. Query token fallback works on protected mounts
r = await request('GET', `/media/sample.png?token=${creds.token}`);
check('query token -> 200', r.status === 200);

// 7. Header token fallback works on protected mounts
r = await request('GET', '/media/sample.png', {
  headers: { 'X-Bare-Token': creds.token },
});
check(
  'header token -> 200 media',
  r.status === 200 && r.body === 'console.log("app")',
);

// 8. Traversal is rejected outright (raw request line — the HTTP client
// normalizes `..` away before sending)
const port = Number(creds.origin.slice(creds.origin.lastIndexOf(':') + 1));
const rawResp = await new Promise((resolve, reject) => {
  let data = '';
  const socket = tcp.connect({ host: '127.0.0.1', port });
  socket.on('connect', () =>
    socket.write(
      `GET /../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    ),
  );
  socket.on('data', (d) => {
    data += String(d);
    // The server keeps the connection alive after responding; resolve on the
    // first complete status line.
    if (data.includes('\r\n')) {
      socket.destroy();
      resolve(data);
    }
  });
  socket.on('error', reject);
  setTimeout(() => {
    if (!data) reject(new Error('raw request timeout'));
  }, 3000);
});
check('traversal rejected', /400/.test(rawResp.split('\r\n')[0]));

// 9. SPA fallback: unknown navigation path serves index.html
r = await request('GET', '/some/route', {
  headers: { cookie, accept: 'text/html,application/xhtml+xml' },
});
check(
  'SPA fallback -> index',
  r.status === 200 && r.body === '<html>index</html>',
);

// 10. Missing asset (no text/html Accept) -> 404
r = await request('GET', '/assets/missing.js', { headers: { cookie } });
check('missing asset -> 404', r.status === 404);

// 11. Range request
r = await request('GET', '/app.js', {
  headers: { cookie, range: 'bytes=0-3' },
});
check('range -> 206 partial', r.status === 206 && r.body === 'cons');
check('content-range present', typeof r.headers['content-range'] === 'string');

// 12. Overlong range is clamped to the file size
r = await request('GET', '/app.js', {
  headers: { cookie, range: 'bytes=2-500' },
});
check('overlong range clamped -> 206', r.status === 206);
check(
  'overlong range body length',
  r.body.length === 'console.log("app")'.length - 2,
);

// 13. MIME types
r = await request('GET', '/app.js', { headers: { cookie } });
check('js mime', r.headers['content-type'] === 'text/javascript');
r = await request('GET', '/assets/main.js', { headers: { cookie } });
check('asset mime', r.headers['content-type'] === 'text/javascript');

// 14. No-referrer on responses
r = await request('GET', '/app.js', { headers: { cookie } });
check(
  'referrer-policy no-referrer',
  r.headers['referrer-policy'] === 'no-referrer',
);

// 15. WS with query token -> handshake, echo a frame
const protocol = new MessageProtocol({
  encode: (str) => new TextEncoder().encode(str),
  decode: (bytes) => new TextDecoder().decode(bytes),
});
const wsResult = await new Promise((resolve) => {
  const socket = new ws.Socket(`${creds.origin}/ws?token=${creds.token}`);
  let done = false;
  const finish = (v) => {
    if (!done) {
      done = true;
      resolve(v);
    }
  };
  socket.write(
    protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'smoke-1',
        args: { message: 'hi' },
      },
      null,
    ),
  );
  socket.on('data', () => finish({ opened: true }));
  socket.on('error', (e) => finish({ opened: false, error: e.message }));
  socket.on('close', () => finish({ opened: false, error: 'closed' }));
  setTimeout(() => finish({ opened: false, error: 'timeout' }), 3000);
});
check('ws with token opens and receives a frame', wsResult.opened === true);

// 16. WS without token is rejected
const noAuthWs = await new Promise((resolve) => {
  const socket = new ws.Socket(`${creds.origin}/ws`);
  let done = false;
  const finish = (v) => {
    if (!done) {
      done = true;
      resolve(v);
    }
  };
  socket.write(new Uint8Array([1]));
  socket.on('open', () => finish({ opened: true }));
  socket.on('error', (e) => finish({ opened: false, error: e.message }));
  socket.on('close', () => finish({ opened: false, error: 'closed' }));
  setTimeout(() => finish({ opened: false, error: 'timeout' }), 3000);
});
check('ws without token is rejected', noAuthWs.opened === false);

// 17. Dev mode (auth off): public content, and a cross-origin WS upgrade from
// the Vite dev server (different Origin) must complete.
const dev = createLoopbackServer({ auth: false, port: 0 });
dev.mountDir('/', dir);
const devCreds = await dev.credentials();
const devUpgrade = await new Promise((resolve) => {
  let data = '';
  const socket = tcp.connect({ host: '127.0.0.1', port: devCreds.port });
  socket.on('connect', () =>
    socket.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${devCreds.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: http://localhost:5173',
        '\r\n',
      ].join('\r\n'),
    ),
  );
  socket.on('data', (d) => {
    data += String(d);
    if (data.includes('\r\n')) {
      socket.destroy();
      resolve(data);
    }
  });
  socket.on('error', () => resolve(''));
  setTimeout(() => {
    if (!data) resolve('');
  }, 3000);
});
check(
  'dev cross-origin WS upgrade succeeds',
  /101/.test(devUpgrade.split('\r\n')[0]),
);
await new Promise((resolve) => dev.close(resolve));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
await new Promise((resolve) => server.close(resolve));
if (failures > 0) throw new Error(`${failures} smoke failures`);
