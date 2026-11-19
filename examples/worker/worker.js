// The module worker that main.js starts. `transform` lives here: a function cannot be posted.
import { parseStream } from 'csvloom/stream';

const config = {
  header: true,
  transform: (value, field) => (field === 'value' ? Number(value) : value),
};

self.onmessage = async ({ data: { file, mode } }) => {
  try {
    let total = 0;
    let errors = 0;
    for await (const batch of parseStream(file.stream(), config)) {
      total += batch.data.length;
      errors += batch.errors.length;
      const progress = batch.data.length;
      self.postMessage(mode === 'batches' ? { progress, batch: batch.data } : { progress });
    }
    const finishedAt = performance.timeOrigin + performance.now();
    self.postMessage({ done: true, total, errors, finishedAt });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
