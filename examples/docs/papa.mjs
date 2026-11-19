import Papa from 'csvloom/papa'; // was: import Papa from 'papaparse';

const csv = 'sku;qty;price\r\nA-1;2;9.50\r\nB-7;;12\r\n';
const parsed = Papa.parse(csv, { header: true, dynamicTyping: true, skipEmptyLines: true });
console.log(JSON.stringify(parsed.data));
console.log(JSON.stringify(parsed.meta));

// Errors keep Papa's type, code, message and row.
console.log(JSON.stringify(Papa.parse('a,b\n1,2,3\n"x', { header: true }).errors));
console.log(JSON.stringify(Papa.unparse(parsed.data, { quotes: true, newline: '\n' })));
