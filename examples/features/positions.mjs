import { formatError, parseDetailed } from 'csvloom';

// A BOM, one line to skip, a short record on line 4 and a quote that never closes on line 5.
const text = '\ufeffexported 2026-11-12\nid,name,city\n1,Ada,London\n2,Grace\n3,Linus,"Helsinki\n';
const result = parseDetailed(text, { header: true, skipFirstNLines: 1, positions: true });

for (const error of result.errors) {
  console.log(formatError(error));
  console.log(JSON.stringify(error));
}

// offset and line count the input as given: the BOM and the skipped line too. index and
// meta.cursor keep their meaning: they count from the text after the BOM and the skipped lines.
const quote = result.errors.find((error) => error.type === 'Quotes');
console.log('offset', quote?.offset, 'index', quote?.index, 'cursor', result.meta.cursor);

// offset and column are UTF-16 units. The UTF-8 byte offset of the same place:
const bytes = new TextEncoder().encode(text.slice(0, quote?.offset)).length;
console.log('UTF-8 byte offset', bytes);
