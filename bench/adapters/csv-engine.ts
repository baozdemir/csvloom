import { parse } from '../../src/parse.ts';
import { candidateAdapter, type Adapter } from '../lanes.ts';

// The candidate from its TypeScript source (method v1). Method v2 loads the built
// bundle instead (bench/worker.ts, loadEntry); S1 runs on method v2 only.
export default { 'csv-engine': candidateAdapter(parse) } satisfies Record<string, Adapter>;
