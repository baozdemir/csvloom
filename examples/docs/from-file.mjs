import { parseStream } from 'csvloom/stream';

// Papa: Papa.parse(file, { header: true, step: (row) => save(row.data), complete: done });
const file = new File(['id,name\n1,Ada\n2,Grace\n'], 'people.csv');
const saved = [];

for await (const batch of parseStream(file.stream(), { header: true, skipEmptyLines: true })) {
  for (const row of batch.data) saved.push(row); // what step did, a batch at a time
  for (const error of batch.errors) console.log(error.code, error.row);
}
console.log(JSON.stringify(saved)); // what complete did: the loop has ended
