// The U1 page: one arm of the browser file flow, named by ?arm=, on the file set in the input
// (Playwright sets it). The page copies the file's bytes into a new in-memory File, takes the
// largest gap of a 4 ms setTimeout ticker on the idle page for one second, then runs the arm with
// the ticker on and prints JSON in #out: rows and checksum, total time, time to the first batch on
// the main thread and the largest ticker gap. Times are used only by bench/u1.ts;
// test/browser/u1.pw.ts keeps rows and checksum only.
import { parse } from 'csvloom';
import { parseStream } from 'csvloom/stream';
import Papa from 'papaparse';
import { tally } from './u1-tally.ts';

const config = { header: true };

// Papa's own file flow: 10 MiB FileReader slices and a row array per chunk; `worker` is its
// `worker: true` (a classic worker from a blob: URL that Papa creates per call).
function papa(file, first, worker) {
  return new Promise((resolve, reject) => {
    const state = { rows: 0, sum: 0 };
    Papa.parse(file, {
      ...config,
      worker,
      chunk: ({ data }) => {
        first();
        tally(state, data);
      },
      complete: () => resolve(state),
      error: reject,
    });
  });
}

// Each arm resolves { rows, sum } and calls first() when a batch reaches the main thread.
const arms = {
  'stream-worker': (file, first) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./u1-worker.js', import.meta.url), { type: 'module' });
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || 'worker error event without a message'));
      };
      worker.onmessage = ({ data }) => {
        if ('batch' in data) {
          first();
          return;
        }
        worker.terminate();
        if ('error' in data) reject(new Error(data.error));
        else resolve({ rows: data.rows, sum: data.sum });
      };
      worker.postMessage(file);
    }),
  'stream-main': async (file, first) => {
    const state = { rows: 0, sum: 0 };
    for await (const batch of parseStream(file.stream(), config)) {
      first();
      tally(state, batch.data);
    }
    return state;
  },
  'bulk-main': async (file, first) => {
    const { data } = parse(await file.text(), config);
    first();
    const state = { rows: 0, sum: 0 };
    tally(state, data);
    return state;
  },
  'papa-worker': (file, first) => papa(file, first, true),
  'papa-main': (file, first) => papa(file, first, false),
};

const now = () => performance.now();

// Runs `flow` with a 4 ms setTimeout ticker on the main thread; the start and the end count as ticks.
async function measure(flow) {
  const start = now();
  let last = start;
  let maxGap = 0;
  let firstAt;
  let timer;
  const tick = () => {
    const t = now();
    maxGap = Math.max(maxGap, t - last);
    last = t;
    timer = setTimeout(tick, 4);
  };
  timer = setTimeout(tick, 4);
  try {
    const result = await flow(() => (firstAt ??= now()));
    const end = now();
    const maxGapMs = Math.max(maxGap, end - last);
    return { ...result, totalMs: end - start, firstBatchMs: firstAt - start, maxGapMs };
  } finally {
    clearTimeout(timer);
  }
}

const input = document.querySelector('#file');
const out = document.querySelector('#out');
const arm = new URLSearchParams(location.search).get('arm');

input.addEventListener('change', async () => {
  let result;
  try {
    if (!Object.hasOwn(arms, arm)) throw new Error(`unknown arm ${String(arm)}`);
    const file = new File([await input.files[0].arrayBuffer()], 'u1.csv', { type: 'text/csv' });
    const idle = await measure(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    // A blocked worker or script would otherwise leave the arm waiting forever.
    const blocked = new Promise((resolve, reject) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        reject(new Error(`CSP ${event.effectiveDirective} blocked ${event.blockedURI}`));
      });
    });
    const run = await measure((first) => Promise.race([arms[arm](file, first), blocked]));
    result = { arm, bytes: file.size, idleMaxGapMs: idle.maxGapMs, ...run };
  } catch (error) {
    result = { arm, error: String(error) };
  }
  out.textContent = JSON.stringify(result);
  out.dataset.done = '';
});
