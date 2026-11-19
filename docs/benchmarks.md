# Benchmarks

## Published numbers (Node 26)

These are csvloom's published speed numbers: one campaign in three lanes, B (`parse`), W1
(`unparse`) and S1 (`parseStream`), run on 2026-11-18 under the method below. Each lane is read on
its own. There is no figure across lanes, and none of them claims that csvloom is the fastest.
"How the harness measures", after this section, describes the harness the numbers come from.

### Method

- **Method:** `--method pub`, that is `bench/manifest-pub.json` over `bench/manifest-v2.json` and
  `bench/manifest.json`, as "How the harness measures" below describes it.
  - The published campaign ran with these manifests' values; their descriptive text was edited for
    the release, which changes their hashes.
  - Node 26.13.1 (V8 14.6.202.34-node.40) at V8's default settings. Every process starts with
    `--expose-gc` and the round's `--random-seed` and `--hash-seed`, and with no other Node flag.
  - papaparse 5.7.1.
- **Machine:** three Google Cloud c3-standard-8 VMs (Intel Xeon Platinum 8481C @ 2.70GHz, kernel
  6.1.0-55-cloud-amd64), one VM per lane.
  - Workers are pinned with `taskset` to CPU 2 and the runner runs on CPU 3. CPU 2's sibling,
    CPU 6, reads 0.02% busy in every lane shard.
  - Steal is 0.00% in every shard, and no report has a placement flag.
- **Statistics:** 20 fresh processes per implementation and case; each process gives the median of
  its samples. Intervals are 95% percentile bootstrap intervals, from 10,000 resamples of rounds.
- **Ratios:** a speed ratio is competitor time / csvloom time, so above 1 means csvloom is faster.
- **Classification, as each report states it:** "A case is ahead (behind) when its ratio differs
  from 1 after Holm correction over the 24 primary cases at 5% and its whole interval lies above
  (below) the A/A interval of the same case; otherwise it is inconclusive. The fastest competitor
  is chosen once, from the medians."
  - W1's report says "over the 24 W1 cases", and S1's "over the 12 S1 cases".
  - The A/A arm, `csv-engine-aa`, is the candidate bundle in another directory.
- **Calibrations:** one per VM, under this method, before its lane: the A/A of the 24 primary
  cases. A lane ran only after its calibration read PASS. Their noise checks:
  - before B: "1 of 24 intervals exclude 1.000 (at most 3: B1-simple-32MiB); largest half-width
    1.62% (limit 2.50%); median half-width 0.64% (limit 1.50%): PASS."
  - before W1: "0 of 24 intervals exclude 1.000 (at most 3); largest half-width 2.04% (limit
    2.50%); median half-width 0.70% (limit 1.50%): PASS."
  - before S1: "0 of 24 intervals exclude 1.000 (at most 3); largest half-width 1.27% (limit
    2.50%); median half-width 0.39% (limit 1.50%): PASS."
- **Code:** release 0.1.0's code.
- **Dates:** 2026-11-18. The calibrations started at 06:33 UTC. The lanes ended at 11:23 (S1),
  13:44 (W1) and 16:46 UTC (B).
- **Regimes:** every report reads "Rows where csv-engine and a compared side were timed
  differently: none."
- **Names:** the harness calls csvloom by its implementation id, `csv-engine`, and "candidate" in
  its column headings.

### Lane B: `parse` of a string (B1 arrays, B2 header-keyed objects)

- **Report:** COMPLETE.
- **Totals and overall lines, verbatim:**
  - "Ahead 15, behind 5, inconclusive 4 of 24 primary cases."
  - "Overall against the fastest valid competitor (geometric mean, 95% interval): 1.142 [1.139,
    1.145]; B1 1.130 [1.126, 1.133]; B2 1.154 [1.151, 1.159]."
  - "Overall against papaparse: 2.596 [2.590, 2.605]."
- **The 24 primary cases**, behind first, then inconclusive, then ahead, as the report orders
  them. The papaparse column is papaparse time / csvloom time.

| case                 | fastest valid competitor | ratio [95%]          | A/A [95%]            | class        | papaparse ratio [95%] |
| -------------------- | ------------------------ | -------------------- | -------------------- | ------------ | --------------------- |
| B2-long-field-32MiB  | amigo-labs-csv           | 0.879 [0.866, 0.885] | 0.990 [0.973, 1.009] | behind       | 2.438 [2.402, 2.454]  |
| B2-simple-32MiB      | udsv                     | 0.910 [0.890, 0.920] | 1.008 [0.981, 1.023] | behind       | 1.791 [1.760, 1.805]  |
| B1-long-field-32MiB  | amigo-labs-csv           | 0.936 [0.933, 0.939] | 1.000 [0.994, 1.004] | behind       | 2.638 [2.629, 2.656]  |
| B2-unicode-32MiB     | udsv                     | 0.967 [0.962, 0.974] | 0.997 [0.991, 1.008] | behind       | 1.666 [1.655, 1.678]  |
| B1-unicode-32MiB     | udsv                     | 0.970 [0.964, 0.988] | 1.002 [0.998, 1.009] | behind       | 1.229 [1.224, 1.238]  |
| B1-wide-32MiB        | udsv                     | 0.996 [0.990, 1.002] | 1.001 [0.993, 1.006] | inconclusive | 1.101 [1.095, 1.108]  |
| B2-simple-1MiB       | csv-simple-parser        | 1.001 [0.992, 1.004] | 1.009 [0.998, 1.013] | inconclusive | 3.880 [3.850, 3.949]  |
| B2-multiline-32MiB   | udsv                     | 1.008 [1.004, 1.014] | 1.005 [0.998, 1.012] | inconclusive | 1.524 [1.494, 1.541]  |
| B1-simple-32MiB      | udsv                     | 1.036 [1.000, 1.049] | 1.008 [0.980, 1.013] | inconclusive | 1.226 [1.198, 1.235]  |
| B2-unicode-1MiB      | udsv                     | 1.033 [1.029, 1.056] | 1.003 [0.997, 1.009] | ahead        | 3.909 [3.856, 3.937]  |
| B1-multiline-32MiB   | udsv                     | 1.080 [1.066, 1.107] | 0.998 [0.993, 1.006] | ahead        | 1.237 [1.232, 1.246]  |
| B1-unicode-1MiB      | csv-pipe                 | 1.082 [1.072, 1.085] | 0.999 [0.997, 1.002] | ahead        | 3.560 [3.527, 3.577]  |
| B2-multiline-1MiB    | udsv                     | 1.085 [1.079, 1.093] | 0.991 [0.985, 1.008] | ahead        | 4.438 [4.390, 4.518]  |
| B1-wide-1MiB         | csv-simple-parser        | 1.089 [1.085, 1.095] | 1.000 [0.996, 1.004] | ahead        | 2.966 [2.945, 2.985]  |
| B1-quote-heavy-32MiB | tiddlycsv                | 1.093 [1.088, 1.095] | 1.004 [0.998, 1.008] | ahead        | 1.314 [1.304, 1.392]  |
| B2-quote-heavy-32MiB | udsv                     | 1.159 [1.153, 1.165] | 1.004 [0.997, 1.008] | ahead        | 1.741 [1.716, 1.779]  |
| B1-simple-1MiB       | csv-simple-parser        | 1.179 [1.173, 1.184] | 0.997 [0.993, 1.003] | ahead        | 2.507 [2.492, 2.533]  |
| B2-quote-heavy-1MiB  | udsv                     | 1.219 [1.212, 1.224] | 1.005 [0.995, 1.018] | ahead        | 4.551 [4.521, 4.604]  |
| B1-multiline-1MiB    | csv-simple-parser        | 1.275 [1.269, 1.280] | 1.001 [0.997, 1.005] | ahead        | 3.616 [3.588, 3.640]  |
| B2-wide-1MiB         | csv-pipe                 | 1.364 [1.339, 1.407] | 1.000 [0.999, 1.002] | ahead        | 3.738 [3.732, 3.826]  |
| B1-quote-heavy-1MiB  | csv-pipe                 | 1.474 [1.464, 1.485] | 1.005 [0.994, 1.014] | ahead        | 4.554 [4.499, 4.574]  |
| B1-long-field-1MiB   | tiddlycsv                | 1.505 [1.500, 1.511] | 0.998 [0.994, 1.002] | ahead        | 7.227 [7.062, 7.350]  |
| B2-wide-32MiB        | csv-pipe                 | 1.728 [1.724, 1.739] | 0.998 [0.996, 1.001] | ahead        | 2.362 [2.348, 2.371]  |
| B2-long-field-1MiB   | csv-simple-parser        | 1.923 [1.914, 1.933] | 1.003 [0.997, 1.008] | ahead        | 7.530 [7.476, 7.619]  |

