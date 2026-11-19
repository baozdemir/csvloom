import { configDefaults, defineConfig } from 'vitest/config';

// work/ holds the harness's run directories, which can hold whole copies of the tree (the A/B
// tool's builds, the checkout copies of a run); their test files are not this tree's tests.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'work/**'] } });
