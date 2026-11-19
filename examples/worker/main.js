// Parses a CSV file in a module worker, so the page stays responsive. This is not Papa's
// `worker: true`: csvloom has no worker mode; the page owns the worker and its messages.
const input = document.querySelector('#file');
const mode = document.querySelector('#mode');
const out = document.querySelector('#out');

input.addEventListener('change', () => {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let rows = 0;
  let first;
  let firstProgressAt;
  worker.onmessage = ({ data }) => {
    if ('progress' in data) {
      // The worker's clock too, so the two can be compared.
      firstProgressAt ??= performance.timeOrigin + performance.now();
      rows += data.progress;
      first ??= data.batch?.[0];
      out.textContent = `${rows} rows so far`;
      return;
    }
    worker.terminate();
    out.textContent = JSON.stringify({ ...data, rows, first, firstProgressAt });
    out.dataset.done = '';
  };
  worker.postMessage({ file: input.files[0], mode: mode.value });
});
