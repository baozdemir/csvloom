import { excel, unparse } from 'csvloom';

const rows = [
  ['name', 'total'],
  ['Zoë', '=SUM(B2:B9)'],
];
// The excel preset writes a BOM, "\r\n" and ",". The formula is escaped, as by default.
const csv = unparse(rows, excel);
console.log(csv.startsWith('\uFEFF'), JSON.stringify(csv.slice(1)));
