import { parse, unparse } from 'csvloom';

const csv = 'name,city\nAda,"London, UK"\nGrace,New York';

// Rows as arrays, or as objects keyed by the header record.
console.log(JSON.stringify(parse(csv).data));
const { data, errors, meta } = parse(csv, { header: true });
console.log(JSON.stringify(data), errors.length, JSON.stringify(meta.fields));

// Back to CSV. A value that a spreadsheet would run as a formula is escaped by default.
// (The default newline is "\r\n"; "\n" keeps this output readable.)
console.log(unparse([{ name: 'Ada', note: '=1+1' }], { newline: '\n' }));
