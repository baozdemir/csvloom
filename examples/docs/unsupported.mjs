import Papa from 'csvloom/papa';

// Papa's callbacks, workers, downloads and non-string inputs are not here. Asking for one
// throws; it is never ignored.
const requests = {
  step: () => Papa.parse('a,b', { step() {} }),
  complete: () => Papa.parse('a,b', { complete() {} }),
  worker: () => Papa.parse('a,b', { worker: true }),
  download: () => Papa.parse('https://example.com/data.csv', { download: true }),
  encoding: () => Papa.parse('a,b', { encoding: 'latin1' }),
  'a File or Blob': () => Papa.parse(new Blob(['a,b'])),
};
for (const [request, run] of Object.entries(requests)) {
  try {
    run();
  } catch (error) {
    console.log(`${request}: ${error.name}: ${error.message}`);
  }
}
