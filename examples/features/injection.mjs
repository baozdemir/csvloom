import { parse, unparse } from 'csvloom';

const rows = [
  ['note', 'phone', 'change'],
  ['=1+1', '+90 555 123 45 67', '-5'],
  ['@handle', '-abc', '+1.5'],
  ['-', 'plain text', '-2e3'],
];

// The default: a value that starts with = + - @, a tab, CR, LF or a full-width ＝ ＋ － ＠ is
// written with ' before it and quoted, unless the whole value is a plain number.
const safe = unparse(rows);
console.log(JSON.stringify(safe));
// Opt out: the values as they are.
console.log(JSON.stringify(unparse(rows, { escapeFormulae: false })));
// Reading the escaped text back gives each rewritten value with its ' in front.
console.log(JSON.stringify(parse(safe).data));
// A RegExp is used as given, with no number exemption.
console.log(JSON.stringify(unparse([['-5', 'x']], { escapeFormulae: /^-/ })));
