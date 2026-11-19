// The browser probes (test/browser/page/probes.js) and the worker example (examples/worker/) in
// Playwright's Chromium, Firefox and WebKit. Each test saves what it observed, with the browser's
// version, as JSON in its output directory.
import { writeFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

interface Probe {
  name: string;
  pass: boolean;
  observed?: unknown;
  error?: string;
}

interface WorkerSummary {
  done?: true;
  total?: number;
  errors?: number;
  error?: string;
  rows: number;
  first?: unknown;
  firstProgressAt?: number;
  finishedAt?: number;
}

function save(testInfo: TestInfo, name: string, value: object): void {
  const record = { project: testInfo.project.name, ...value };
  writeFileSync(testInfo.outputPath(name), JSON.stringify(record, null, 2) + '\n');
}

async function result(page: Page): Promise<unknown> {
  await page.waitForSelector('#out[data-done]', { state: 'attached' });
  return JSON.parse((await page.textContent('#out')) ?? 'null');
}

test('probes', async ({ page, browser, request }, testInfo) => {
  const response = await page.goto('/test/browser/page/probe.html?input');
  const csp = response?.headers()['content-security-policy'];
  const data = await request.get('/data.csv?size=1048576');
  const buffer = await data.body();
  await page.setInputFiles('#file', { name: 'input.csv', mimeType: 'text/csv', buffer });
  const probes = (await result(page)) as { pass: boolean; results: Probe[] };
  save(testInfo, 'probes.json', { browserVersion: browser.version(), csp, ...probes });
  expect(csp).toBe("script-src 'self'");
  expect(probes.results).toHaveLength(13);
  for (const probe of probes.results) expect.soft(probe, probe.name).toMatchObject({ pass: true });
});

for (const mode of ['count', 'batches']) {
  test(`worker example (${mode})`, async ({ page, browser, request }, testInfo) => {
    const data = await request.get('/data.csv?size=5242880');
    const expectedRows = Number(data.headers()['x-rows']);
    const buffer = await data.body();
    await page.goto('/examples/worker/index.html');
    await page.selectOption('#mode', mode);
    await page.setInputFiles('#file', { name: 'data.csv', mimeType: 'text/csv', buffer });
    const { firstProgressAt, finishedAt, ...summary } = (await result(page)) as WorkerSummary;
    // The ordering check (progress before the end), kept as a boolean only: no time is reported.
    const progressBeforeFinish =
      firstProgressAt !== undefined && finishedAt !== undefined && firstProgressAt < finishedAt;
    const record = { browserVersion: browser.version(), mode, fileBytes: buffer.length };
    save(testInfo, `worker-${mode}.json`, {
      ...record,
      expectedRows,
      ...summary,
      progressBeforeFinish,
    });
    expect(summary.error).toBeUndefined();
    expect(summary.total).toBe(expectedRows);
    expect(summary.rows).toBe(expectedRows);
    expect(summary.errors).toBe(0);
    expect(progressBeforeFinish).toBe(true);
    if (mode === 'batches') {
      const note = 'café €0, "q"\nline 2';
      expect(summary.first).toEqual({ id: '0', name: 'name 0', note, value: 0.5 });
    }
  });
}
