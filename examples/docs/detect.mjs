import { parseDetailed } from 'csvloom';

// A title line above a table separated by ';'. Nothing about the dialect is given.
const text = 'Sales report 2026\nid;name;amount\n1;Ada;1,5\n2;Grace;2,25\n';
const { data, meta } = parseDetailed(text, { detect: true, header: true, skipEmptyLines: true });
console.log(JSON.stringify(meta.delimiter), JSON.stringify(meta.detected?.preamble));
console.log(JSON.stringify(data));
