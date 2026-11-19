// The U1 page (test/browser/page/u1.html) in Playwright's Chromium, Firefox and WebKit:
// correctness only, no timing. Each arm parses the same 5 MiB file and must give the
// row count and checksum of bulk `parse` of the same text in Node. The page also measures times;
// they are neither saved nor asserted here.
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from '../../src/index.ts';
import { tally } from './page/u1-tally.ts';

const ARMS = ['stream-worker', 'stream-main', 'bulk-main', 'papa-worker', 'papa-main'];

interface PageResult {
  rows?: number;
  sum?: number;
  error?: string;
}

for (const arm of ARMS) {
  test(`U1 ${arm}`, async ({ page, browser, request }, testInfo) => {
    const data = await request.get('/data.csv?size=5242880');
    const buffer = await data.body();
    const generatorRows = Number(data.headers()['x-rows']);
    const reference = { rows: 0, sum: 0 };
    tally(reference, parse(new TextDecoder().decode(buffer), { header: true }).data);

    await page.goto(`/test/browser/page/u1.html?arm=${arm}`);
    await page.setInputFiles('#file', { name: 'u1.csv', mimeType: 'text/csv', buffer });
    await page.waitForSelector('#out[data-done]', { state: 'attached' });
    const { rows, sum, error } = JSON.parse((await page.textContent('#out')) ?? '{}') as PageResult;

    const record = {
      project: testInfo.project.name,
      browserVersion: browser.version(),
      arm,
      fileBytes: buffer.length,
      generatorRows,
      reference,
      result: { rows, sum, error },
    };
    writeFileSync(testInfo.outputPath('u1.json'), JSON.stringify(record, null, 2) + '\n');
    expect(reference.rows).toBe(generatorRows);
    expect(error).toBeUndefined();
    expect({ rows, sum }).toEqual(reference);
  });
}
