// Starts `wrangler dev --local` on test/edge/worker.mjs, sends the probe
// requests, prints one JSON report on stdout (wrangler's own output goes to stderr) and stops
// wrangler with every process it started. Linux only (reads /proc). From the repository root,
// after `npm run build`: node test/edge/run.mjs. Exits 1 when a parse differs from bulk parse or
// a process is left behind.
/* global fetch */
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import { parse } from 'csvloom';

const edge = new URL('.', import.meta.url);
const version = (name) =>
  JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, edge), 'utf8'))
    .version;
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
      .once('error', reject)
      .listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
  });

// The same function as in worker.mjs.
const checksum = (hash, rows) => {
  for (const row of rows) {
    for (const field of row) {
      for (let i = 0; i < field.length; i++) hash = Math.imul(hash ^ field.charCodeAt(i), 16777619);
      hash = Math.imul(hash ^ 0x1f, 16777619);
    }
    hash = Math.imul(hash ^ 0x1e, 16777619);
  }
  return hash;
};

// Whole CRLF records of at least minBytes UTF-8 bytes: quoted fields with a doubled quote, a
// comma and a line break, and two-, three- and four-byte characters, so chunk boundaries fall
// inside every kind of token. The expected values come from bulk parse, not from parseStream.
const csv = (minBytes) => {
  const rows = [];
  for (let i = 0, bytes = 0; bytes < minBytes; i++) {
    const row = `${i},"quote ""${i}"", comma\nnext line",é€😀${i % 97},plain\r\n`;
    rows.push(row);
    bytes += Buffer.byteLength(row);
  }
  const text = rows.join('');
  const { data, errors } = parse(text);
  const expected = { rows: data.length, errors: errors.length };
  expected.checksum = checksum(0x811c9dc5, data) >>> 0;
  return { body: Buffer.from(text), expected };
};

const port = await freePort();
const inspectorPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const args = ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)];
args.push('--inspector-ip', '127.0.0.1', '--inspector-port', String(inspectorPort));
// No metrics, no error reports, no `request.cf` download from workers.cloudflare.com, no banner
// (its update check asks registry.npmjs.org), no log file under ~/.config; debug log to stderr.
const env = {
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_SEND_ERROR_REPORTS: 'false',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  WRANGLER_HIDE_BANNER: 'true',
  WRANGLER_WRITE_LOGS: 'false',
  WRANGLER_LOG: 'debug',
};
// detached: wrangler leads its own process group, so the group can be listed and stopped whole.
const child = spawn('npx', args, {
  cwd: edge,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...env },
});
child.stdout.pipe(process.stderr);
child.stderr.pipe(process.stderr);
const kill = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    kill('SIGKILL');
    process.exit(1);
  });
const group = () =>
  spawnSync('pgrep', ['-g', String(child.pid)], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);
const memory = (pid) => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const field = (name) => new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(status)?.[1];
    return { pid, name: field('Name'), VmHWM: field('VmHWM'), VmRSS: field('VmRSS') };
  } catch (error) {
    return { pid, error: String(error) };
  }
};
const request = async (path, body) => {
  try {
    const response = await fetch(base + path, body ? { method: 'POST', body } : {});
    const text = await response.text();
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      return { status: response.status, text: text.slice(0, 2000) };
    }
  } catch (error) {
    return { error: `${error.name}: ${error.message} ${error.cause ?? ''}` };
  }
};
const parsed = async (minBytes, path) => {
  const { body, expected } = csv(minBytes);
  const got = await request(path, body);
  const value = got.json?.ok ? got.json.value : undefined;
  const pass = ['rows', 'errors', 'checksum'].every((key) => value?.[key] === expected[key]);
  return { postedBytes: body.length, expected, got, pass };
};

const report = {
  date: new Date().toISOString(),
  node: process.version,
  wrangler: version('wrangler'),
  workerd: version('workerd'),
  compatibilityDate: /^compatibility_date = "(.*)"$/m.exec(
    readFileSync(new URL('wrangler.toml', edge), 'utf8'),
  )?.[1],
  command: `npx ${args.join(' ')} (cwd test/edge)`,
  env,
  probes: {},
};
try {
  let ready = false;
  for (let i = 0; i < 600 && !ready && child.exitCode === null; i++) {
    ready = (await request('/ready')).json?.ready === true;
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error('wrangler dev did not answer within 120 s');
  const { probes } = report;
  const started = performance.now();
  probes.runtime = await request('/runtime');
  // DIAGNOSTIC, not a measurement: shows that the clock probe's fixed CPU loop took real time.
  probes.runtime.diagnosticRoundTripMs = Math.round(performance.now() - started);
  probes.parse1MiB = await parsed(1_048_576, '/parse');
  // Heap first, so that each allocation's peak shows in the workerd VmHWM read after it.
  for (const kind of ['Heap', 'Buffer']) {
    const probe = await request(`/alloc/${kind.toLowerCase()}`);
    probe.workerdAfter = group()
      .map(memory)
      .filter(({ name }) => name === 'workerd');
    probes[`alloc${kind}300MiB`] = probe;
  }
  probes.parse100MiB = await parsed(104_857_600, '/parse?count');
} catch (error) {
  report.error = String(error);
} finally {
  report.processesBeforeStop = group().map(memory);
  kill('SIGTERM');
  for (let i = 0; i < 100 && group().length > 0; i++) await sleep(100);
  if (group().length > 0) {
    report.sigkill = group();
    kill('SIGKILL');
    await sleep(500);
  }
  report.processesAfterStop = group();
  rmSync(new URL('.wrangler', edge), { recursive: true, force: true });
  report.runnerMaxRssKiB = process.resourceUsage().maxRSS;
}
const ok =
  report.probes.parse1MiB?.pass === true &&
  report.probes.parse100MiB?.pass === true &&
  report.processesAfterStop.length === 0;
process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
process.exitCode = ok ? 0 : 1;
