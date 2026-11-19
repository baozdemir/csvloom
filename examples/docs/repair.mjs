import { parseDetailed } from 'csvloom';

// A short record, and a quote that never closes.
const text = 'id,name,city\n1,Ada\n2,"Grace,New York\n';
const { data, errors, repairs } = parseDetailed(text, { header: true, repair: true });
console.log(JSON.stringify(data), errors.length, 'errors');
for (const { rule, line } of repairs) console.log(rule, 'on line', line);
