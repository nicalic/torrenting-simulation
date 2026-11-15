#!/usr/bin/env python3
"""Graphs and summary tables comparing proportional share, unchoke-based
reciprocity and the hybrid reciprocity model, from the output of run-batch.js.

    python scripts/analyse_results.py --results results --out results/figures
    python scripts/analyse_results.py --results results --hybrid 0.75:0.25 --format pdf

Completion time is computed from peers.csv rather than runs.csv: the simulator's
t_avg_s is blank whenever any peer misses the deadline, which would silently drop
the hardest runs (churn, free riders). Here an unfinished peer counts as finishing
at the deadline (a restricted mean), and the finished fraction is plotted alongside
so the censoring is visible.

Requires pandas, numpy, matplotlib and scipy.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from scipy import stats  # noqa: E402

# Colours match STRATEGY_COLOURS in src/simulation/constants.js so figures and the
# web UI agree. Markers give every model a second, non-colour identity cue.
MODEL_ORDER = ["prop", "unchoke", "hybrid"]
MODEL_NAMES = {"prop": "Proportional share", "unchoke": "Unchoke reciprocity", "hybrid": "Hybrid"}
MODEL_COLOURS = {"prop": "#73b442", "unchoke": "#438ac2", "hybrid": "#c24d43"}
MODEL_MARKERS = {"prop": "s", "unchoke": "o", "hybrid": "^"}

# Hybrid sweep families: one hue family (the hybrid red), told apart by marker and lightness.
SWEEP_ORDER = ["selection-only", "allocation-only", "combined"]
SWEEP_STYLES = {
    "selection-only": {"color": "#8a2f28", "marker": "s"},
    "allocation-only": {"color": "#e0938c", "marker": "D"},
    "combined": {"color": "#c24d43", "marker": "^"},
}

INK, INK_2, INK_3 = "#0b0b0b", "#52514e", "#8a8984"
GRID, SURFACE = "#e1e0d9", "#fcfcfb"
# Diverging: blue = better than unchoke, gray = no change, red = worse.
DIVERGING = LinearSegmentedColormap.from_list(
    "better_worse", ["#184f95", "#3987e5", "#f0efec", "#e66767", "#a8302f"])

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": GRID, "axes.linewidth": 0.8, "axes.grid": True, "grid.color": GRID,
    "grid.linewidth": 0.6, "axes.axisbelow": True, "axes.spines.top": False,
    "axes.spines.right": False, "axes.labelcolor": INK_2, "axes.titlecolor": INK,
    "axes.titlesize": 10, "axes.titleweight": "semibold", "axes.labelsize": 9,
    "xtick.color": INK_2, "ytick.color": INK_2, "xtick.labelsize": 8.5, "ytick.labelsize": 8.5,
    "xtick.major.size": 0, "ytick.major.size": 0, "legend.fontsize": 9, "legend.frameon": False,
    "text.color": INK, "font.size": 9, "lines.linewidth": 1.8, "lines.markersize": 5.5,
    "figure.titlesize": 12, "figure.titleweight": "semibold",
})


# --------------------------------------------------------------------------- data

def as_bool(series):
    return series.astype(str).str.lower().eq("true")


def load(results_dir):
    runs = pd.read_csv(results_dir / "runs.csv")
    peers = pd.read_csv(results_dir / "peers.csv")
    meta_path = results_dir / "metadata.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    deadline = float(meta.get("design", {}).get("fixed", {}).get("timeLimitSeconds", runs.deadline_s.max()))

    runs["churn_enabled"] = as_bool(runs.churn_enabled)
    runs["free_rider_pct"] = (runs.free_rider_ratio * 100).round().astype(int)
    peers["free_rider"] = as_bool(peers.free_rider)
    peers["finished"] = peers.completion_time_s.notna()
    peers["t_cens"] = peers.completion_time_s.fillna(deadline)

    contrib, riders = peers[~peers.free_rider], peers[peers.free_rider]
    per_run = pd.DataFrame({
        "mean_t": peers.groupby("run_id").t_cens.mean(),
        "finished": peers.groupby("run_id").finished.mean(),
        "contrib_mean_t": contrib.groupby("run_id").t_cens.mean(),
        "contrib_finished": contrib.groupby("run_id").finished.mean(),
        "fr_mean_t": riders.groupby("run_id").t_cens.mean(),
        "fr_finished": riders.groupby("run_id").finished.mean(),
    })
    # Incentive: do contributors who upload faster finish sooner? Negative rho = yes.
    hetero_ids = set(runs.run_id[runs.heterogeneity > 0])
    rho_peers = contrib[contrib.run_id.isin(hetero_ids)]
    per_run["upload_rho"] = rho_peers.groupby("run_id")[["sampled_upload_mbps", "t_cens"]].apply(
        lambda d: d.sampled_upload_mbps.corr(d.t_cens, method="spearman")
        if d.t_cens.nunique() > 1 and d.sampled_upload_mbps.nunique() > 1 else np.nan)
    per_run["fr_slowdown"] = per_run.fr_mean_t / per_run.contrib_mean_t

    runs = runs.merge(per_run, left_on="run_id", right_index=True, how="left")
    return runs, peers, deadline


def select_models(runs, hybrid_alpha):
    """Rows for the three-way comparison: prop, unchoke and one chosen hybrid setting."""
    alpha_s, alpha_b = hybrid_alpha
    hybrid = runs.policy.eq("hybrid") & np.isclose(runs.alpha_s, alpha_s) & np.isclose(runs.alpha_b, alpha_b)
    if runs.policy.eq("hybrid").any() and not hybrid.any():
        options = runs[runs.policy.eq("hybrid")][["alpha_s", "alpha_b"]].drop_duplicates()
        listed = ", ".join(f"{s:g}:{b:g}" for s, b in options.itertuples(index=False))
        sys.exit(f"No hybrid runs with alpha_s={alpha_s:g}, alpha_b={alpha_b:g}. Available: {listed}")
    cmp = runs[runs.policy.isin(["prop", "unchoke"]) | hybrid].copy()
    cmp["model"] = cmp.policy
    models = [m for m in MODEL_ORDER if m in set(cmp.model)]
    missing = [MODEL_NAMES[m] for m in MODEL_ORDER if m not in models]
    if missing:
        print(f"warning: no runs for {', '.join(missing)}; those comparisons are skipped. "
              "Re-run scripts/run-batch.js with all three policies.", file=sys.stderr)
    return cmp, models


def summarise(df, keys, col):
    out = df.groupby(keys)[col].agg(mean="mean", sd="std", n="count").reset_index()
    dof = (out.n - 1).clip(lower=1)
    out["ci"] = np.where(out.n > 1, stats.t.ppf(0.975, dof) * out.sd / np.sqrt(out.n), np.nan)
    return out


def condition_order(runs):
    conds = runs[["condition", "condition_label", "churn_enabled", "heterogeneity", "free_rider_count"]]
    return conds.drop_duplicates("condition").sort_values(
        ["churn_enabled", "heterogeneity", "free_rider_count"]).reset_index(drop=True)


def find_condition(order, churn, heterogeneity, free_riders):
    match = order[(order.churn_enabled == churn) & np.isclose(order.heterogeneity, heterogeneity)
                  & (order.free_rider_count == free_riders)]
    return None if match.empty else match.iloc[0]


def key_conditions(order):
    """Up to four contrasting conditions for the per-condition figures."""
    het_max = order.heterogeneity.max()
    fr = sorted(order.free_rider_count.unique())
    fr_mid = fr[len(fr) // 2] if fr else 0
    wanted = [(False, 0, 0), (False, het_max, 0), (False, 0, fr_mid), (True, het_max, fr_mid)]
    picked = []
    for args in wanted:
        row = find_condition(order, *args)
        if row is not None and row.condition not in [p.condition for p in picked]:
            picked.append(row)
    return picked


# --------------------------------------------------------------------------- figure helpers

def model_handles(models):
    return [Line2D([], [], color=MODEL_COLOURS[m], marker=MODEL_MARKERS[m], lw=1.8, label=MODEL_NAMES[m])
            for m in models]


def churn_text(churn):
    return "churn" if churn else "no churn"


def save(fig, out, name, fmt):
    """Render to a temporary file, then swap it into place. On Windows an image viewer, indexer or
    antivirus scan can briefly hold an existing figure open, so retry the swap for a few seconds."""
    path = out / f"{name}.{fmt}"
    temp = out / f".{name}.{os.getpid()}.tmp.{fmt}"
    fig.savefig(temp, dpi=200, bbox_inches="tight")
    plt.close(fig)
    for attempt in range(20):
        try:
            os.replace(temp, path)
            break
        except OSError:
            if attempt == 19:
                temp.unlink(missing_ok=True)
                raise
            time.sleep(0.25)
    print(f"  {path}")


def condition_grid(cmp, models, col, *, title, ylabel, x="free_rider_pct", xlabel="Free riders (% of leechers)",
                   rows="churn_enabled", cols="heterogeneity", ref=None, ylim=None, percent=False, data=None):
    """Small multiples: one panel per (churn, heterogeneity) cell, one line per model, 95% CI band."""
    data = cmp if data is None else data
    row_vals = sorted(data[rows].unique())
    col_vals = sorted(data[cols].unique())
    fig, axes = plt.subplots(len(row_vals), len(col_vals), sharex=True, sharey=True, squeeze=False,
                             figsize=(3.3 * len(col_vals) + 0.4, 2.7 * len(row_vals) + 0.9), layout="constrained")
    s = summarise(data, [rows, cols, x, "model"], col)
    scale = 100 if percent else 1
    for i, rv in enumerate(row_vals):
        for j, cv in enumerate(col_vals):
            ax = axes[i][j]
            if ref is not None:
                ax.axhline(ref * scale, color=INK_3, lw=0.9, zorder=1)
            for m in models:
                d = s[(s[rows] == rv) & (s[cols] == cv) & (s.model == m)].sort_values(x)
                if d.empty:
                    continue
                ax.fill_between(d[x], (d["mean"] - d.ci) * scale, (d["mean"] + d.ci) * scale,
                                color=MODEL_COLOURS[m], alpha=0.14, lw=0, zorder=2)
                ax.plot(d[x], d["mean"] * scale, color=MODEL_COLOURS[m], marker=MODEL_MARKERS[m], zorder=3,
                        markeredgecolor=SURFACE, markeredgewidth=0.8)
            label_r = churn_text(rv) if rows == "churn_enabled" else f"{rv}"
            label_c = f"upload h = {cv:g}" if cols == "heterogeneity" else f"{cv:g}% free riders"
            ax.set_title(f"{label_c} · {label_r}", loc="left")
            if j == 0:
                ax.set_ylabel(ylabel)
            if i == len(row_vals) - 1:
                ax.set_xlabel(xlabel)
            ax.set_xticks(sorted(data[x].unique()))
            if ylim:
                ax.set_ylim(*ylim)
    fig.suptitle(title, x=0.01, ha="left")
    fig.legend(handles=model_handles(models), loc="outside lower center", ncol=len(models))
    return fig


# --------------------------------------------------------------------------- figures

def fig_completion(cmp, models, deadline, hybrid_name):
    return condition_grid(
        cmp, models, "mean_t", ylabel="Mean completion time (s)",
        title=f"Mean peer completion time · {hybrid_name}\n"
              f"Unfinished peers counted at the {deadline:g} s deadline; bands are 95% CIs across seeds")


def fig_finished(cmp, models, deadline, hybrid_name):
    return condition_grid(
        cmp, models, "finished", ylabel="Peers finished (%)", percent=True, ylim=(0, 104),
        title=f"Share of leechers that finished within {deadline:g} s · {hybrid_name}\n"
              "Bands are 95% CIs across seeds")


def fig_cdf(peers, cmp, models, order, deadline, hybrid_name):
    conds = key_conditions(order)
    fig, axes = plt.subplots(1, len(conds), sharey=True, squeeze=False, figsize=(3.4 * len(conds) + 0.4, 3.3),
                             layout="constrained")
    for ax, cond in zip(axes[0], conds):
        for m in models:
            ids = cmp.run_id[(cmp.condition == cond.condition) & (cmp.model == m)]
            p = peers[peers.run_id.isin(ids)]
            if p.empty:
                continue
            t = np.sort(p.completion_time_s.dropna().to_numpy())
            y = np.arange(1, len(t) + 1) / len(p) * 100
            ax.step(np.r_[0, t, deadline], np.r_[0, y, y[-1] if len(y) else 0], where="post",
                    color=MODEL_COLOURS[m], label=MODEL_NAMES[m])
            if len(t):  # marker at the end of each curve keeps identity off colour alone
                ax.plot(t[-1], y[-1], marker=MODEL_MARKERS[m], color=MODEL_COLOURS[m],
                        markeredgecolor=SURFACE, markeredgewidth=0.8)
        ax.set_title(cond.condition_label, loc="left")
        ax.set_xlim(0, deadline)
        ax.set_ylim(0, 104)
        ax.set_xlabel("Time (s)")
    axes[0][0].set_ylabel("Leechers finished (%)")
    fig.suptitle(f"Download completion over time · {hybrid_name}\nPeers pooled across seeds; curves that stop below 100% have unfinished peers", x=0.01, ha="left")
    fig.legend(handles=model_handles(models), loc="outside lower center", ncol=len(models))
    return fig


def fig_free_riders(cmp, models, deadline, hybrid_name):
    data = cmp[cmp.free_rider_count > 0]
    if data.empty:
        return None
    return condition_grid(
        cmp, models, "fr_slowdown", data=data, ref=1.0,
        ylabel="Free-rider time ÷ contributor time",
        title=f"Free-rider penalty · {hybrid_name}\nFree-rider mean completion time ÷ contributor mean "
              f"(higher = free riding punished more; capped by the {deadline:g} s deadline)")


def fig_incentive(cmp, models, hybrid_name):
    data = cmp[cmp.heterogeneity > 0]
    if data.empty:
        return None
    return condition_grid(
        cmp, models, "upload_rho", data=data, x="heterogeneity", xlabel="Upload heterogeneity h",
        rows="churn_enabled", cols="free_rider_pct", ref=0.0, ylim=(-1, 1),
        ylabel="Spearman ρ (upload vs completion)",
        title=f"Reward for contribution · {hybrid_name}\nSpearman correlation between a contributor's upload "
              "rate and completion time (more negative = faster uploaders finish sooner)")


def fig_scatter(peers, cmp, models, deadline, hybrid_name):
    het = cmp.heterogeneity.max()
    base = cmp[(cmp.heterogeneity == het) & ~cmp.churn_enabled & (cmp.free_rider_count == 0)]
    if het == 0 or base.empty:
        return None
    fig, axes = plt.subplots(1, len(models), sharex=True, sharey=True, squeeze=False,
                             figsize=(3.4 * len(models) + 0.4, 3.3), layout="constrained")
    for ax, m in zip(axes[0], models):
        runs_m = base[base.model == m]
        p = peers[peers.run_id.isin(runs_m.run_id)]
        ax.scatter(p.sampled_upload_mbps, p.t_cens, s=10, color=MODEL_COLOURS[m], alpha=0.45, lw=0,
                   marker=MODEL_MARKERS[m])
        if len(p) > 2:
            slope, intercept = np.polyfit(p.sampled_upload_mbps, p.t_cens, 1)
            xs = np.linspace(p.sampled_upload_mbps.min(), p.sampled_upload_mbps.max(), 2)
            ax.plot(xs, slope * xs + intercept, color=INK, lw=1.2)
        ax.axhline(deadline, color=INK_3, lw=0.9)
        ax.set_title(MODEL_NAMES[m], loc="left")
        ax.text(0.98, 0.96, f"mean ρ = {runs_m.upload_rho.mean():.2f}", transform=ax.transAxes,
                ha="right", va="top", color=INK_2)
        ax.set_xlabel("Peer upload capacity (Mbps)")
    axes[0][0].set_ylabel("Completion time (s)")
    fig.suptitle(f"Upload capacity vs completion time · {hybrid_name}\nUpload h = {het:g}, no churn, "
                 "no free riders; peers pooled across seeds, line is a least-squares fit", x=0.01, ha="left")
    return fig


def draw_sweep(ax, runs, hyb, condition):
    """One panel of the hybrid alpha sweep: three sweep lines (sharing the alpha = 0 point) and
    dashed reference lines for propshare and unchoke."""
    shared = hyb[hyb.sweep.eq("shared") & (hyb.condition == condition)]
    for sweep in SWEEP_ORDER:
        d = pd.concat([shared, hyb[(hyb.condition == condition) & hyb.sweep.eq(sweep)]])
        s = summarise(d.assign(a=d.alpha.fillna(0)), ["a"], "mean_t").sort_values("a")
        st = SWEEP_STYLES[sweep]
        ax.fill_between(s.a, s["mean"] - s.ci, s["mean"] + s.ci, color=st["color"], alpha=0.07, lw=0)
        ax.plot(s.a, s["mean"], color=st["color"], marker=st["marker"], markeredgecolor=SURFACE,
                markeredgewidth=0.8)
    for m in ("prop", "unchoke"):
        ref = runs[(runs.condition == condition) & runs.policy.eq(m)].mean_t
        if not ref.empty:  # identified by the legend; in-panel labels collided with the sweep lines
            ax.axhline(ref.mean(), color=MODEL_COLOURS[m], lw=1.4, ls=(0, (4, 2)))
    alphas = sorted(hyb.alpha.dropna().unique())
    ax.set_xticks(alphas, [f"{a:g}" for a in alphas])


def sweep_handles(models):
    handles = [Line2D([], [], color=SWEEP_STYLES[s]["color"], marker=SWEEP_STYLES[s]["marker"],
                      label=f"Hybrid {s}") for s in SWEEP_ORDER]
    return handles + [Line2D([], [], color=MODEL_COLOURS[m], ls=(0, (4, 2)), label=MODEL_NAMES[m])
                      for m in ("prop", "unchoke") if m in models]


SWEEP_SUBTITLE = r"Selection-only varies $\alpha_s$, allocation-only varies $\alpha_b$, combined varies both"


def fig_hybrid_sweep(runs, order, models):
    hyb = runs[runs.policy.eq("hybrid")]
    if hyb.empty:
        return None
    conds = key_conditions(order)
    fig, axes = plt.subplots(1, len(conds), squeeze=False, figsize=(3.4 * len(conds) + 0.4, 3.4),
                             layout="constrained")
    for ax, cond in zip(axes[0], conds):
        draw_sweep(ax, runs, hyb, cond.condition)
        ax.set_title(cond.condition_label, loc="left")
        ax.set_xlabel(r"$\alpha$")
    axes[0][0].set_ylabel("Mean completion time (s)")
    fig.suptitle(r"Hybrid $\alpha$ sweep against the reference policies (dashed), selected conditions" "\n"
                 + SWEEP_SUBTITLE, x=0.01, ha="left")
    handles = sweep_handles(models)
    fig.legend(handles=handles, loc="outside lower center", ncol=len(handles))
    return fig


def fig_hybrid_sweep_grid(runs, order, models):
    """The same sweep for every condition: rows are (churn, upload h), columns are free-rider shares.
    Each panel has its own y-axis, because completion times differ several-fold between conditions."""
    hyb = runs[runs.policy.eq("hybrid")]
    if hyb.empty:
        return None
    row_keys = order[["churn_enabled", "heterogeneity"]].drop_duplicates().itertuples(index=False)
    row_keys = list(row_keys)
    fr_counts = sorted(order.free_rider_count.unique())
    fr_pct = runs.drop_duplicates("free_rider_count").set_index("free_rider_count").free_rider_pct
    fig, axes = plt.subplots(len(row_keys), len(fr_counts), squeeze=False, sharex=True,
                             figsize=(3.1 * len(fr_counts) + 0.6, 2.3 * len(row_keys) + 1.2),
                             layout="constrained")
    for i, (churn, het) in enumerate(row_keys):
        for j, fr in enumerate(fr_counts):
            ax = axes[i][j]
            cond = find_condition(order, churn, het, fr)
            if cond is None:
                ax.set_visible(False)
                continue
            draw_sweep(ax, runs, hyb, cond.condition)
            if i == 0:
                ax.set_title(f"{fr_pct[fr]}% free riders", loc="left")
            if j == 0:
                ax.set_ylabel(f"h = {het:g} · {churn_text(churn)}\nmean completion (s)")
            if i == len(row_keys) - 1:
                ax.set_xlabel(r"$\alpha$")
    fig.suptitle(r"Hybrid $\alpha$ sweep in every condition, against the reference policies (dashed)" "\n"
                 + SWEEP_SUBTITLE + "; each panel has its own y-axis", x=0.01, ha="left")
    handles = sweep_handles(models)
    fig.legend(handles=handles, loc="outside lower center", ncol=len(handles))
    return fig


# --------------------------------------------------------------------------- hybrid settings vs unchoke

# metric: (axis label, how the per-seed difference is expressed, which direction is better)
SETTING_METRICS = {
    "mean_t": ("Δ mean completion time (%)", "pct", "lower"),
    "finished": ("Δ peers finished (pp)", "pp", "higher"),
    "fr_slowdown": ("Δ free-rider slowdown (×)", "ratio", "higher"),
    "upload_rho": ("Δ upload–completion ρ", "rho", "lower"),
}
SETTING_UNITS = {"pct": "% of unchoke", "pp": "percentage points", "ratio": "ratio", "rho": "Spearman rho"}
SHARED_STYLE = {"color": INK_3, "marker": "o"}
GROUP_NAMES = {"shared": r"$\alpha$ = 0", "selection-only": r"Selection-only ($\alpha_s$)",
               "allocation-only": r"Allocation-only ($\alpha_b$)", "combined": r"Combined ($\alpha_s = \alpha_b$)"}


def setting_key(alpha_s, alpha_b):
    return f"{alpha_s:g}:{alpha_b:g}"


def hybrid_settings(runs):
    """One row per hybrid setting in display order: alpha = 0, then each sweep by increasing alpha."""
    hyb = runs[runs.policy.eq("hybrid")]
    s = hyb[["sweep", "alpha", "alpha_s", "alpha_b"]].drop_duplicates(["alpha_s", "alpha_b"])
    rank = {"shared": -1, **{name: i for i, name in enumerate(SWEEP_ORDER)}}
    s = s.assign(rank=s.sweep.map(rank)).sort_values(["rank", "alpha"]).reset_index(drop=True)
    s["key"] = [setting_key(a, b) for a, b in zip(s.alpha_s, s.alpha_b)]
    names = {"selection-only": r"selection $\alpha_s$", "allocation-only": r"allocation $\alpha_b$",
             "combined": r"combined $\alpha$"}
    s["label"] = [r"$\alpha$ = 0" if sw == "shared" else f"{names.get(sw, sw)} = {a:g}"
                  for sw, a in zip(s.sweep, s.alpha)]
    return s


def setting_differences(runs):
    """Per (setting, condition, seed) difference between each hybrid setting and unchoke on the same seed."""
    ref = runs[runs.policy.eq("unchoke")].set_index(["condition", "seed"])[list(SETTING_METRICS)]
    hyb = runs[runs.policy.eq("hybrid")]
    hyb = hyb.assign(key=[setting_key(a, b) for a, b in zip(hyb.alpha_s, hyb.alpha_b)])
    hyb = hyb.join(ref, on=["condition", "seed"], rsuffix="_ref")
    out = hyb[["key", "condition", "seed"]].copy()
    for m, (_, kind, _) in SETTING_METRICS.items():
        a, b = hyb[m], hyb[f"{m}_ref"]
        out[m] = (a - b) / b * 100 if kind == "pct" else (a - b) * 100 if kind == "pp" else a - b
    return out


def setting_tests(diffs):
    """Wilcoxon signed-rank test of each setting against unchoke in each condition, Holm-corrected
    within each metric across every setting and condition."""
    rows = []
    for (key, cond), g in diffs.groupby(["key", "condition"]):
        for m in SETTING_METRICS:
            d = g[m].dropna()
            n = len(d)
            p = stats.wilcoxon(d).pvalue if n >= 2 and np.any(d != 0) else (np.nan if n < 2 else 1.0)
            ci = stats.t.ppf(0.975, n - 1) * d.std(ddof=1) / np.sqrt(n) if n > 1 else np.nan
            rows.append({"key": key, "condition": cond, "metric": m, "n_seeds": n,
                         "mean_diff": d.mean() if n else np.nan, "ci95": ci, "wilcoxon_p": p})
    tests = pd.DataFrame(rows)
    tests["p_holm"] = np.nan
    for _, idx in tests.groupby("metric").groups.items():
        tests.loc[idx, "p_holm"] = holm(tests.loc[idx, "wilcoxon_p"])
    return tests


def setting_overall(diffs):
    """Each setting's difference from unchoke averaged over conditions. Averaging within a seed first
    keeps the pairing, so the CI is across the seeds. Metrics that only exist in some conditions
    (free-rider slowdown, upload rho) average over the conditions where they are defined."""
    rows = []
    for key, g in diffs.groupby("key"):
        for m in SETTING_METRICS:
            per_seed = g.groupby("seed")[m].mean().dropna()
            n = len(per_seed)
            rows.append({"key": key, "metric": m, "n_seeds": n, "mean_diff": per_seed.mean(),
                         "ci95": stats.t.ppf(0.975, n - 1) * per_seed.std(ddof=1) / np.sqrt(n) if n > 1 else np.nan})
    return pd.DataFrame(rows)


def fig_settings_heatmap(tests, settings, order):
    t = tests[tests.metric.eq("mean_t")]
    table = t.pivot(index="condition", columns="key", values="mean_diff")
    sig = t.pivot(index="condition", columns="key", values="p_holm").lt(0.05)
    idx = [c for c in order.condition if c in table.index]
    cols = [k for k in settings.key if k in table.columns]
    values = table.loc[idx, cols].to_numpy(dtype=float)
    sig = sig.loc[idx, cols].to_numpy()
    lim = max(np.nanmax(np.abs(values)) if np.isfinite(values).any() else 1, 1e-9)
    labels = order.set_index("condition").condition_label

    fig, ax = plt.subplots(figsize=(3.6 + 0.66 * len(cols), 0.32 * len(idx) + 2.4), layout="constrained")
    im = ax.imshow(values, cmap=DIVERGING, aspect="auto", norm=TwoSlopeNorm(vcenter=0, vmin=-lim, vmax=lim))
    for (r, c), v in np.ndenumerate(values):
        if np.isfinite(v):
            ax.text(c, r, f"{v:+.1f}" + ("*" if sig[r, c] else ""), ha="center", va="center", fontsize=7.5,
                    fontweight="bold" if sig[r, c] else "normal",
                    color=INK if abs(v) < 0.6 * lim else SURFACE)
    by_key = settings.set_index("key")
    ax.set_xticks(range(len(cols)), [f"{by_key.alpha[k]:g}" for k in cols])
    ax.set_yticks(range(len(idx)), [labels[c] for c in idx])
    ax.xaxis.tick_top()
    ax.grid(False)
    for spine in ax.spines.values():
        spine.set_visible(False)
    # Group headers above the alpha ticks, and surface-coloured gaps between the sweep families.
    sweeps = [by_key.sweep[k] for k in cols]
    start = 0
    for i in range(1, len(cols) + 1):
        if i == len(cols) or sweeps[i] != sweeps[start]:
            ax.text((start + i - 1) / 2, -1.25, GROUP_NAMES.get(sweeps[start], sweeps[start]),
                    ha="center", va="bottom", fontsize=8.5, color=INK, fontweight="semibold")
            if i < len(cols):
                ax.axvline(i - 0.5, color=SURFACE, lw=3)
            start = i
    cbar = fig.colorbar(im, ax=ax, shrink=0.5, pad=0.01)
    cbar.set_ticks([-lim, 0, lim], labels=["faster", "same", "slower"])
    cbar.outline.set_visible(False)
    fig.suptitle("Every hybrid setting relative to unchoke reciprocity: Δ mean completion time (%)\n"
                 "Mean of per-seed paired differences; bold* = significant after Holm correction "
                 "(Wilcoxon, p < 0.05)", x=0.01, ha="left")
    return fig


def fig_settings_summary(overall, settings, highlight, prop_reference):
    metrics = [m for m in SETTING_METRICS if overall[overall.metric.eq(m)].mean_diff.notna().any()]
    keys = list(settings.key)
    by_key = settings.set_index("key")
    fig, axes = plt.subplots(1, len(metrics), sharey=True, squeeze=False,
                             figsize=(2.9 * len(metrics) + 2.2, 0.36 * len(keys) + 1.9), layout="constrained")
    y = np.arange(len(keys))
    for ax, m in zip(axes[0], metrics):
        d = overall[overall.metric.eq(m)].set_index("key").reindex(keys)
        ax.axvline(0, color=INK_3, lw=0.9, zorder=1)
        for yi, k in zip(y, keys):
            st = SWEEP_STYLES.get(by_key.sweep[k], SHARED_STYLE)
            ax.errorbar(d.mean_diff[k], yi, xerr=d.ci95[k], fmt=st["marker"], color=st["color"], ms=6,
                        elinewidth=1.4, capsize=0, markeredgecolor=SURFACE, markeredgewidth=0.8, zorder=3)
        label, _, better = SETTING_METRICS[m]
        ax.set_title(label, loc="left")
        ax.set_xlabel("better →" if better == "higher" else "← better", color=INK_2)
        ax.grid(axis="y", visible=False)
        for boundary in np.flatnonzero(by_key.sweep[keys].to_numpy()[1:] != by_key.sweep[keys].to_numpy()[:-1]):
            ax.axhline(boundary + 0.5, color=GRID, lw=0.8)
    ax0 = axes[0][0]
    ax0.set_yticks(y, list(by_key.label[keys]))
    ax0.invert_yaxis()
    for tick, k in zip(ax0.get_yticklabels(), keys):
        if k == highlight:
            tick.set_fontweight("bold")
    note = f"; propshare averages {prop_reference:+.1f}% completion time on the same scale" \
        if prop_reference is not None and np.isfinite(prop_reference) else ""
    fig.suptitle("Hybrid settings against unchoke reciprocity (0 line), averaged over all conditions\n"
                 f"95% CIs across seeds; bold label = setting used in figures 01–06 and 08{note}",
                 x=0.01, ha="left")
    return fig


def fig_heatmap(cmp, models, order, hybrid_name):
    if "unchoke" not in models or len(models) < 2:
        return None
    others = [m for m in models if m != "unchoke"]
    wide_t = cmp.pivot_table(index=["condition", "seed"], columns="model", values="mean_t")
    wide_f = cmp.pivot_table(index=["condition", "seed"], columns="model", values="finished")
    pct = pd.DataFrame({m: ((wide_t[m] - wide_t.unchoke) / wide_t.unchoke * 100).groupby("condition").mean()
                        for m in others})
    pp = pd.DataFrame({m: ((wide_f[m] - wide_f.unchoke) * 100).groupby("condition").mean() for m in others})
    labels = order.set_index("condition").condition_label
    idx = [c for c in order.condition if c in pct.index]
    pct, pp = pct.loc[idx], pp.loc[idx]

    fig, axes = plt.subplots(1, 2, figsize=(4.2 + 1.3 * len(others) * 2, 0.32 * len(idx) + 1.8),
                             layout="constrained", sharey=True)
    panels = [(axes[0], pct, "Δ mean completion time vs unchoke (%)", 1),
              (axes[1], pp, "Δ peers finished vs unchoke (pp)", -1)]
    for ax, table, title, better_sign in panels:
        values = table.to_numpy(dtype=float)
        lim = max(np.nanmax(np.abs(values)) if np.isfinite(values).any() else 1, 1e-9)
        # Colour by "better/worse" so blue always means an improvement over unchoke.
        im = ax.imshow(values * better_sign, cmap=DIVERGING, aspect="auto",
                       norm=TwoSlopeNorm(vcenter=0, vmin=-lim, vmax=lim))
        for (r, c), v in np.ndenumerate(values):
            if np.isfinite(v):
                ax.text(c, r, f"{v:+.1f}", ha="center", va="center", fontsize=7.5,
                        color=INK if abs(v) < 0.6 * lim else SURFACE)
        ax.set_xticks(range(len(table.columns)), [MODEL_NAMES[m] for m in table.columns])
        ax.set_yticks(range(len(idx)), [labels[c] for c in idx])
        ax.xaxis.tick_top()
        ax.grid(False)
        ax.set_title(title, loc="left", pad=22)
        for spine in ax.spines.values():
            spine.set_visible(False)
        cbar = fig.colorbar(im, ax=ax, shrink=0.6, pad=0.02)
        cbar.set_ticks([-lim, 0, lim], labels=["better", "same", "worse"])
        cbar.outline.set_visible(False)
    fig.suptitle(f"Each policy relative to unchoke reciprocity · {hybrid_name}\n"
                 "Mean of per-seed paired differences (each seed shares identical swarm inputs)",
                 x=0.01, ha="left")
    return fig


# --------------------------------------------------------------------------- tables

def plain_hybrid(name):
    return name.replace(r"$\alpha_s$", "alpha_s").replace(r"$\alpha_b$", "alpha_b")


def holm(pvals):
    p = np.asarray(pvals, dtype=float)
    out = np.full_like(p, np.nan)
    ok = np.isfinite(p)
    order = np.argsort(p[ok])
    ranked = p[ok][order] * (ok.sum() - np.arange(ok.sum()))
    adj = np.minimum(1, np.maximum.accumulate(ranked))
    vals = np.empty_like(adj)
    vals[order] = adj
    out[ok] = vals
    return out


def write_tables(cmp, models, order, out, hybrid_name):
    metrics = ["mean_t", "finished", "contrib_mean_t", "fr_mean_t", "fr_finished", "fr_slowdown", "upload_rho"]
    rows = []
    for (cond, model), g in cmp.groupby(["condition", "model"]):
        row = {"condition": cond, "model": model, "model_name": MODEL_NAMES[model], "n_seeds": g.seed.nunique()}
        for mtr in metrics:
            x = g[mtr].dropna()
            row[f"{mtr}_mean"] = x.mean() if len(x) else np.nan
            row[f"{mtr}_ci95"] = (stats.t.ppf(0.975, len(x) - 1) * x.std(ddof=1) / np.sqrt(len(x))
                                  if len(x) > 1 else np.nan)
        rows.append(row)
    summary = pd.DataFrame(rows).merge(order, on="condition")
    summary["model_rank"] = summary.model.map({m: i for i, m in enumerate(MODEL_ORDER)})
    summary = summary.sort_values(["churn_enabled", "heterogeneity", "free_rider_count", "model_rank"])
    summary = summary.drop(columns="model_rank")
    summary.insert(3, "hybrid_setting", plain_hybrid(hybrid_name))
    summary.to_csv(out / "summary_by_condition.csv", index=False, float_format="%.4f")
    print(f"  {out / 'summary_by_condition.csv'}")

    pairs = [(a, b) for a, b in [("hybrid", "unchoke"), ("hybrid", "prop"), ("prop", "unchoke")]
             if a in models and b in models]
    tests = []
    for metric in ("mean_t", "finished"):
        wide = cmp.pivot_table(index=["condition", "seed"], columns="model", values=metric)
        for a, b in pairs:
            for cond, d in (wide[a] - wide[b]).dropna().groupby("condition"):
                n = len(d)
                if n >= 2 and np.any(d != 0):
                    p = stats.wilcoxon(d).pvalue
                else:
                    p = np.nan if n < 2 else 1.0
                ci = stats.t.ppf(0.975, n - 1) * d.std(ddof=1) / np.sqrt(n) if n > 1 else np.nan
                tests.append({"condition": cond, "metric": metric, "comparison": f"{a} - {b}", "n_seeds": n,
                              "mean_diff": d.mean(), "ci95": ci, "a_better_share": (d < 0).mean()
                              if metric == "mean_t" else (d > 0).mean(), "wilcoxon_p": p})
    if not tests:
        return
    tests = pd.DataFrame(tests)
    tests["p_holm"] = np.nan
    for metric, idx in tests.groupby("metric").groups.items():
        tests.loc[idx, "p_holm"] = holm(tests.loc[idx, "wilcoxon_p"])
    tests = tests.merge(order[["condition", "condition_label"]], on="condition")
    tests.insert(0, "hybrid_setting", plain_hybrid(hybrid_name))
    tests.to_csv(out / "paired_tests.csv", index=False, float_format="%.5g")
    print(f"  {out / 'paired_tests.csv'}")


def write_setting_tables(tests, overall, settings, order, out):
    """Every hybrid setting against unchoke: per condition (with tests) and averaged over conditions."""
    cols = settings[["key", "sweep", "alpha_s", "alpha_b"]]
    units = {m: SETTING_UNITS[kind] for m, (_, kind, _) in SETTING_METRICS.items()}
    better = {m: b for m, (_, _, b) in SETTING_METRICS.items()}

    per_cond = cols.merge(tests, on="key").merge(order[["condition", "condition_label"]], on="condition")
    per_cond.insert(per_cond.columns.get_loc("metric") + 1, "unit", per_cond.metric.map(units))
    per_cond.insert(per_cond.columns.get_loc("unit") + 1, "better", per_cond.metric.map(better))
    per_cond["significant"] = per_cond.p_holm.lt(0.05)
    per_cond.drop(columns="key").to_csv(out / "hybrid_settings_tests.csv", index=False, float_format="%.5g")
    print(f"  {out / 'hybrid_settings_tests.csv'}")

    sig_counts = per_cond[per_cond.significant].assign(
        improved=lambda d: np.where(d.better.eq("lower"), d.mean_diff < 0, d.mean_diff > 0))
    counts = sig_counts.groupby(["key", "metric"]).improved.agg(
        sig_better="sum", sig_worse=lambda x: int((~x).sum())).reset_index()
    summary = cols.merge(overall, on="key").merge(counts, on=["key", "metric"], how="left")
    summary[["sig_better", "sig_worse"]] = summary[["sig_better", "sig_worse"]].fillna(0).astype(int)
    summary["conditions_tested"] = summary.metric.map(
        per_cond.dropna(subset=["mean_diff"]).groupby("metric").condition.nunique())
    summary.insert(summary.columns.get_loc("metric") + 1, "unit", summary.metric.map(units))
    summary.insert(summary.columns.get_loc("unit") + 1, "better", summary.metric.map(better))
    summary.drop(columns="key").to_csv(out / "hybrid_settings_summary.csv", index=False, float_format="%.5g")
    print(f"  {out / 'hybrid_settings_summary.csv'}")


# --------------------------------------------------------------------------- main

def parse_alpha(text):
    try:
        alpha_s, alpha_b = (float(v) for v in text.split(":"))
    except ValueError:
        raise argparse.ArgumentTypeError("expected ALPHA_S:ALPHA_B, e.g. 0.5:0.5") from None
    return alpha_s, alpha_b


def main():
    for stream in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252, which lacks α
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--results", type=Path, default=Path("results"),
                        help="directory with runs.csv, peers.csv, metadata.json (default: results)")
    parser.add_argument("--out", type=Path, help="output directory (default: RESULTS/figures)")
    parser.add_argument("--hybrid", type=parse_alpha, default=(0.5, 0.5), metavar="ALPHA_S:ALPHA_B",
                        help="hybrid setting used in the three-way comparison (default: 0.5:0.5)")
    parser.add_argument("--format", default="png", choices=["png", "pdf", "svg"])
    args = parser.parse_args()
    out = args.out or args.results / "figures"
    out.mkdir(parents=True, exist_ok=True)

    runs, peers, deadline = load(args.results)
    cmp, models = select_models(runs, args.hybrid)
    order = condition_order(runs)
    hybrid_name = rf"hybrid $\alpha_s$ = {args.hybrid[0]:g}, $\alpha_b$ = {args.hybrid[1]:g}"
    print(f"Loaded {len(runs)} runs, {len(peers)} peer rows; comparing {', '.join(MODEL_NAMES[m] for m in models)} "
          f"(hybrid alpha_s={args.hybrid[0]:g}, alpha_b={args.hybrid[1]:g}) across {cmp.seed.nunique()} seeds.")

    figures = [
        ("01_completion_time", lambda: fig_completion(cmp, models, deadline, hybrid_name)),
        ("02_finished_fraction", lambda: fig_finished(cmp, models, deadline, hybrid_name)),
        ("03_completion_cdf", lambda: fig_cdf(peers, cmp, models, order, deadline, hybrid_name)),
        ("04_free_rider_penalty", lambda: fig_free_riders(cmp, models, deadline, hybrid_name)),
        ("05_contribution_reward", lambda: fig_incentive(cmp, models, hybrid_name)),
        ("06_upload_vs_completion", lambda: fig_scatter(peers, cmp, models, deadline, hybrid_name)),
        ("07_hybrid_alpha_sweep", lambda: fig_hybrid_sweep(runs, order, models)),
        ("08_relative_to_unchoke", lambda: fig_heatmap(cmp, models, order, hybrid_name)),
        ("09_hybrid_sweep_all_conditions", lambda: fig_hybrid_sweep_grid(runs, order, models)),
    ]

    # Every hybrid setting against unchoke (needs both in the batch).
    has_settings = runs.policy.eq("hybrid").any() and runs.policy.eq("unchoke").any()
    if has_settings:
        settings = hybrid_settings(runs)
        diffs = setting_differences(runs)
        tests = setting_tests(diffs)
        overall = setting_overall(diffs)
        prop_reference = None
        if runs.policy.eq("prop").any():
            ref = runs[runs.policy.eq("unchoke")].set_index(["condition", "seed"]).mean_t
            prop = runs[runs.policy.eq("prop")].set_index(["condition", "seed"]).mean_t
            prop_reference = ((prop - ref) / ref * 100).groupby("seed").mean().mean()
        highlight = setting_key(*args.hybrid)
        figures += [
            ("10_hybrid_settings_vs_unchoke", lambda: fig_settings_heatmap(tests, settings, order)),
            ("11_hybrid_settings_summary",
             lambda: fig_settings_summary(overall, settings, highlight, prop_reference)),
        ]
    else:
        print("  skipped 10_hybrid_settings_vs_unchoke, 11_hybrid_settings_summary (need hybrid and unchoke runs)")

    for name, build in figures:
        fig = build()
        if fig is None:
            print(f"  skipped {name} (not enough data)")
        else:
            save(fig, out, name, args.format)
    write_tables(cmp, models, order, out, hybrid_name)
    if has_settings:
        write_setting_tables(tests, overall, settings, order, out)


if __name__ == "__main__":
    main()