- **Memory**, as the report gives it: "single parse, output retained; median of the memory
  processes". The peak counter is `linux-proc-self-status-VmHWM`, and the empty process (harness
  loaded, no parser, no input) reads RSS 95.9 MiB, peak 96.0 MiB. A ratio here is csvloom's peak /
  the other side's, so below 1 means csvloom peaks lower.
  - "Reported check against papaparse (a fact, not a gate): worst peak ratio 1.021 (limit 1.10:
    within)."

| case                 | candidate peak MiB | candidate RSS before parse MiB | papaparse peak MiB | candidate / papaparse | lowest-peak competitor | its peak MiB | candidate / lowest |
| -------------------- | ------------------ | ------------------------------ | ------------------ | --------------------- | ---------------------- | ------------ | ------------------ |
| B1-simple-1MiB       | 108.2              | 98.6                           | 106.0              | 1.021                 | papaparse              | 106.0        | 1.021              |
| B1-simple-32MiB      | 356.7              | 128.3                          | 397.2              | 0.898                 | udsv                   | 357.2        | 0.998              |
| B1-quote-heavy-1MiB  | 103.7              | 96.9                           | 104.9              | 0.989                 | csv-parse              | 101.7        | 1.019              |
| B1-quote-heavy-32MiB | 283.9              | 128.5                          | 333.5              | 0.851                 | udsv                   | 305.2        | 0.930              |
| B1-multiline-1MiB    | 100.4              | 96.0                           | 103.3              | 0.973                 | udsv                   | 102.5        | 0.980              |
| B1-multiline-32MiB   | 287.9              | 128.5                          | 319.4              | 0.902                 | udsv                   | 292.0        | 0.986              |
| B1-wide-1MiB         | 105.3              | 97.8                           | 103.9              | 1.013                 | papaparse-fastmode     | 103.9        | 1.014              |
| B1-wide-32MiB        | 348.0              | 128.4                          | 347.5              | 1.001                 | papaparse-fastmode     | 347.5        | 1.002              |
| B1-unicode-1MiB      | 104.9              | 100.3                          | 105.5              | 0.994                 | udsv                   | 103.1        | 1.017              |
| B1-unicode-32MiB     | 298.1              | 138.8                          | 308.1              | 0.968                 | csv-simple-parser      | 295.8        | 1.008              |
| B1-long-field-1MiB   | 98.1               | 97.1                           | 98.6               | 0.995                 | amigo-labs-csv         | 97.8         | 1.003              |
| B1-long-field-32MiB  | 209.2              | 129.1                          | 254.0              | 0.823                 | csv-parse              | 207.9        | 1.006              |
| B2-simple-1MiB       | 107.6              | 97.8                           | 108.9              | 0.988                 | csv-rex                | 106.0        | 1.015              |
| B2-simple-32MiB      | 359.0              | 128.4                          | 471.4              | 0.762                 | d3-dsv                 | 346.0        | 1.038              |
| B2-quote-heavy-1MiB  | 104.2              | 96.9                           | 107.7              | 0.967                 | csv-parser             | 102.5        | 1.016              |
| B2-quote-heavy-32MiB | 285.4              | 129.0                          | 363.7              | 0.785                 | udsv                   | 300.5        | 0.950              |
| B2-multiline-1MiB    | 103.2              | 96.1                           | 107.1              | 0.964                 | d3-dsv                 | 102.6        | 1.005              |
| B2-multiline-32MiB   | 288.3              | 128.8                          | 360.9              | 0.799                 | udsv                   | 280.8        | 1.026              |
| B2-wide-1MiB         | 106.4              | 96.1                           | 124.1              | 0.857                 | csv-parse              | 116.6        | 0.912              |
| B2-wide-32MiB        | 347.0              | 128.3                          | 673.9              | 0.515                 | csv-parse              | 398.9        | 0.870              |
| B2-unicode-1MiB      | 105.1              | 99.4                           | 108.4              | 0.970                 | udsv                   | 104.0        | 1.010              |
| B2-unicode-32MiB     | 296.4              | 138.2                          | 352.3              | 0.841                 | udsv                   | 292.4        | 1.014              |
| B2-long-field-1MiB   | 98.0               | 98.0                           | 99.1               | 0.989                 | csv-parser             | 96.6         | 1.015              |
| B2-long-field-32MiB  | 193.9              | 128.9                          | 257.4              | 0.753                 | csv-pipe               | 182.8        | 1.060              |

