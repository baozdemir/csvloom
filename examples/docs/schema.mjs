import { parseDetailed } from 'csvloom';

// Any Standard Schema v1 object works here. This one is written by hand.
const schema = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate: (row) =>
      Number.isInteger(row.age)
        ? { value: row }
        : { issues: [{ message: 'age must be a whole number', path: ['age'] }] },
  },
};
const text = 'name,age\nAda,36\nGrace,x\n';
const config = { header: true, dynamicTyping: true, skipEmptyLines: true, schema };
const { data, errors } = parseDetailed(text, config);
console.log(JSON.stringify(data));
console.log(JSON.stringify(errors));
