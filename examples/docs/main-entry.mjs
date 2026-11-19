import { parse, unparse } from 'csvloom';
import Papa from 'csvloom/papa';

const attempt = (run) => {
  try {
    return JSON.stringify(run());
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

// A misspelled option: csvloom/papa ignores it, as Papa does. The main entry names it.
console.log(attempt(() => Papa.parse('a;b', { delimeter: ';' }).data));
console.log(attempt(() => parse('a;b', { delimeter: ';' }).data));

// A value outside an option's type: csvloom/papa reads it as Papa does. The main entry throws.
console.log(attempt(() => Papa.parse('a\n\nb', { skipEmptyLines: 'yes' }).data));
console.log(attempt(() => parse('a\n\nb', { skipEmptyLines: 'yes' }).data));

// Formula escaping in unparse: off by default in csvloom/papa, on in the main entry.
console.log(attempt(() => Papa.unparse([['=1+1', '-5', 'x']])));
console.log(attempt(() => unparse([['=1+1', '-5', 'x']])));
console.log(attempt(() => unparse([['=1+1', '-5', 'x']], { escapeFormulae: false })));
