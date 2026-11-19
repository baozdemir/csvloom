import { parseDetailed } from 'csvloom';

// CRLF and LF mixed, a short record, empty extra fields, and a quote that never closes.
const text = 'id,name,city\r\n1,Ada\r\n2,Grace,New York,,\r\n3,Linus,Helsinki\n4,"Alan,Wilmslow\n';
const result = parseDetailed(text, { header: true, repair: true });

console.log(JSON.stringify(result.data));
console.log(JSON.stringify(result.errors));
// The log is the feature: every change, where it was, what it was and what it became.
for (const entry of result.repairs ?? []) {
  const { rule, row, line, column, before, after } = entry;
  console.log(JSON.stringify({ rule, row, line, column, before, after }));
}
console.log(JSON.stringify(result.repairCounts));

// The width comes from the header record. A header with one delimiter too many pads every record.
const broken = parseDetailed('id,name,\n1,Ada\n2,Grace\n', { header: true, repair: true });
console.log(JSON.stringify(broken.meta.fields), JSON.stringify(broken.data));
console.log(JSON.stringify(broken.repairCounts));
