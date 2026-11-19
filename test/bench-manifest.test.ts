import { describe, expect, it } from 'vitest';
import { ADAPTER_IDS, loadAdapter } from '../bench/adapters/index.ts';
import { expectedColdImpls, expectedPairs, readManifest } from '../bench/manifest.ts';
import { validateCampaign } from '../bench/report.ts';

// Expectations on the v1 campaign manifest itself.

const manifest = readManifest();
const candidatePairs = expectedPairs(manifest).filter((p) => p.impl === manifest.candidate);

describe('candidate coverage', () => {
  it('requires the candidate on every B1 real-dataset case, which stays unscored', () => {
    const external = manifest.cases.filter((c) => c.external);
    expect(external.map((c) => c.id).sort()).toStrictEqual([
      'B1-ext-geonames-cities1000',
      'B1-ext-nga-text-entries',
      'B1-ext-tate-artwork',
    ]);
    for (const c of external) {
      expect(c).toMatchObject({ lane: 'B1', class: 'additional', weight: 0 });
      expect(candidatePairs.find((p) => p.case === c.id)).toMatchObject({ expect: 'measure' });
    }
  });

  it('defers candidate S1 explicitly by lane, with the reason, instead of dropping additional cases', () => {
    const s1 = manifest.cases.filter((c) => c.lane === 'S1');
    expect(s1).toHaveLength(6);
    for (const c of s1) {
      expect(candidatePairs.find((p) => p.case === c.id)).toMatchObject({
        expect: 'deferred',
        reason: expect.stringContaining('method v2') as unknown,
      });
    }
  });

  it('requires the candidate on all primary and regression cases', () => {
    const scored = manifest.cases.filter((c) => c.class !== 'additional').map((c) => c.id);
    expect(scored).toHaveLength(40);
    for (const id of scored)
      expect(candidatePairs.find((p) => p.case === id)).toMatchObject({ expect: 'measure' });
  });

  it('includes the candidate in the cold-start comparison', () => {
    expect(expectedColdImpls(manifest)).toContain(manifest.candidate);
    expect(manifest.cases.map((c) => c.id)).toContain(manifest.campaign.coldStartCase);
  });
});

describe('the external datasets', () => {
  it('has no OWID case, and the pinned Tate CC0 file in shard S3', () => {
    expect(manifest.cases.some((c) => c.id.includes('owid'))).toBe(false);
    const tate = manifest.cases.find((c) => c.id === 'B1-ext-tate-artwork');
    expect(tate?.external).toMatchObject({
      sha256: '3fb68c02725846b540a86fa9629de8b0a6902659378e853af0691bc5ff74f09d',
      bytes: 24353266,
      dialect: { delimiter: ',', quote: '"', newline: '\r\n' },
    });
    expect(
      tate?.external && 'source' in tate.external ? String(tate.external.source) : '',
    ).toContain('e7936a63d954d5b17628c59990531d723d2da010');
    expect(manifest.campaign.shards.find((s) => s.cases.includes('B1-ext-tate-artwork'))?.id).toBe(
      'S3',
    );
  });
});

describe('campaign design', () => {
  it('keeps the four-shard, 30-minute and 120-minute caps and places every case exactly once', () => {
    expect(manifest.campaign.shards.length).toBeLessThanOrEqual(4);
    expect(manifest.campaign).toMatchObject({ maxShardMinutes: 30, maxCampaignMinutes: 120 });
    expect(
      validateCampaign(manifest, '', []).issues.filter((i) => i.startsWith('manifest:')),
    ).toStrictEqual([]);
  });

  it('declares lanes that match the actual adapters', async () => {
    for (const spec of manifest.implementations) {
      expect(ADAPTER_IDS).toContain(spec.id);
      const adapter = await loadAdapter(spec.id);
      const lanes = (['B1', 'B2', 'S1'] as const).filter((lane) => adapter[lane]);
      expect([spec.id, lanes]).toStrictEqual([spec.id, spec.lanes]);
    }
  });
});
