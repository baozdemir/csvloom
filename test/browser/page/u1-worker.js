// The module worker of the U1 arm `stream-worker` (test/browser/page/u1.js): parses the posted
// File with parseStream, keeps nothing, posts each batch's row count, then the total and checksum.
import { parseStream } from 'csvloom/stream';
import { tally } from './u1-tally.ts';

self.onmessage = async ({ data: file }) => {
  try {
    const state = { rows: 0, sum: 0 };
    for await (const batch of parseStream(file.stream(), { header: true })) {
      tally(state, batch.data);
      self.postMessage({ batch: batch.data.length });
    }
    self.postMessage({ done: true, ...state });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
