import { excel, excelSemicolon, parse, parseDetailed, unparse } from 'csvloom';

const rows = [
  ['name', 'city', 'amount'],
  ['Çağrı Işık', 'İstanbul', '1,5'],
  ['Zoë', 'Zürich', '=SUM(A1:A2)'],
];
// The BOM is shown as [BOM] here; the file holds the character U+FEFF.
const show = (csv) => JSON.stringify(csv.replace(/^\ufeff/, '[BOM]'));

// A reader whose list separator is ",": a BOM, CRLF, ",", formula escaping.
const comma = unparse(rows, excel);
console.log(show(comma));
// A reader whose list separator is ";" (where the decimal separator is a comma).
console.log(show(unparse(rows, excelSemicolon)));
// A "sep=" line names the delimiter in the file itself.
const withLine = unparse(rows, { sepLine: true, delimiter: ';' });
console.log(show(withLine));

// Reading them back: parse removes the BOM; parseDetailed with sepLine reads the line.
console.log(JSON.stringify(parse(comma).data));
const read = parseDetailed(withLine, { sepLine: true });
console.log(JSON.stringify(read.data), read.meta.delimiter, read.meta.sepLine);
