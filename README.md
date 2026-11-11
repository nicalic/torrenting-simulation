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
- `seeds`: random seeds for independent repetitions.
- `alphas`: reciprocity values to test, chosen from `0`, `0.25`, `0.5`, `0.75`, `1`.

Each seed runs both reference policies and three hybrid families: selection-only
`(α, 0)`, allocation-only `(0, α)`, and combined `(α, α)`. Shared hybrid settings
run once per seed and their results are reused across families. With all five
alpha values, this gives 15 unique simulations and 17 comparison rows per seed.

The example uses one seeder and five initial leechers, a 4 MB file, and a 60-second
limit. Adjust timing and unchoking slots through `timeLimitSeconds`, `stepSeconds`,
`selectionIntervalSeconds`, `contributionWindowSeconds`, `regularSlots`, and
`optimisticSlots` in `config`. Timing intervals must be positive integer multiples
of the simulation step. Inputs are assumed to satisfy the simulation contract.