- **Small inputs** (1 KiB and 64 KiB), as the report gives them: papaparse time / csvloom time,
  so above 1 means csvloom is faster.
  - "Reported check (a fact, not a gate): worst candidate / papaparse time ratio 0.299 (limit
    1.10: within)."

| case                 | ratio [95%]          |
| -------------------- | -------------------- |
| B1-simple-1KiB       | 4.066 [4.026, 4.102] |
| B1-simple-64KiB      | 3.470 [3.449, 3.589] |
| B1-quote-heavy-1KiB  | 5.211 [5.178, 5.226] |
| B1-quote-heavy-64KiB | 5.529 [5.448, 5.620] |
| B1-multiline-1KiB    | 4.788 [4.715, 4.822] |
| B1-multiline-64KiB   | 4.930 [4.823, 5.006] |
| B1-unicode-1KiB      | 3.853 [3.802, 3.883] |
| B1-unicode-64KiB     | 3.392 [3.365, 3.421] |
| B2-simple-1KiB       | 3.637 [3.611, 3.658] |
| B2-simple-64KiB      | 3.680 [3.614, 3.727] |
| B2-quote-heavy-1KiB  | 3.952 [3.925, 3.981] |
| B2-quote-heavy-64KiB | 4.614 [4.563, 4.663] |
| B2-multiline-1KiB    | 4.129 [4.041, 4.241] |
| B2-multiline-64KiB   | 4.723 [4.675, 4.770] |
| B2-unicode-1KiB      | 3.354 [3.303, 3.410] |
| B2-unicode-64KiB     | 3.347 [3.319, 3.366] |

### Lane W1: `unparse`

