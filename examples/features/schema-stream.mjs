import { parseDetailed } from 'csvloom';
import { parseStream } from 'csvloom/stream';

// A validator that answers later: a Standard Schema v1 object whose validate returns a promise.
const person = {
  '~standard': {
    version: 1,
    vendor: 'example',
    async validate(row) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const issues = [];
      if (typeof row.name !== 'string')
        issues.push({ message: 'name is required', path: ['name'] });
      if (!Number.isInteger(row.age))
        issues.push({ message: 'age must be a whole number', path: ['age'] });
      return issues.length > 0 ? { issues } : { value: { name: row.name, age: row.age } };
    },
  },
};

// The source arrives in pieces, and a piece can end inside a record.
const chunks = ['name,age\nAda,36\nGra', 'ce,x\n,41\nLinus,2.5\nAl', 'an,41\n'];
const config = {
  header: true,
  dynamicTyping: true,
  skipEmptyLines: true,
  positions: true,
  schema: person,
};

// A batch is built from batchSize rows (fewer once its text reaches 1,048,576 units) and then
// validated, one row at a time and in input order:
// data holds the valid rows, so it can hold fewer than batchSize, or none.
for await (const batch of parseStream(chunks, { ...config, batchSize: 2 })) {
  const { rowOffset, done } = batch.meta;
  console.log(JSON.stringify(batch.data), 'rowOffset', rowOffset, 'done', done);
  for (const error of batch.errors) console.log(JSON.stringify(error));
}

// parseDetailed is synchronous: the same schema makes it throw.
try {
  parseDetailed(chunks.join(''), config);
} catch (error) {
  console.log(`${error.name}: ${error.message}`);
}
