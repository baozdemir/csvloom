// Real Safari through safaridriver: WebDriver over HTTP with fetch, no dependency. Starts the test
// server and `safaridriver --port <free port>`, loads probe.html and the worker example (both modes,
// a generated 5 MiB File given through a DataTransfer), and prints one JSON result with Safari's
// and macOS's versions; exit code 0 only when every check passed. Needs Safari's Develop >
// "Allow Remote Automation", which this script never changes. Mac only, no timing.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { makeCsv } from './page/data.js';
import { serve } from './server.mjs';

const WORKER_SIZE = 5 * 2 ** 20;
const FIRST_ROW = { id: '0', name: 'name 0', note: 'café €0, "q"\nline 2', value: 0.5 };
const GIVE_FILE = `const [mode, url, done] = arguments;
fetch(url).then((response) => response.blob()).then((blob) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'data.csv', { type: 'text/csv' }));
  const input = document.querySelector('#file');
  document.querySelector('#mode').value = mode;
  input.files = transfer.files;
  input.dispatchEvent(new Event('change'));
  done(blob.size);
}, (error) => done(String(error)));`;
const READ_RESULT = "return document.querySelector('#out[data-done]')?.textContent ?? null;";

const sh = (command, ...args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

async function poll(read, what) {
  for (const deadline = Date.now() + 180_000; Date.now() < deadline; await sleep(250)) {
    const value = await read();
    if (value !== null) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const result = {
  macOS: `${sh('sw_vers', '-productName')} ${sh('sw_vers', '-productVersion')} (${sh('sw_vers', '-buildVersion')})`,
  safariProcessesBefore: sh('pgrep', '-x', 'Safari'),
};
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer().listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
portProbe.close();
const driver = spawn('safaridriver', ['--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let driverOutput = '';
driver.stdout.on('data', (chunk) => (driverOutput += chunk));
driver.stderr.on('data', (chunk) => (driverOutput += chunk));

async function wd(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const { value } = await response.json();
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}

let session;
try {
  const status = () =>
    fetch(`http://127.0.0.1:${port}/status`).then(
      (r) => r.ok || null,
      () => null,
    );
  await poll(status, 'safaridriver to listen');
  session = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'safari' } },
  });
  result.safari = session.capabilities.browserVersion;
  result.capabilities = session.capabilities;
  const at = `/session/${session.sessionId}`;
  const read = async () => {
    const value = await wd('POST', `${at}/execute/sync`, { script: READ_RESULT, args: [] });
    return value === null ? null : JSON.parse(value);
  };
  await wd('POST', `${at}/url`, { url: `${base}/test/browser/page/probe.html` });
  result.probes = await poll(read, 'probe.html');
  result.worker = [];
  const expectedRows = makeCsv(WORKER_SIZE).rows;
  for (const mode of ['count', 'batches']) {
    await wd('POST', `${at}/url`, { url: `${base}/examples/worker/index.html` });
    const args = [mode, `/data.csv?size=${WORKER_SIZE}`];
    const fileBytes = await wd('POST', `${at}/execute/async`, { script: GIVE_FILE, args });
    const { firstProgressAt, finishedAt, ...summary } = await poll(read, `worker (${mode})`);
    // The ordering check (progress before the end), kept as a boolean only: no time is reported.
    const progressBeforeFinish = firstProgressAt < finishedAt;
    result.worker.push({ mode, fileBytes, expectedRows, ...summary, progressBeforeFinish });
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  if (session) {
    await wd('DELETE', `/session/${session.sessionId}`).catch((error) => {
      result.deleteSessionError = String(error);
    });
  }
  driver.kill();
  if (driver.exitCode === null && driver.signalCode === null) await once(driver, 'exit');
  server.closeAllConnections();
  server.close();
}
result.safaridriverOutput = driverOutput;
result.safariProcessesAfter = sh('pgrep', '-x', 'Safari');
result.pass =
  result.error === undefined &&
  result.probes?.pass === true &&
  result.worker?.length === 2 &&
  result.worker.every(
    (run) =>
      run.error === undefined &&
      run.total === run.expectedRows &&
      run.rows === run.expectedRows &&
      run.errors === 0 &&
      run.progressBeforeFinish === true &&
      (run.mode === 'count' || isDeepStrictEqual(run.first, FIRST_ROW)),
  );
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.pass ? 0 : 1;
