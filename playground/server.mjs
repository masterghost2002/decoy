/**
 * The playground's real server: what a request reaches when no rule takes it.
 *
 * Half the value of a mocking tool's test suite is in the *negative* cases --
 * "the near-identical request that should not have matched went to the network
 * instead" -- and that needs a real network to go to. So every endpoint here
 * answers with something the page can tell apart from a mock at a glance:
 * `{"server": true, ...}`.
 *
 * It also serves the harness itself, deliberately under a hostile content
 * security policy. No `unsafe-eval`, so nothing in this page could compile a
 * handler; no `frame-src` beyond self, so it cannot iframe one either. That is
 * what a hardened app looks like, and the handler sandbox has to work inside
 * one.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/*
 * Deliberately hostile, and the reason handlers are architected the way they
 * are: a site policy without `unsafe-eval` makes building a function from a
 * string impossible in this page, and `frame-src 'self'` stops it iframing one.
 * The sandbox is an extension frame, which neither directive reaches.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "frame-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // `*` does not cover the non-network schemes, and two cases deliberately
  // fetch a data: url and a blob: url to prove neither is intercepted.
  'connect-src * data: blob: ws:',
  "worker-src 'self' blob:",
].join('; ');

/** A 1x1 transparent png, so the image cases have a real image to load. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Fixed answers for the paths a scenario asserts exactly. */
const CANNED = {
  '/api/users/me': { real: true },
  '/api/ping': { pong: true },
};

function readRequestBody(request) {
  return new Promise((resolve) => {
    const parts = [];
    request.on('data', (chunk) => parts.push(chunk));
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    request.on('error', () => resolve(''));
  });
}

function json(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': '*',
    ...extraHeaders,
  });
  response.end(body);
}

/* -------------------------------------------------------------------------- */
/* A minimal WebSocket echo                                                   */
/*                                                                            */
/* Only enough of RFC 6455 to accept one connection and echo short text       */
/* frames back. It exists so "a rule on a WebSocket url changes nothing" is a  */
/* real assertion rather than a sentence in a README: without a server that    */
/* genuinely works, a failed connection would prove nothing either way.        */
/* -------------------------------------------------------------------------- */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptWebSocket(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );

  socket.on('data', (frame) => {
    // Opcode 1 (text), masked, payload under 126 bytes. Anything else is not
    // something the playground sends.
    const opcode = frame[0] & 0x0f;
    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode !== 0x1) return;

    const masked = (frame[1] & 0x80) !== 0;
    const length = frame[1] & 0x7f;
    if (length > 125 || !masked) return;

    const mask = frame.subarray(2, 6);
    const payload = Buffer.from(frame.subarray(6, 6 + length));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }

    const reply = Buffer.from(`echo:${payload.toString('utf8')}`);
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
  });
  socket.on('error', () => {
    socket.destroy();
  });
}

/* -------------------------------------------------------------------------- */
/* The main origin                                                            */
/* -------------------------------------------------------------------------- */

export function startPlaygroundServer({ port, altPort, host = '127.0.0.1' } = {}) {
  /** Beacons and other fire-and-forget requests, so the page can ask later. */
  const received = [];

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
        'access-control-allow-headers': '*',
      });
      response.end();
      return;
    }

    /*
     * What the page needs to know about its own deployment, as a script rather
     * than as an inline tag: this page's policy has no 'unsafe-inline', which
     * is the whole point of serving it under a hostile one.
     */
    if (pathname === '/config.js') {
      const config = {
        origin: `http://${host}:${String(port)}`,
        port,
        altPort: altPort ?? null,
        altOrigin:
          altPort === undefined || altPort === null ? null : `http://${host}:${String(altPort)}`,
      };
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(`window.__decoyPlayground = ${JSON.stringify(config)};\n`);
      return;
    }

    /* -- endpoints the cases need a specific answer from -- */

    if (pathname === '/real/received') {
      json(response, 200, { server: true, received });
      return;
    }

    if (pathname === '/real/set-cookie') {
      json(
        response,
        200,
        { server: true, set: true },
        {
          'set-cookie': [
            'pg_visible=yes; Path=/; SameSite=Lax',
            'pg_httponly=hidden; Path=/; HttpOnly; SameSite=Lax',
          ],
        },
      );
      return;
    }

    if (pathname === '/real/redirect') {
      response.writeHead(302, { location: '/real/redirected', 'access-control-allow-origin': '*' });
      response.end();
      return;
    }

    if (pathname === '/real/redirected') {
      json(response, 200, { server: true, redirected: true });
      return;
    }

    if (pathname === '/real/slow') {
      const ms = Math.min(5000, Number(url.searchParams.get('ms') ?? '300'));
      setTimeout(() => {
        json(response, 200, { server: true, waited: ms });
      }, ms);
      return;
    }

    if (pathname === '/real/status') {
      const code = Math.min(599, Math.max(200, Number(url.searchParams.get('code') ?? '200')));
      json(response, code, { server: true, status: code });
      return;
    }

    // A real event stream, so the EventSource case can tell "the server
    // answered" from "the mock answered".
    if (pathname === '/pg/limit/eventsource') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        response.write(`data: {"from":"server","n":${String(sent)}}\n\n`);
        if (sent >= 3) {
          clearInterval(timer);
          response.end();
        }
      }, 40);
      request.on('close', () => {
        clearInterval(timer);
      });
      return;
    }

    if (pathname === '/pg/asset/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(PIXEL);
      return;
    }

    if (pathname === '/pg/asset/probe.css') {
      // The value is what the page reads back to prove the real stylesheet won.
      response.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
      response.end('#pg-css-probe { outline-color: rgb(1, 2, 3); }');
      return;
    }

    /* -- everything under /api and /pg: the universal echo -- */

    if (
      pathname.startsWith('/api/') ||
      pathname.startsWith('/pg/') ||
      pathname.startsWith('/real/')
    ) {
      const body = await readRequestBody(request);
      if (pathname === '/pg/limit/beacon') {
        received.push({ path: pathname, method: request.method, body });
      }

      if (CANNED[pathname] !== undefined) {
        json(response, 200, CANNED[pathname]);
        return;
      }

      json(response, 200, {
        server: true,
        path: pathname,
        method: request.method,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: body.length === 0 ? null : body,
      });
      return;
    }

    /* -- the harness itself -- */

    const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.join(ROOT, name);
    // No traversal out of the playground directory.
    if (!target.startsWith(ROOT)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    try {
      const file = await readFile(target);
      const extension = path.extname(target);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'content-security-policy': PAGE_CSP,
      });
      response.end(file);
    } catch {
      response.writeHead(404).end('not found');
    }
  }

  server.on('upgrade', (request, socket) => {
    acceptWebSocket(request, socket);
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The second origin                                                          */
/*                                                                            */
/* Exists to answer one question a single origin cannot: a mocked cross-origin */
/* request needs no CORS headers at all, because no request is ever made. This */
/* server sends none, so the control case genuinely fails and the mocked one   */
/* genuinely could not have reached the network.                               */
/* -------------------------------------------------------------------------- */

export function startAltOriginServer({ port, host = '127.0.0.1' } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
    // No access-control-allow-origin, on purpose.
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ server: true, origin: 'alt', path: url.pathname }));
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}
