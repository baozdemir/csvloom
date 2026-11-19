// The local server of the browser tests (Playwright's webServer, and safari.mjs). It serves
// test/browser/page/ and examples/ with `Content-Security-Policy: script-src 'self'` on every
// response, bundles each .js file on request with esbuild (platform 'browser', so
// 'csvloom/stream' resolves through the package's exports to the built dist/), and serves
// generated CSV at /data.csv?size=N (at least N bytes) with its row count in X-Rows. The U1 page
// also allows blob: workers, because Papa's `worker: true` starts one; under
// `script-src 'self'` alone every engine blocks it. Bundles are built once per server.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { makeCsv } from './page/data.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const servedDirs = [join(root, 'test/browser/page') + sep, join(root, 'examples') + sep];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const csp = { 'content-security-policy': "script-src 'self'", 'cache-control': 'no-store' };
const u1Csp = { ...csp, 'content-security-policy': "script-src 'self'; worker-src 'self' blob:" };
const bundles = new Map();

async function content(path) {
  if (extname(path) !== '.js') return readFile(path);
  await readFile(path); // a missing file is a 404, not a bundling error
  if (!bundles.has(path)) {
    const result = build({
      entryPoints: [path],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
    });
    bundles.set(
      path,
      result.then(({ outputFiles }) => outputFiles[0].contents),
    );
  }
  return bundles.get(path);
}

async function respond(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/data.csv') {
    const { text, rows } = makeCsv(Number(url.searchParams.get('size')));
    const headers = { 'content-type': 'text/csv; charset=utf-8', 'x-rows': String(rows) };
    response.writeHead(200, { ...csp, ...headers }).end(text);
    return;
  }
  const path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!servedDirs.some((dir) => path.startsWith(dir))) {
    response.writeHead(404, csp).end();
    return;
  }
  const body = await content(path);
  const type = types[extname(path)] ?? 'application/octet-stream';
  const policy = path.endsWith(`${sep}u1.html`) ? u1Csp : csp;
  response.writeHead(200, { ...policy, 'content-type': type }).end(body);
}

/** Listens on 127.0.0.1:`port` (0 for a free port) and resolves the http.Server. */
export function serve(port) {
  const server = createServer((request, response) => {
    respond(request, response).catch((error) => {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, csp).end(String(error));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await serve(Number(process.argv[2]));
