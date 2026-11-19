import { detect, parse, parseDetailed } from 'csvloom';

// Two title lines above a ';' table whose amounts use a decimal comma.
const text = 'Sales report 2026\nRegion: north\nid;name;amount\n1;Ada;1,5\n2;Grace;2,25\n';

const found = detect(text);
console.log(
  JSON.stringify({
    delimiter: found.delimiter,
    newline: found.newline,
    header: found.header,
    preamble: found.preamble,
    preambleLines: found.preambleLines,
    start: found.start,
    columns: found.columns,
  }),
);

// detect: true parses the table detect found. The header guess is only reported: header is
// given here, as it must be.
const detailed = parseDetailed(text, { detect: true, header: true, skipEmptyLines: true });
console.log(JSON.stringify(detailed.data));
console.log(JSON.stringify(detailed.meta.detected?.preamble));

// What parse makes of the same text: the first title line becomes the header.
const plain = parse(text, { header: true, skipEmptyLines: true });
console.log(JSON.stringify(plain.meta.fields), plain.errors.length, 'errors');

// Bytes: the encoding is reported; nothing but UTF-8 is decoded.
console.log(JSON.stringify(detect(new Uint8Array([0xff, 0xfe, 0x61, 0x00])).encoding));
console.log(JSON.stringify(detect(new TextEncoder().encode('a;b\n1;2\n')).encoding));