- **Report:** COMPLETE.
- **What is timed,** from the report:
  - each implementation writes the case's rows (header row first) or records (header as column
    order) to one CSV string;
  - every output is read back by papaparse before timing and must equal the fixture cell for
    cell;
  - csvloom calls `unparse` with `escapeFormulae: false`, so it does the same work as the other
    writers (the main entry's default is on);
  - W1 has no threshold: it is reported only, and never combined with B1/B2 or S1.
- **Totals, verbatim:** "Ahead 11, behind 8, inconclusive 5 of 24 W1 cases." The report has no
  overall line.
- **The 24 W1 cases**, behind first, as the report orders them. The papaparse column is papaparse
  time / csvloom time; it has no class. On W1-records-quote-heavy-32MiB and
  W1-rows-quote-heavy-32MiB the fastest valid competitor is papaparse itself.

| case                         | fastest valid competitor | ratio [95%]          | A/A [95%]            | class        | papaparse ratio [95%] |
| ---------------------------- | ------------------------ | -------------------- | -------------------- | ------------ | --------------------- |
| W1-rows-long-field-1MiB      | amigo-labs-csv           | 0.577 [0.571, 0.585] | 0.997 [0.986, 1.012] | behind       | 1.034 [1.022, 1.045]  |
| W1-records-long-field-1MiB   | amigo-labs-csv           | 0.581 [0.574, 0.585] | 0.997 [0.987, 1.003] | behind       | 1.035 [1.024, 1.041]  |
| W1-rows-long-field-32MiB     | amigo-labs-csv           | 0.693 [0.668, 0.706] | 0.994 [0.981, 1.006] | behind       | 1.001 [0.989, 1.015]  |
| W1-records-long-field-32MiB  | amigo-labs-csv           | 0.703 [0.691, 0.717] | 1.003 [0.994, 1.012] | behind       | 1.006 [0.996, 1.017]  |
| W1-records-wide-1MiB         | d3-dsv                   | 0.807 [0.793, 0.815] | 1.001 [0.982, 1.011] | behind       | 2.047 [2.008, 2.074]  |
| W1-rows-wide-1MiB            | tiddlycsv                | 0.902 [0.897, 0.908] | 0.994 [0.985, 0.999] | behind       | 2.821 [2.805, 2.845]  |
| W1-rows-wide-32MiB           | tiddlycsv                | 0.945 [0.920, 0.972] | 1.006 [0.997, 1.020] | behind       | 3.407 [3.386, 3.451]  |
| W1-rows-unicode-1MiB         | tiddlycsv                | 0.973 [0.963, 0.978] | 0.994 [0.984, 1.006] | behind       | 2.012 [1.985, 2.021]  |
| W1-records-wide-32MiB        | d3-dsv                   | 0.989 [0.976, 0.995] | 1.000 [0.982, 1.009] | inconclusive | 2.650 [2.617, 2.669]  |
| W1-records-unicode-1MiB      | csv-pipe                 | 0.994 [0.982, 1.006] | 1.005 [0.985, 1.018] | inconclusive | 2.211 [2.189, 2.234]  |
| W1-records-unicode-32MiB     | d3-dsv                   | 1.010 [0.980, 1.029] | 0.987 [0.961, 1.024] | inconclusive | 2.584 [2.519, 2.646]  |
| W1-rows-simple-32MiB         | tiddlycsv                | 1.039 [1.009, 1.074] | 0.995 [0.953, 1.023] | inconclusive | 2.941 [2.881, 3.024]  |
| W1-rows-unicode-32MiB        | tiddlycsv                | 1.043 [0.994, 1.112] | 1.020 [0.951, 1.091] | inconclusive | 2.559 [2.485, 2.723]  |
| W1-records-multiline-1MiB    | csv-pipe                 | 1.041 [1.036, 1.045] | 0.998 [0.995, 1.004] | ahead        | 1.679 [1.671, 1.692]  |
| W1-rows-simple-1MiB          | tiddlycsv                | 1.074 [1.068, 1.080] | 0.995 [0.990, 1.003] | ahead        | 2.425 [2.409, 2.445]  |
| W1-records-simple-32MiB      | d3-dsv                   | 1.108 [1.097, 1.115] | 0.998 [0.996, 1.002] | ahead        | 2.965 [2.938, 2.985]  |
| W1-records-simple-1MiB       | d3-dsv                   | 1.114 [1.110, 1.124] | 0.999 [0.994, 1.006] | ahead        | 2.310 [2.304, 2.343]  |
| W1-records-quote-heavy-1MiB  | csv-pipe                 | 1.117 [1.109, 1.127] | 1.001 [0.994, 1.008] | ahead        | 1.435 [1.427, 1.446]  |
| W1-rows-multiline-1MiB       | tiddlycsv                | 1.121 [1.114, 1.128] | 1.002 [0.993, 1.007] | ahead        | 1.658 [1.647, 1.666]  |
| W1-rows-multiline-32MiB      | tiddlycsv                | 1.128 [1.057, 1.202] | 0.981 [0.952, 1.046] | ahead        | 2.287 [2.182, 2.387]  |
| W1-records-multiline-32MiB   | d3-dsv                   | 1.153 [1.100, 1.227] | 0.983 [0.901, 1.070] | ahead        | 2.156 [2.075, 2.251]  |
| W1-rows-quote-heavy-1MiB     | csv-rex                  | 1.218 [1.203, 1.233] | 0.996 [0.993, 1.003] | ahead        | 1.530 [1.523, 1.544]  |
| W1-records-quote-heavy-32MiB | papaparse                | 2.092 [2.038, 2.201] | 0.976 [0.924, 1.060] | ahead        | 2.092 [2.038, 2.201]  |
| W1-rows-quote-heavy-32MiB    | papaparse                | 2.123 [2.046, 2.326] | 0.934 [0.909, 1.072] | ahead        | 2.123 [2.046, 2.326]  |

- **Memory**, as the report gives it: "single write, input and output held; median of the memory
  processes". The peak counter is `linux-proc-self-status-VmHWM`, and the empty process reads RSS
  95.8 MiB, peak 96.0 MiB. The input was parsed in the same process before the write. A ratio here
  is csvloom's peak / the other side's. The W1 report states no check line for memory.

| case                         | candidate peak MiB | candidate RSS before write MiB | papaparse peak MiB | candidate / papaparse | lowest-peak competitor | its peak MiB | candidate / lowest |
| ---------------------------- | ------------------ | ------------------------------ | ------------------ | --------------------- | ---------------------- | ------------ | ------------------ |
| W1-rows-simple-1MiB          | 112.8              | 106.7                          | 126.1              | 0.894                 | but-csv                | 110.4        | 1.021              |
| W1-rows-simple-32MiB         | 432.3              | 360.8                          | 654.6              | 0.660                 | d3-dsv                 | 438.6        | 0.986              |
| W1-rows-quote-heavy-1MiB     | 114.1              | 105.6                          | 115.4              | 0.989                 | papaparse              | 115.4        | 0.989              |
| W1-rows-quote-heavy-32MiB    | 407.2              | 307.1                          | 562.7              | 0.724                 | fast-csv-format        | 517.4        | 0.787              |
| W1-rows-multiline-1MiB       | 108.7              | 102.6                          | 110.6              | 0.983                 | tiddlycsv              | 107.0        | 1.016              |
| W1-rows-multiline-32MiB      | 404.8              | 317.4                          | 515.2              | 0.786                 | but-csv                | 406.9        | 0.995              |
| W1-rows-wide-1MiB            | 115.3              | 107.8                          | 125.3              | 0.920                 | but-csv                | 109.7        | 1.050              |
| W1-rows-wide-32MiB           | 432.2              | 351.8                          | 759.7              | 0.569                 | d3-dsv                 | 428.7        | 1.008              |
| W1-rows-unicode-1MiB         | 115.0              | 106.2                          | 116.5              | 0.987                 | amigo-labs-csv         | 112.2        | 1.025              |
| W1-rows-unicode-32MiB        | 414.4              | 309.3                          | 536.5              | 0.772                 | tiddlycsv              | 409.4        | 1.012              |
| W1-rows-long-field-1MiB      | 104.4              | 100.0                          | 106.5              | 0.980                 | csv-rex                | 104.4        | 0.999              |
| W1-rows-long-field-32MiB     | 353.8              | 251.2                          | 355.3              | 0.996                 | but-csv                | 354.2        | 0.999              |
| W1-records-simple-1MiB       | 117.1              | 109.1                          | 120.3              | 0.974                 | d3-dsv                 | 115.4        | 1.015              |
| W1-records-simple-32MiB      | 491.2              | 443.8                          | 673.5              | 0.729                 | d3-dsv                 | 480.8        | 1.022              |
| W1-records-quote-heavy-1MiB  | 113.5              | 107.9                          | 115.5              | 0.983                 | papaparse              | 115.5        | 0.983              |
| W1-records-quote-heavy-32MiB | 425.1              | 337.1                          | 554.4              | 0.767                 | fast-csv-format        | 509.8        | 0.834              |
| W1-records-multiline-1MiB    | 111.8              | 105.8                          | 111.4              | 1.003                 | d3-dsv                 | 110.2        | 1.014              |
| W1-records-multiline-32MiB   | 423.1              | 354.0                          | 493.9              | 0.857                 | d3-dsv                 | 398.2        | 1.063              |
| W1-records-wide-1MiB         | 132.9              | 124.6                          | 132.8              | 1.001                 | d3-dsv                 | 127.9        | 1.039              |
| W1-records-wide-32MiB        | 712.4              | 677.3                          | 1026.6             | 0.694                 | d3-dsv                 | 711.9        | 1.001              |
| W1-records-unicode-1MiB      | 117.2              | 110.1                          | 114.6              | 1.023                 | csv-pipe               | 112.7        | 1.040              |
| W1-records-unicode-32MiB     | 439.1              | 337.5                          | 524.2              | 0.838                 | d3-dsv                 | 404.9        | 1.084              |
| W1-records-long-field-1MiB   | 105.7              | 101.3                          | 106.2              | 0.996                 | csv-pipe               | 103.2        | 1.024              |
| W1-records-long-field-32MiB  | 353.0              | 250.4                          | 354.9              | 0.995                 | d3-dsv                 | 354.8        | 0.995              |

- **Small inputs:** the W1 report has no small-input section.

### Lane S1: `parseStream`

- **Report:** COMPLETE.
- **What is timed,** from the report:
  - each implementation reads the case's fixture as UTF-8 byte chunks of 65536 bytes from an
    in-memory async iterable;
  - it hands each header-keyed record to a consumer that keeps nothing;
  - csvloom is the bundle's `parseStream` with `batchSize` 1024;
  - "S1 has no overall mean and is never combined with B1/B2 or W1."
- **Totals, verbatim:** "Ahead 7, behind 5, inconclusive 0 of 12 S1 cases." The report has no
  overall line.
- **The 12 S1 cases**, behind first, as the report orders them. The papaparse column is papaparse
  time / csvloom time; it has no class. On S1-quote-heavy-32MiB udsv's check failed, so that row's
  fastest valid competitor is csv-pipe.

| case                 | fastest valid competitor | ratio [95%]          | A/A [95%]            | class  | papaparse ratio [95%] |
| -------------------- | ------------------------ | -------------------- | -------------------- | ------ | --------------------- |
| S1-multiline-32MiB   | udsv                     | 0.741 [0.735, 0.777] | 0.945 [0.926, 1.020] | behind | 1.819 [1.805, 1.899]  |
| S1-unicode-32MiB     | udsv                     | 0.797 [0.792, 0.802] | 1.010 [0.996, 1.018] | behind | 1.801 [1.782, 1.819]  |
| S1-simple-32MiB      | udsv                     | 0.802 [0.800, 0.811] | 0.999 [0.990, 1.007] | behind | 2.041 [2.008, 2.068]  |
| S1-unicode-1MiB      | udsv                     | 0.880 [0.875, 0.894] | 1.005 [0.996, 1.017] | behind | 1.984 [1.951, 2.006]  |
| S1-simple-1MiB       | udsv                     | 0.915 [0.910, 0.918] | 1.000 [0.996, 1.004] | behind | 2.418 [2.378, 2.442]  |
| S1-multiline-1MiB    | udsv                     | 1.022 [1.018, 1.027] | 1.001 [0.993, 1.006] | ahead  | 2.402 [2.374, 2.436]  |
| S1-wide-32MiB        | csv-pipe                 | 1.138 [1.136, 1.141] | 1.000 [0.998, 1.003] | ahead  | 1.857 [1.851, 1.864]  |
| S1-long-field-32MiB  | csv-rex                  | 1.138 [1.135, 1.143] | 1.002 [0.998, 1.006] | ahead  | 1.158 [1.154, 1.160]  |
| S1-quote-heavy-1MiB  | udsv                     | 1.161 [1.145, 1.166] | 0.998 [0.983, 1.012] | ahead  | 2.714 [2.680, 2.746]  |
| S1-long-field-1MiB   | csv-rex                  | 1.266 [1.252, 1.269] | 1.007 [0.996, 1.010] | ahead  | 1.347 [1.331, 1.350]  |
| S1-wide-1MiB         | csv-pipe                 | 1.272 [1.267, 1.280] | 1.000 [0.998, 1.001] | ahead  | 2.237 [2.217, 2.245]  |
| S1-quote-heavy-32MiB | csv-pipe                 | 1.442 [1.431, 1.464] | 0.997 [0.988, 1.012] | ahead  | 2.136 [2.120, 2.170]  |

- **Memory**, as the report gives it: "single run, no record retained; median of the memory
  processes". The peak counter is `linux-proc-self-status-VmHWM`, and the empty process reads RSS
  96.4 MiB, peak 96.5 MiB. A ratio here is csvloom's peak / the other side's. The S1 report states
  no check line for memory; 8 of the 12 candidate / papaparse ratios are above 1.

| case                 | candidate peak MiB | candidate RSS before parse MiB | papaparse peak MiB | candidate / papaparse | lowest-peak competitor | its peak MiB | candidate / lowest |
| -------------------- | ------------------ | ------------------------------ | ------------------ | --------------------- | ---------------------- | ------------ | ------------------ |
| S1-simple-1MiB       | 105.4              | 98.9                           | 103.4              | 1.019                 | udsv                   | 99.3         | 1.061              |
| S1-quote-heavy-1MiB  | 106.5              | 98.4                           | 104.8              | 1.017                 | csv-pipe               | 98.7         | 1.080              |
| S1-multiline-1MiB    | 105.1              | 98.9                           | 104.4              | 1.007                 | csv-pipe               | 98.0         | 1.073              |
| S1-wide-1MiB         | 108.6              | 98.5                           | 103.5              | 1.049                 | csv-parser             | 99.1         | 1.096              |
| S1-unicode-1MiB      | 108.3              | 100.6                          | 105.1              | 1.031                 | csv-parser             | 101.1        | 1.072              |
| S1-long-field-1MiB   | 101.8              | 97.9                           | 99.9               | 1.019                 | csv-rex                | 97.9         | 1.040              |
| S1-simple-32MiB      | 177.7              | 129.9                          | 190.2              | 0.935                 | csv-parser             | 162.9        | 1.091              |
| S1-quote-heavy-32MiB | 185.9              | 128.0                          | 195.8              | 0.950                 | csv-parser             | 163.1        | 1.140              |
| S1-multiline-32MiB   | 177.8              | 128.0                          | 192.2              | 0.925                 | csv-parser             | 163.0        | 1.090              |
| S1-wide-32MiB        | 235.8              | 129.2                          | 221.8              | 1.063                 | csv-parser             | 168.1        | 1.402              |
| S1-unicode-32MiB     | 189.2              | 139.6                          | 204.1              | 0.927                 | csv-parser             | 173.3        | 1.092              |
| S1-long-field-32MiB  | 233.2              | 130.0                          | 177.7              | 1.312                 | csv-parser             | 166.1        | 1.404              |

- **Small inputs:** the S1 report has no small-input section.
- **Not in these numbers:** the report also times csvloom's own arms (`batchSize` 256 and 4096,
  and a bulk parse). The harness runs them with the lane; they are not part of the published
  numbers.

