# Torrenting simulation statistical analysis

## Requirements

Python 3.10+ and:

```bash
pip install numpy pandas scipy statsmodels seaborn matplotlib
```

## Inputs

Each script receives a **directory** containing exactly named `runs.csv` and `peers.csv`, for example:

```
tuning-set/
  runs.csv
  peers.csv
evaluation-set/
  runs.csv
  peers.csv
```

The evaluation and tuning sets should contain independent random seeds. Runs that share a seed and condition within one dataset should use a matched exogenous swarm scenario.

## Execute

```bash
python primary_analysis.py /path/to/tuning-set --out tuning_analysis
python secondary_analysis.py /path/to/evaluation-set --selection tuning_analysis --out evaluation_analysis
```

`--selection` points to the primary analysis output directory, which contains `global_optimum.csv` and `condition_optima.csv`. The evaluation script does not optimize parameters on the evaluation data.

## Outcome interpretation

The primary response is the **restricted mean peer completion time** at the fixed 180-second deadline, calculated on a per-run basis as the mean of `min(completion_time, deadline)` over peers. It is **not** the unrestricted mean completion time: unfinished peers contribute the observation deadline, and are treated as administratively censored rather than deemed to have completed. If the deadline differs from 180 seconds, the calculations use each run's `deadline_s`, but labelled figures assume a common 180-second deadline. For clean comparisons, keep the same observation deadline across all runs.

The run-level peer completion fraction is analyzed separately (including models with matched-scenario cluster-robust SEs). Original `t_avg_s` from completed swarms is preserved as descriptive information only. Peer Kaplan–Meier curves display the proportion of peers not yet completed as time progresses, but do not show naive peer-independent confidence bands, because peers in each run are correlated. The paired confidence intervals for both outcomes use matched **seed-level run aggregates**, avoiding peer-level pseudoreplication.

### Primary outputs (selected)
- `global_optimum.csv`, `condition_optima.csv`: time-based selections for held-out comparisons
- `global_parameter_ranking.csv`, `condition_parameter_summary.csv`: parameter performance on restricted time and completion rate
- `global_completion_rate_ranking.csv`, `speed_vs_completion_optima.csv`, `factor_level_completion_optima.csv`: speed/completion trade-offs
- `01_overall_heatmap.png`, `04_facets_*.png`: reciprocity vs restricted mean
- `08_completion_rate_heatmap.png`, `09_completion_facets_*.png`: overall and factor-specific peer completion percentages
- `factorial_regression.txt`, `completion_rate_regression.txt`: swarm-factor and reciprocity interaction models

### Secondary outputs (selected)
- `strategy_summary.csv`, `overall_paired_comparisons.csv`, `condition_paired_comparisons.csv`: restricted-time outcomes
- `overall_completion_rate_comparisons.csv`, `condition_completion_rate_comparisons.csv`: paired peer completion-fraction effects and CIs
- `algorithm_swarm_regression.txt`, `completion_rate_interaction_regression.txt`: interactions with swarm factors
- `06_kaplan_meier_overall.png`, `07_kaplan_meier_by_freerider.png`: unfinished-peer curves
- `08_completion_rate_by_factors.png`: peer completion percentages by swarm characteristics

## Inference and caveats

The currently supplied files have **20 seeds per condition**, not the proposed 30; scripts warn but continue. Completion-rate comparisons report differences as fractions (multiply by 100 for percentage points). Per-condition hypotheses should be interpreted with multiple-testing corrections, effect sizes, and uncertainty. The swarm-specific winner is chosen from tuning trials and might be less reliable if several settings are nearly tied. `finished_fraction` is treated as a run-level response; a linear-model approach provides an interpretable approximation but is not a fully specified binomial model. Long-deadline sensitivity studies are recommended if the distinction between restricted and unrestricted completion times is scientifically important.
