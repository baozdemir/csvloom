// Deterministic CSV for the browser tests, shared by the probe page and test/browser/server.mjs:
// quoted fields with a comma, a doubled quote and a line break, two- and three-byte UTF-8 and
// CRLF between records. The text has at least `minLength` units, so at least as many UTF-8 bytes.
export function makeCsv(minLength) {
  const lines = ['id,name,note,value'];
  let length = lines[0].length;
  for (let i = 0; length < minLength; i++) {
    const line = `${i},name ${i},"café €${i}, ""q""\nline 2",${i % 1000}.5`;
    lines.push(line);
    length += line.length + 2;
  }
  return { text: lines.join('\r\n'), rows: lines.length - 1 };
}