### A/A noise in the lanes

Each lane report's own noise check:

- B: "0 of 24 intervals exclude 1.000 (at most 3); largest half-width 2.13% (limit 2.50%); median
  half-width 0.60% (limit 1.50%): PASS."
- W1: "1 of 24 intervals exclude 1.000 (at most 3: W1-rows-wide-1MiB); largest half-width 8.48%
  (limit 2.50%); median half-width 1.21% (limit 1.50%): FAIL."
- S1: "0 of 12 intervals exclude 1.000 (at most 3); largest half-width 4.72% (limit 2.50%); median
  half-width 0.78% (limit 1.50%): FAIL."

In this campaign, on Node 26 at its default settings, some 32 MiB cases have wide A/A bands, with
half-widths above the 2.50% limit: seven in W1, from 3.13% to 8.48%, and one in S1,
S1-multiline-32MiB at 4.72%. Each case is classed against its own band, so a wide band makes a case
read inconclusive unless its whole interval lies clear of that band; it cannot make a case read
ahead or behind. Each lane ran only after its calibration read PASS. Every lane ran
once; nothing was run again to get a passing line.

### Known limits

- **amigo-labs-csv is a native addon** (`@amigo-labs/csv`) that runs only in Node. B's two
  long-field-32MiB losses and W1's four long-field losses are to it. csvloom is pure JavaScript;
  where it was run besides Node is in `docs/compatibility.md`, "Support matrix".
