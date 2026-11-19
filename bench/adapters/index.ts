import type { Adapter } from '../lanes.ts';

type Variants = Record<string, Adapter>;

// Lazy loaders so each worker process imports only the library it measures.
const MODULES: Record<string, () => Promise<{ default: Variants }>> = {
  papaparse: () => import('./papaparse.ts'),
  'papaparse-fastmode': () => import('./papaparse.ts'),
  'csv-parse': () => import('./csv-parse.ts'),
  'csv-parser': () => import('./csv-parser.ts'),
  'fast-csv': () => import('./fast-csv.ts'),
  'd3-dsv': () => import('./d3-dsv.ts'),
  udsv: () => import('./udsv.ts'),
  'csv-simple-parser': () => import('./csv-simple-parser.ts'),
  'csv-rex': () => import('./csv-rex.ts'),
  'csv-pipe': () => import('./csv-pipe.ts'),
  'amigo-labs-csv': () => import('./amigo-labs-csv.ts'),
  'but-csv': () => import('./but-csv.ts'),
  tiddlycsv: () => import('./tiddlycsv.ts'),
  'web-csv-toolbox': () => import('./web-csv-toolbox.js'),
  'csv-stringify': () => import('./csv-stringify.ts'),
  'fast-csv-format': () => import('./fast-csv-format.ts'),
  'csv-engine': () => import('./csv-engine.ts'),
};

export const ADAPTER_IDS = Object.keys(MODULES);

export async function loadAdapter(id: string): Promise<Adapter> {
  const load = MODULES[id];
  const adapter = load && (await load()).default[id];
  if (!adapter) throw new Error(`Unknown adapter: ${id}`);
  return adapter;
}
