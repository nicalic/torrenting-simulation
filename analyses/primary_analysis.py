#!/usr/bin/env python3
"""Hybrid reciprocity tuning analysis for the uploaded torrent simulation CSVs.

Examples:
    python primary_analysis.py /path/to/tuning-set --out tuning_analysis
    python primary_analysis.py /path/to/tuning-set --out tuning_analysis

Outputs global_optimum.csv and condition_optima.csv for secondary_analysis.py.

Primary response = run-level average min(peer completion time, deadline).
This *capped* mean is not the uncensored mean peer completion time. A peer
unfinished at deadline is assigned deadline, not claimed to have completed.
Also analyzes run-level peer completion fractions; unfinished peers are censored at the common deadline.
"""

from __future__ import annotations
import argparse
import warnings
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
import statsmodels.formula.api as smf
from scipy import stats

sns.set_theme(style="whitegrid", context="paper", font_scale=1.15)
FACTOR_COLS = ["heterogeneity", "churn_enabled", "free_rider_ratio"]
KEY = ["condition", "seed"]


def read_dataset(source: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Read a directory containing exactly runs.csv and peers.csv."""
    if not source.is_dir():
        raise NotADirectoryError(f"Expected a directory, got {source}")
    for filename in ("runs.csv", "peers.csv"):
        if not (source / filename).is_file():
            raise FileNotFoundError(source / filename)
    return pd.read_csv(source / "runs.csv"), pd.read_csv(source / "peers.csv")


def prepare(source: Path) -> pd.DataFrame:
    runs, peers = read_dataset(source)
    required_r = {
        "run_id",
        "condition",
        "seed",
        "policy",
        "alpha_s",
        "alpha_b",
        "heterogeneity",
        "churn_enabled",
        "free_rider_ratio",
        "deadline_s",
        "finished_fraction",
        "t_avg_s",
        "swarm_finished",
    }
    required_p = {"run_id", "peer_id", "completion_time_s"}
    if required_r - set(runs) or required_p - set(peers):
        raise ValueError(
            f"Missing columns: runs={required_r-set(runs)}, peers={required_p-set(peers)}"
        )
    runs = runs.loc[runs.policy.eq("hybrid")].copy()
    if runs.empty or runs.run_id.duplicated().any():
        raise ValueError("Expected unique hybrid run IDs")
    pp = peers.loc[
        peers.run_id.isin(runs.run_id), ["run_id", "peer_id", "completion_time_s"]
    ]
    if pp.duplicated(["run_id", "peer_id"]).any():
        raise ValueError("Duplicate peer IDs within a run")
    pp = pp.merge(runs[["run_id", "deadline_s"]], on="run_id", validate="many_to_one")
    pp["capped_time_s"] = pp.completion_time_s.fillna(pp.deadline_s).clip(
        upper=pp.deadline_s
    )
    agg = (
        pp.groupby("run_id")
        .agg(
            capped_mean_s=("capped_time_s", "mean"),
            peers_recorded=("peer_id", "size"),
            observed_completed=("completion_time_s", "count"),
        )
        .reset_index()
    )
    runs = runs.merge(agg, on="run_id", validate="one_to_one")
    if not runs.peers_recorded.eq(runs.initial_leechers).all():
        raise ValueError("Peer record counts do not match initial_leechers")
    if not runs.observed_completed.eq(runs.finished_count).all():
        raise ValueError("Peer completion counts do not match finished_count")
    runs["churn_enabled"] = runs.churn_enabled.astype(bool)
    runs["scenario"] = runs.condition.astype(str) + ":" + runs.seed.astype(str)
    runs["complete_only_mean_s"] = runs.t_avg_s.where(runs.swarm_finished)
    return runs


def csv(df, out, name):
    df.to_csv(out / name, index=False, float_format="%.7g")


def heatmap(data, title, path, vmax=None, vmin=None):
    piv = data.pivot(index="alpha_s", columns="alpha_b", values="capped_mean_s")
    fig, ax = plt.subplots(figsize=(7.4, 5.7))
    sns.heatmap(
        piv,
        cmap="viridis_r",
        annot=True,
        fmt=".1f",
        linewidths=0.4,
        vmin=vmin,
        vmax=vmax,
        ax=ax,
        cbar_kws={"label": "180-s restricted mean completion time (s)"},
    )
    ax.invert_yaxis()
    ax.set(
        xlabel="Bandwidth reciprocity α_b",
        ylabel="Selection reciprocity α_s",
        title=title,
    )
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "tuning_data", type=Path, help="Directory containing runs.csv and peers.csv"
    )
    ap.add_argument("--out", type=Path, default=Path("tuning_analysis"))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    d = prepare(args.tuning_data)
    nseeds = d.seed.nunique()
    print(
        f"Tuning: {len(d):,} runs, {d.condition.nunique()} swarms, {nseeds} seeds, "
        f'{d[["alpha_s","alpha_b"]].drop_duplicates().shape[0]} reciprocity combinations'
    )
    print(
        f"Fully finished swarms: {d.swarm_finished.mean():.1%}; "
        f"original t_avg_s missing: {d.t_avg_s.isna().sum():,}"
    )
    if nseeds != 30:
        warnings.warn(f"Dataset has {nseeds} repetitions, not planned 30")
    d.to_csv(args.out / "run_metrics.csv", index=False)
    summary = (
        d.groupby(["condition", *FACTOR_COLS, "alpha_s", "alpha_b"], observed=True)
        .agg(
            n=("capped_mean_s", "size"),
            mean_capped_s=("capped_mean_s", "mean"),
            sd_capped_s=("capped_mean_s", "std"),
            mean_finish_fraction=("finished_fraction", "mean"),
            full_completion_rate=("swarm_finished", "mean"),
            complete_runs=("complete_only_mean_s", "count"),
            complete_only_mean_s=("complete_only_mean_s", "mean"),
        )
        .reset_index()
    )
    csv(summary, args.out, "condition_parameter_summary.csv")
    # Balanced average across all swarms, rather than weighting by observed run count.
    global_scores = summary.groupby(["alpha_s", "alpha_b"], as_index=False).agg(
        capped_mean_s=("mean_capped_s", "mean"),
        mean_finish_fraction=("mean_finish_fraction", "mean"),
        full_completion_rate=("full_completion_rate", "mean"),
    )
    global_scores = global_scores.sort_values(["capped_mean_s", "alpha_s", "alpha_b"])
    csv(global_scores, args.out, "global_parameter_ranking.csv")
    # Completion-rate-first ranking is a diagnostic, not the primary optimizer.
    completion_ranking = global_scores.sort_values(
        ["mean_finish_fraction", "capped_mean_s"], ascending=[False, True]
    )
    csv(completion_ranking, args.out, "global_completion_rate_ranking.csv")
    fastest = global_scores.iloc[0]
    most_complete = completion_ranking.iloc[0]
    csv(
        pd.DataFrame(
            [
                {
                    "criterion": "lowest_restricted_mean",
                    "alpha_s": fastest.alpha_s,
                    "alpha_b": fastest.alpha_b,
                    "restricted_mean_s": fastest.capped_mean_s,
                    "mean_finish_fraction": fastest.mean_finish_fraction,
                },
                {
                    "criterion": "highest_completion_rate_then_fastest",
                    "alpha_s": most_complete.alpha_s,
                    "alpha_b": most_complete.alpha_b,
                    "restricted_mean_s": most_complete.capped_mean_s,
                    "mean_finish_fraction": most_complete.mean_finish_fraction,
                },
            ]
        ),
        args.out,
        "speed_vs_completion_optima.csv",
    )
    # How the completion-based choice changes with each swarm factor.
    finish_by_factor = []
    for factor in FACTOR_COLS:
        z = summary.groupby([factor, "alpha_s", "alpha_b"], as_index=False).agg(
            completion_rate=("mean_finish_fraction", "mean"),
            restricted_mean_s=("mean_capped_s", "mean"),
        )
        z = z.sort_values(
            [factor, "completion_rate", "restricted_mean_s"],
            ascending=[True, False, True],
        ).drop_duplicates(factor)
        z["factor"] = factor
        z["level"] = z[factor].astype(str)
        finish_by_factor.append(
            z[
                [
                    "factor",
                    "level",
                    "alpha_s",
                    "alpha_b",
                    "completion_rate",
                    "restricted_mean_s",
                ]
            ]
        )
    csv(
        pd.concat(finish_by_factor, ignore_index=True),
        args.out,
        "factor_level_completion_optima.csv",
    )
    complete_grid = global_scores.rename(
        columns={"mean_finish_fraction": "completion_rate"}
    )
    pivot = complete_grid.pivot(
        index="alpha_s", columns="alpha_b", values="completion_rate"
    )
    fig, ax = plt.subplots(figsize=(7.4, 5.7))
    sns.heatmap(
        pivot * 100,
        cmap="viridis",
        annot=True,
        fmt=".1f",
        linewidths=0.4,
        vmin=0,
        vmax=100,
        cbar_kws={"label": "Completed peers by 180 s (%)"},
        ax=ax,
    )
    ax.invert_yaxis()
    ax.set(
        xlabel="Bandwidth reciprocity α_b",
        ylabel="Selection reciprocity α_s",
        title="Overall peer completion rate",
    )
    fig.tight_layout()
    fig.savefig(args.out / "08_completion_rate_heatmap.png", dpi=200)
    plt.close(fig)
    for factor in FACTOR_COLS:
        levels = sorted(summary[factor].unique())
        fig, axs = plt.subplots(
            1, len(levels), figsize=(5 * len(levels), 4.5), squeeze=False
        )
        for ax, level in zip(axs.flat, levels):
            z = (
                summary.loc[summary[factor].eq(level)]
                .groupby(["alpha_s", "alpha_b"], as_index=False)
                .mean_finish_fraction.mean()
            )
            sns.heatmap(
                z.pivot(
                    index="alpha_s", columns="alpha_b", values="mean_finish_fraction"
                )
                * 100,
                vmin=0,
                vmax=100,
                cmap="viridis",
                annot=True,
                fmt=".0f",
                ax=ax,
                cbar=False,
            )
            ax.invert_yaxis()
            ax.set_title(f"{factor} = {level}")
        fig.suptitle(f"Peer completion rate (%) by {factor}")
        fig.tight_layout()
        fig.savefig(args.out / f"09_completion_facets_{factor}.png", dpi=180)
        plt.close(fig)

    best = global_scores.iloc[[0]][["alpha_s", "alpha_b", "capped_mean_s"]].copy()
    csv(best, args.out, "global_optimum.csv")
    local = summary.sort_values(
        ["condition", "mean_capped_s", "alpha_s", "alpha_b"]
    ).drop_duplicates("condition")
    local = local.rename(columns={"mean_capped_s": "capped_mean_s"})
    csv(
        local[["condition", *FACTOR_COLS, "alpha_s", "alpha_b", "capped_mean_s"]],
        args.out,
        "condition_optima.csv",
    )
    # Best settings by each level of a single swarm factor, averaging over remaining conditions.
    factor_best = []
    for factor in FACTOR_COLS:
        tab = summary.groupby(
            [factor, "alpha_s", "alpha_b"], as_index=False
        ).mean_capped_s.mean()
        tab = tab.sort_values(
            [factor, "mean_capped_s", "alpha_s", "alpha_b"]
        ).drop_duplicates(factor)
        for _, r in tab.iterrows():
            factor_best.append(
                {
                    "factor": factor,
                    "level": str(r[factor]),
                    "alpha_s": r.alpha_s,
                    "alpha_b": r.alpha_b,
                    "capped_mean_s": r.mean_capped_s,
                }
            )
    csv(pd.DataFrame(factor_best), args.out, "factor_level_optima.csv")
    # Tuning penalties are in-sample descriptive estimates, not held-out performance.
    ref = summary.loc[
        (summary.alpha_s == best.iloc[0].alpha_s)
        & (summary.alpha_b == best.iloc[0].alpha_b),
        ["condition", "mean_capped_s"],
    ]
    delta = local[["condition", "capped_mean_s"]].merge(ref, on="condition")
    delta["in_sample_tuning_gain_s"] = delta.mean_capped_s - delta.capped_mean_s
    csv(delta, args.out, "in_sample_tuning_gains.csv")

    heatmap(
        global_scores,
        "Overall reciprocity response surface",
        args.out / "01_overall_heatmap.png",
    )
    heatmap(
        global_scores,
        "Overall reciprocity response surface",
        args.out / "01_overall_heatmap.svg",
    )
    marginal = []
    for factor in ["alpha_s", "alpha_b"]:
        x = global_scores.groupby(factor, as_index=False).capped_mean_s.mean()
        x["parameter"] = factor
        x["level"] = x[factor]
        marginal.append(x[["parameter", "level", "capped_mean_s"]])
    marginal = pd.concat(marginal, ignore_index=True)
    csv(marginal, args.out, "marginal_effects.csv")
    fig, ax = plt.subplots(figsize=(8, 5))
    sns.lineplot(
        data=marginal, x="level", y="capped_mean_s", hue="parameter", marker="o", ax=ax
    )
    ax.set(
        xlabel="Reciprocity strength",
        ylabel="180-s restricted mean completion time (s)",
        title="Marginal reciprocity effects",
    )
    fig.tight_layout()
    fig.savefig(args.out / "02_marginal_effects.png", dpi=200)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(8, 5))
    sns.lineplot(
        data=global_scores,
        x="alpha_s",
        y="capped_mean_s",
        hue="alpha_b",
        marker="o",
        palette="viridis",
        ax=ax,
    )
    ax.set(
        xlabel="Selection reciprocity α_s",
        ylabel="180-s restricted mean completion time (s)",
        title="Selection × bandwidth interaction",
    )
    fig.tight_layout()
    fig.savefig(args.out / "03_reciprocity_interaction.png", dpi=200)
    plt.close(fig)
    for factor in FACTOR_COLS:
        fig, axs = plt.subplots(
            1,
            d[factor].nunique(),
            figsize=(5 * d[factor].nunique(), 4.5),
            squeeze=False,
        )
        levels = sorted(summary[factor].unique())
        lo, hi = summary.mean_capped_s.min(), summary.mean_capped_s.max()
        for ax, level in zip(axs.flat, levels):
            t = (
                summary.loc[summary[factor].eq(level)]
                .groupby(["alpha_s", "alpha_b"], as_index=False)
                .mean_capped_s.mean()
            )
            p = t.pivot(index="alpha_s", columns="alpha_b", values="mean_capped_s")
            sns.heatmap(
                p,
                cmap="viridis_r",
                vmin=lo,
                vmax=hi,
                ax=ax,
                cbar=False,
                annot=True,
                fmt=".0f",
            )
            ax.invert_yaxis()
            ax.set_title(f"{factor} = {level}")
        fig.suptitle(f"Reciprocity response by {factor}")
        fig.tight_layout()
        fig.savefig(args.out / f"04_facets_{factor}.png", dpi=180)
        plt.close(fig)
    # Show the best levels of both parameters for each condition.
    fig, axs = plt.subplots(2, 1, figsize=(13, 7), sharex=True)
    ordered = local.sort_values(FACTOR_COLS).reset_index(drop=True)
    for ax, field in zip(axs, ["alpha_s", "alpha_b"]):
        sns.scatterplot(
            data=ordered,
            x=np.arange(len(ordered)),
            y=field,
            hue="churn_enabled",
            palette="Set2",
            s=80,
            ax=ax,
        )
        ax.set(ylabel=field, ylim=(-0.07, 1.07))
        ax.legend(title="Churn")
    axs[-1].set_xticks(range(len(ordered)), ordered.condition, rotation=80, fontsize=8)
    axs[-1].set_xlabel("Swarm condition")
    fig.suptitle("Best observed parameters per condition")
    fig.tight_layout()
    fig.savefig(args.out / "05_condition_optima.png", dpi=200)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(12, 4))
    z = delta.sort_values("in_sample_tuning_gain_s", ascending=False)
    sns.barplot(
        data=z, x="condition", y="in_sample_tuning_gain_s", color="steelblue", ax=ax
    )
    ax.set(
        title="In-sample gain from swarm-specific tuning (optimistic)",
        xlabel="Condition",
        ylabel="Global minus local capped mean (s)",
    )
    ax.tick_params(axis="x", labelrotation=80)
    fig.tight_layout()
    fig.savefig(args.out / "06_tuning_gain_in_sample.png", dpi=200)
    plt.close(fig)

    # Joint model with categorical parameters and main effects of the three swarm factors.
    # Cluster-robust SEs account for policies sharing the same condition + seed scenario.
    formula = (
        "capped_mean_s ~ C(alpha_s)*C(alpha_b)"
        "+C(heterogeneity)+C(churn_enabled)+C(free_rider_ratio)"
        "+C(alpha_s):C(heterogeneity)+C(alpha_b):C(heterogeneity)"
        "+C(alpha_s):C(churn_enabled)+C(alpha_b):C(churn_enabled)"
        "+C(alpha_s):C(free_rider_ratio)+C(alpha_b):C(free_rider_ratio)"
    )
    mdl = smf.ols(formula, data=d).fit(
        cov_type="cluster", cov_kwds={"groups": d.scenario}
    )
    (args.out / "factorial_regression.txt").write_text(
        mdl.summary().as_text(), encoding="utf-8"
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wald = mdl.wald_test_terms(skip_single=False, scalar=True).table
    wald.to_csv(args.out / "factorial_wald_tests.csv")
    coeff = pd.DataFrame(
        {
            "term": mdl.params.index,
            "estimate": mdl.params.to_numpy(),
            "ci_low": mdl.conf_int().iloc[:, 0].to_numpy(),
            "ci_high": mdl.conf_int().iloc[:, 1].to_numpy(),
            "pvalue": mdl.pvalues.to_numpy(),
        }
    )
    csv(coeff, args.out, "factorial_coefficients.csv")
    interacting = coeff[coeff.term.str.contains(":")].sort_values("estimate")
    fig, ax = plt.subplots(figsize=(12, max(7, len(interacting) * 0.24)))
    y = np.arange(len(interacting))
    ax.errorbar(
        interacting.estimate,
        y,
        xerr=[
            interacting.estimate - interacting.ci_low,
            interacting.ci_high - interacting.estimate,
        ],
        fmt="o",
        capsize=2,
    )
    ax.set_yticks(y, interacting.term, fontsize=7)
    ax.axvline(0, color="gray", ls="--")
    ax.set(
        title="Model interaction coefficients (reference-level coding)",
        xlabel="Effect (s)",
    )
    fig.tight_layout()
    fig.savefig(args.out / "07_model_interaction_coefficients.png", dpi=160)
    plt.close(fig)
    # Secondary completion outcome: run-level fractions; cluster on the
    # matched scenario to account for repeated parameter settings per seed.
    rate_model = smf.ols(
        formula.replace("capped_mean_s", "finished_fraction"), data=d
    ).fit(cov_type="cluster", cov_kwds={"groups": d.scenario})
    (args.out / "completion_rate_regression.txt").write_text(
        rate_model.summary().as_text(), encoding="utf-8"
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rate_model.wald_test_terms(skip_single=False, scalar=True).table.to_csv(
            args.out / "completion_rate_wald_tests.csv"
        )
    print("Best global α_s, α_b:", best.iloc[0].alpha_s, best.iloc[0].alpha_b)
    print("Files written to", args.out.resolve())


if __name__ == "__main__":
    main()
