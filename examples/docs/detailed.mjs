import { formatError, parseDetailed } from 'csvloom';

const text = 'id;name;qty\n1;Ada;3\n2;Grace\n3;"Linus;5\n';

// parseDetailed takes every option of parse, plus the features. Each is off unless asked for.
const result = parseDetailed(text, { detect: true, header: true, positions: true });
console.log(JSON.stringify(result.meta.delimiter), result.data.length, 'rows');
for (const error of result.errors) console.log(formatError(error));

// repair changes only what its rules name, and logs every change.
const repaired = parseDetailed(text, { detect: true, header: true, repair: true });
console.log(JSON.stringify(repaired.data));
console.log(JSON.stringify(repaired.repairs.map(({ rule, line }) => ({ rule, line }))));
console.log(repaired.errors.length, 'errors left');