- **udsv generates code at run time.** csvloom does not, and will not, so it runs under a strict
  Content Security Policy. Three of B's five losses and all five of S1's are to udsv.
- **Record building slows after five or more header shapes in one process.** The benchmark parses
  one header shape per process, so the numbers above do not show it.
  - In a diagnostic run, csvloom after six other header shapes read 1.22 of its time without them
    on B2-simple-1MiB and 2.06 on B2-wide-1MiB (DIAGNOSTIC, Node 24.22.1).
  - The cause: V8's object-spread clone keeps four shapes, then defines properties one by one.
- **Competitor checks that failed.** The harness checks every pair's output before timing it. A
  pair that fails is FAIL and is not timed. The reports list:
  - B: but-csv on the 12 B1 primary cases; web-csv-toolbox on the six B2 32 MiB cases.
  - B, on additional cases with weight 0 that are not in the table: but-csv on
    B1-ext-nga-text-entries and B1-ext-tate-artwork; csv-rex on S1-wide-1MiB, a case where
    csvloom is DEFERRED by the frozen v1 manifest.
  - S1: csv-rex on S1-wide-1MiB and S1-wide-32MiB; udsv on S1-quote-heavy-32MiB.
  - W1: none.
- **Not part of these numbers:**
  - the U1 browser flow;
  - S1's arms (`batchSize` 256 and 4096, bulk) and W1's diagnostic arm `csv-engine (default-on)`,
    which the harness timed beside the lanes;
  - the additional cases of the B report.

### Charts

The README's two charts show lane B. They are drawn from the raw records of lane B's four shards
and its memory phase, with the report's own statistic: an implementation's time on a case is the
median of its 20 process medians, the "median ms" of the report's section "Every implementation
per case". No interval is drawn; the intervals of csvloom's ratios are in the lane B table above.

- **`docs/assets/bench-parse.svg`:** for each library, the geometric mean over the 24 primary
  cases of papaparse's time / that library's time, so papaparse reads 1.000 and above 1 means
  faster than papaparse.
  - csvloom's value is the report's line "Overall against papaparse: 2.596". The other values are
    derived from the same records; they are not lines of the report.
  - A library is shown only if its check passed and it was timed in 20 processes on all 24 cases.

| implementation                | papaparse time / its time, geometric mean over 24 cases |
| ----------------------------- | ------------------------------------------------------- |
| csvloom                       | 2.596                                                   |
| csv-simple-parser             | 1.950                                                   |
| udsv                          | 1.944                                                   |
| csv-pipe                      | 1.662                                                   |
| d3-dsv                        | 1.413                                                   |
| csv-rex                       | 1.040                                                   |
| papaparse                     | 1.000                                                   |
| amigo-labs-csv (native addon) | 0.682                                                   |
| csv-parse                     | 0.488                                                   |
| fast-csv                      | 0.278                                                   |

