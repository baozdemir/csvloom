import { parseDetailed } from 'csvloom';

// A hand-written Standard Schema v1 object; a schema from any library that implements the
// specification is used the same way.
const person = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(row) {
      const issues = [];
      if (typeof row.name !== 'string')
        issues.push({ message: 'name is required', path: ['name'] });
      if (!Number.isInteger(row.age))
        issues.push({ message: 'age must be a whole number', path: ['age'] });
      return issues.length > 0 ? { issues } : { value: { name: row.name, age: row.age } };
    },
  },
};

const text = 'name,age\nAda,36\nGrace,x\n,41\nLinus,28\n';
// dynamicTyping runs first, so the validator sees 36 as a number and an empty field as null.
const result = parseDetailed(text, {
  header: true,
  dynamicTyping: true,
  skipEmptyLines: true,
  schema: person,
});

console.log(JSON.stringify(result.data));
// An invalid row leaves data and is kept whole in its error's value; row counts every row parsed.
for (const error of result.errors) console.log(JSON.stringify(error));
