# Torrenting simulation

Experimental simulation of BitTorrent under different reciprocity

To run, navigate to the root directory and run

```
npm install
npm run dev
```

## Run experiments from the command line

From the repository root, edit `examples/experiment.json`, then run:

```sh
npm run experiment -- examples/experiment.json results.json
```

The first argument is the input JSON path; the second is the output JSON path.
The runner writes configurations, shared sampled inputs, and results to the output
file, replacing it if it already exists.

The input contains:

- `config`: swarm conditions, file size, timing, churn, and unchoking slot counts.
- `seed`: random seed for the sweep.
- `alphas`: reciprocity values to test, chosen from `0`, `0.25`, `0.5`, `0.75`, `1`.

The seed runs both reference policies and every combination of selection and
allocation alpha values. With all five alpha values, this gives 25 hybrid runs
and 27 comparison rows. The reference and hybrid runs share sampled inputs.

The example uses one seeder and five initial leechers, a 4 MB file, and a 60-second
limit. Adjust timing and unchoking slots through `timeLimitSeconds`, `stepSeconds`,
`selectionIntervalSeconds`, `contributionWindowSeconds`, `regularSlots`, and
`optimisticSlots` in `config`. Timing intervals must be positive integer multiples
of the simulation step. Inputs are assumed to satisfy the simulation contract.

## Run a batch study

From the repository root, run:

```sh
node scripts/run-batch.js --out results/batch
```

The runner uses `scripts/config.json` by default. To choose a configuration or limit parallel workers:

```sh
node scripts/run-batch.js --config scripts/config.json --out results/batch --workers 4
```

`--out` is required. The default worker count is half the available parallelism, rounded down. Use a new output directory for each batch: the runner refuses to replace an existing `metadata.json`.

The default configuration tests 24 swarm conditions across 30 seeds. For each condition and seed, it runs two reference policies and all 25 combinations of hybrid selection and bandwidth weights, for 19,440 runs total. Policies within a condition and seed share the same sampled inputs.

The output directory contains `runs.csv` (run settings and summary metrics), `peers.csv` (peer inputs and completion times), and `metadata.json` (the study design, run counts, and completion status). A successful batch sets `complete` to `true` in `metadata.json`.