- **Not in that chart,** because they have no valid result on some of the 24 cases:
  - tiddlycsv: not run on the 12 B2 cases (UNSUPPORTED: no header API);
  - csv-parser: not run on the 12 B1 cases (UNSUPPORTED: it emits objects only);
  - but-csv: its check failed on the 12 B1 cases, and it was not run on B2 (no header API);
  - web-csv-toolbox: not run on B1 (UNSUPPORTED: not adapted), and its check failed on the six B2
    32 MiB cases;
  - papaparse-fastmode, Papa Parse with `fastMode: true`: not run on 16 of the 24 cases
    (UNSUPPORTED: "fastMode: true treats quotes as literal characters; this variant is only for
    unquoted input");
  - `csv-engine-aa`, the A/A arm, which is csvloom itself.
- **`docs/assets/bench-parse-cases.svg`:** the report's papaparse ratio of each of the 24 cases,
  the last column of the lane B table above, by kind of CSV and size.
- The charts print two decimals, and the tables here three. They name papaparse "Papa Parse", and
  its bar, the baseline at 1, is drawn in its own color.
- A new run's report prints the same "median ms" for every implementation and case, rounded, so
  both charts can be drawn again from it to that rounding.

### How to reproduce

On a Linux machine with nothing else running (the published runs used the VMs above, with the
workers on CPU 2, its hyperthread sibling CPU 6 left idle, and the runner on CPU 3):

- Node 26.13.1 from `https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz`, checked
  against that release's `SHASUMS256.txt` (`5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864`),
  unpacked in your home directory and put first on `PATH`;
- the three external datasets of lane B ("Cases" below) at the paths `bench/manifest.json` gives,
  with the SHA-256 it pins; its `source` field says where each came from, and the GeoNames file's
  URL moves, so a new download can differ. Lane B's shards S1 and S3 refuse to start without them;
- a clean checkout of release 0.1.0, then `npm ci` and `npm run build`. Before anything is
  timed, the runner builds the checked-out commit again from `git archive` and refuses a `dist/`
  that differs.

```sh
# 1. Calibration, on each machine before its lane (here the one before lane B).
#    The lane runs only if every shard exits 0 and the report reads COMPLETE and PASS.
for S in S1 S2 S3 S4; do
  taskset -c 3 node bench/run.ts --method pub --kind calibration --campaign calibration-b --shard $S --seed 3143297909 --pin-cpu 2
done
node bench/report.ts work/bench-v2/results/calibration-b/*.jsonl
# 2. Lane B: four shards, then the memory phase, then the report.
for S in S1 S2 S3 S4; do
  taskset -c 3 node bench/run.ts --method pub --campaign publication-b --shard $S --seed 1683478139 --pin-cpu 2 --budget 660
done
taskset -c 3 node bench/run.ts --method pub --campaign publication-b --phase memory --seed 1683478139 --pin-cpu 2 --budget 660
node bench/report.ts work/bench-v2/results/publication-b/*.jsonl
# 3. Lane W1: the projection first, then the shards and the memory phase.
R=work/bench-v2/results/publication-w1
RUN="taskset -c 3 node bench/run.ts --method pub --lane W1 --campaign publication-w1 --seed 3144853179 --pin-cpu 2 --budget 660"
$RUN --shard W1-rows --dry-run --out $R/projection.jsonl
$RUN --shard W1-rows && $RUN --shard W1-records && $RUN --phase memory
node bench/report.ts $R/W1-rows.jsonl $R/W1-records.jsonl $R/M.jsonl
# 4. Lane S1: as W1, with these values.
R=work/bench-v2/results/publication-s1
RUN="taskset -c 3 node bench/run.ts --method pub --lane S1 --campaign publication-s1 --seed 2546709905 --pin-cpu 2 --budget 400"
$RUN --shard S1-1MiB --dry-run --out $R/projection.jsonl
$RUN --shard S1-1MiB && $RUN --shard S1-32MiB-a && $RUN --shard S1-32MiB-b && $RUN --phase memory
node bench/report.ts $R/S1-1MiB.jsonl $R/S1-32MiB-a.jsonl $R/S1-32MiB-b.jsonl $R/M.jsonl
```

- The calibrations before W1 and S1 are the same commands with the seeds 2473337171 and 2760037355.
- The campaign id names only the result directory. As each report states, the campaign seed
  fixes the round order, the V8 seed of each round, each process's checkout copy and pad length,
  and the bootstrap. The times of a new run are new measurements.

## How the harness measures

`bench/` holds the harness. `bench/run.ts` runs the processes and writes one JSONL record per job;
`bench/report.ts` validates the records and computes every number above; three manifests fix
every value:

- `bench/manifest.json`: the cases, fixtures, implementations, declared-unsupported pairs and
  shards;
- `bench/manifest-v2.json`: how a run is timed and decided, plus the W1 and S1 lanes. It names
  `bench/manifest.json` by SHA-256 and refuses to run without it;
- `bench/manifest-pub.json`: the publication method, which names `bench/manifest-v2.json` by
  SHA-256 and replaces three of its values (below).

`test/bench-*.test.ts` covers the harness's rules and runs with `npm test`.

### Lanes

| Lane | Work measured                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | An in-memory string → every record as `string[]`, header row included                                                                                          |
| B2   | An in-memory string → one header-keyed object per data record                                                                                                  |
| S1   | UTF-8 byte chunks of 65,536 bytes from an in-memory async iterable → header-keyed records, handed one at a time to a consumer that keeps nothing               |
| W1   | Rows (header row first) or records (header as column order) → one CSV string; before timing, every output is read back by papaparse and must equal the fixture |
| U1   | The browser file flow, a `File` in a page to counted rows (`bench/u1.ts`); not part of the published numbers                                                   |

Rules the parsing lanes share:

- The line break that ends the input creates no record. Every other record is kept, blank lines
  and quoted-empty records included.
- A B2 or S1 record shorter than the header has only the fields it contains. Values must be
  strings, and so must B1 fields.
- Exactly one leading UTF-8 BOM is an encoding marker, not data. A U+FEFF anywhere else, and
  leading whitespace, are data. Libraries with their own BOM handling use it; for the others the
  adapter removes the one leading BOM inside the timed call.
- B compares records only. Error lists and metadata are covered by the compatibility tests.
- Lanes are never combined into one score.

### Cases

Synthetic fixtures are deterministic (`bench/fixtures.ts`, one mulberry32 seed per family). Their
expected output comes from the generator, so it is independent of every parser. Every case records
its bytes, records, columns and SHA-256, and the worker refuses an input whose hash differs.

| Family      | Shape                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| simple      | ASCII, 8 columns, no quoting needed, LF                                               |
| quote-heavy | 8 columns, embedded commas and doubled quotes, half of plain fields also quoted, CRLF |
| multiline   | 6 columns, LF and CRLF inside quoted fields, LF records                               |
| wide        | 256 numeric-like columns, 20% empty, LF                                               |
| unicode     | Turkish, CJK, Cyrillic, Arabic, Hebrew, Indic, emoji (ZWJ, flags), combining marks    |
| long-field  | 4 columns; one 8–64 KiB quoted field per record with commas, quotes and newlines      |

- **Primary (24):** B1 and B2 × the six families × about 1 MiB and about 32 MiB.
- **Small inputs (16):** B1 and B2 × simple, quote-heavy, multiline and unicode × 1 KiB and
  64 KiB. Only papaparse and csvloom run them.
- **W1 (24):** rows and records × the six families × 1 MiB and 32 MiB, from the same fixtures.
- **S1 (12):** the six families at 1 MiB and 32 MiB.
- **Additional (weight 0, never scored):** three external datasets in B1, NGA text entries,
  GeoNames cities1000 and Tate artwork data, pinned by source and SHA-256 in
  `bench/manifest.json` and kept in `work/data/external/` (not in the repository). Their expected
  output is the agreement of papaparse and d3-dsv; where the two disagree the case reads
  `NO-ORACLE`.

### Implementations

One adapter per package in `bench/adapters/`, at the versions `package.json` pins. Each adapter
passes an explicit dialect where the library allows it, and any per-input setup a caller must do
(uDSV's `inferSchema` and `initParser`, @amigo-labs/csv's `Buffer.from`) stays inside the timed
call. Before timing, the harness checks each pair's whole output against the expected rows:

| Status        | Meaning                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`        | Full output equals the expected rows (length first, then lane shape, then values)                                                                           |
| `FAIL`        | Output differs or the parser threw; a failing competitor is never the fastest valid competitor                                                              |
| `UNSUPPORTED` | Declared in the manifest (a missing lane, or an inapplicable variant such as `fastMode: true` on quoted input); never timed                                 |
| `UNAVAILABLE` | An implementation with no adapter in `bench/adapters`; recorded with that reason, never timed                                                               |
| `NO-ORACLE`   | papaparse and d3-dsv disagree on an external dataset                                                                                                        |
| `DEFERRED`    | A csvloom lane that `bench/manifest.json` does not measure (S1, which runs under `bench/manifest-v2.json`); recorded, never measured, never counted missing |
| `BLOCKED`     | The worker crashed, was killed at the deadline or memory limit, or was cancelled                                                                            |

Only `PASS` pairs are timed. Adapter details:

- papaparse's string path emits an extra record for the final line break. Its adapter removes it
  in O(1), only when the input ends with a line break, so a genuine blank last record survives.
  csvloom and csv-simple-parser emit the same record and get the same removal, inside the timed
  call. papaparse's stream path emits no such record.
- `papaparse-fastmode` is valid only for unquoted input and is declared unsupported elsewhere.
- csv-parser emits objects only, so it has no B1. d3-dsv has no quote option; but-csv and
  tiddlycsv are fixed to comma and double quote. web-csv-toolbox is async only.
- `test/bench-adapters.test.ts` runs 14 contract edges (`test/fixtures/adapter-edge-matrix.json`)
  on every adapter and lane, S1 at chunk sizes of 1, 2, 3 and 7 bytes and 64 KiB.

### Timing

A lane is a set of shards. Each shard checks every pair once, then runs its rounds: a round holds
one fresh process per passing pair and one empty process, in a new random order. The values are
those of `bench/manifest-v2.json`, `measurement`, under the publication method:

| Setting                               | Value                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processes per implementation and case | 20, one per round                                                                                                                                                                                                                                                                                           |
| Warm-up                               | at least 500 ms and at least 3 operations                                                                                                                                                                                                                                                                   |
| Samples                               | A pair whose check took under 90 ms repeats the operation: 3 samples, each a forced collection, about 250 ms of untimed operations and at least 250 ms of timed ones, both counts fixed once per pair. From 90 ms: one operation per sample on a collected heap, as many samples as fill 750 ms, at least 3 |
| Statistic per process                 | the median of its samples                                                                                                                                                                                                                                                                                   |
| Order                                 | a new random permutation of all jobs per round, from the campaign seed                                                                                                                                                                                                                                      |
| V8 seed                               | one per round, shared by every process of the round (`--random-seed=<s> --hash-seed=<s>`), derived from the campaign seed and distinct between rounds; the arms of a comparison are paired by round                                                                                                         |
| csvloom                               | the `dist/` bundle of the measured commit; before timing, the runner builds that commit again from `git archive` and refuses a different tree hash. The worker reports the path and SHA-256 of the file it imported                                                                                         |
| A/A arm                               | `csv-engine-aa`: the same bundle loaded from a sibling directory, `twin/`                                                                                                                                                                                                                                   |
| Setup randomisation                   | per process, one of three checkout copies at different path depths, and an environment variable `CSV_BENCH_PAD` of random length 0-4096                                                                                                                                                                     |
| Placement                             | `--pin-cpu <n>`: workers pinned with `taskset` to that CPU; the runner must exclude it and its hyperthread sibling. A shard is flagged when the sibling was busy more than 1% of the time or the worker CPU lost more than 0.5% to steal                                                                    |
| Memory                                | a phase of its own after the timing shards: 5 rounds of one single-run process per scored pair and one empty process; the peak is `VmHWM` from `/proc/self/status`                                                                                                                                          |

**The publication method** (`bench/manifest-pub.json`) replaces three values of
`bench/manifest-v2.json`: Node 26.13.1 instead of 24.22.1; no Node flag on the timing processes
instead of `--no-osr-from-maglev` on a pair that repeats the operation; papaparse 5.7.1 instead of
5.7.0. Every process starts with `--expose-gc` (for the forced collections) and the round's seed
flags, and with no other Node flag: each worker reports its `execArgv`, the report rejects a shard
in which any process reported another flag, and the runner refuses to start while `NODE_OPTIONS`
or `NODE_COMPILE_CACHE` is set. Each checkout copy holds the method's papaparse as
`node_modules/papaparse`, taken from the npm alias `package.json` installs (`papaparse-5.7.1`
here), so no process loads both versions. A pair
under 90 ms is timed in whichever state V8's tiers reach after the forced collections, so a
published number describes the measured build under this loop on default Node.

`--method v2` keeps `bench/manifest-v2.json` as it is (Node 24.22.1, `--no-osr-from-maglev` on a
pair that repeats the operation, papaparse 5.7.0). The A/B tool, `bench/ab.ts`, uses it to compare
two commits: both are built from `git archive` into sibling directories, timed in the same rounds
with at least 10 processes per arm and case, and kept only if every target case's B/A upper bound
is below 0.98 and no other primary case's lower bound is above 1.01. Running `bench/run.ts`
without `--method` uses method v1, `bench/manifest.json` alone (3 repetitions of 7 samples, and a
cold-start measurement); its ratios are not comparable with v2's, and none is published.

### Decision

```text
process median  = median of the samples of one process
ratio_i         = median(process medians of X) / median(process medians of csvloom)
                  X = the fastest valid competitor (smallest median, chosen once), the A/A arm, papaparse
interval_i      = 2.5% and 97.5% points of 10,000 bootstrap ratios; each resamples the 20 rounds
                  with replacement and takes both arms at the resampled rounds (paired)
p_i             = min(1, 2 * (min(#{ratio* <= 1}, #{ratio* >= 1}) + 1) / 10,001)
significant_i   = Holm step-down over the lane's cases at family-wise 5%
ahead           = significant, ratio > 1, lower bound above the upper bound of the case's A/A interval
behind          = significant, ratio < 1, upper bound below the lower bound of the case's A/A interval
inconclusive    = everything else
overall         = weighted geometric mean of the 24 primary ratios (B only); its interval takes
                  bootstrap replicate k of every case together
```

- **Noise check.** A calibration (`--kind calibration`) runs only csvloom and the A/A arm on the
  24 primary cases. It passes when at most 3 of the 24 A/A intervals exclude 1.000, every
  half-width is at most 2.5%, and the median half-width is at most 1.5%. Every lane report
  states the same check on its own A/A arm.
- **Completeness.** A report is COMPLETE only if every shard is present once, of one campaign,
  seed, commit, bundle and machine, pinned, unfiltered and ended `complete`, and every expected
  pair has its check, all its rounds with valid samples, the full identity on every record and,
  for primary cases, its memory rounds. Anything else prints `INCOMPLETE: diagnostics only, not a
result`. The same records always give the same text: the bootstrap seeds derive from the
  campaign seed and the shard, and the report holds no timestamp.
- **Exit status of `bench/report.ts`:** 0 complete, 1 incomplete, 3 a complete calibration that
  fails the noise check.
- **Identity.** Every record states the harness and measured commits, the bundle's SHA-256, the
  Node version and flags, the CPU model, the kernel, the `taskset` mask, the pad length and the
  checkout copy. A run made with other manifest values reads "run with a different v2 manifest"
  and gets no result.
