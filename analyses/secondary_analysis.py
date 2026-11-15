#!/usr/bin/env python3
"""Held-out evaluation of globally and swarm-specifically selected Hybrid vs baselines.

Example:
 python secondary_analysis.py /path/to/evaluation-set --selection tuning_analysis --out evaluation_analysis

The selection folder must contain global_optimum.csv and condition_optima.csv
written by primary_analysis.py. It NEVER reselects parameters on evaluation data.
Primary response: restricted mean across peers of min(completion_time, deadline); unfinished
peers contribute the deadline. Report completion rate separately.
"""
from __future__ import annotations
import argparse
import warnings
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
import statsmodels.formula.api as smf
from scipy import stats
from statsmodels.stats.multitest import multipletests

sns.set_theme(style='whitegrid',context='paper',font_scale=1.12)
FACTORS=['heterogeneity','churn_enabled','free_rider_ratio']
STRATEGIES=['Hybrid global','Hybrid swarm-specific','BitTorrent','PropShare']

def read_data(source: Path):
    """Read runs.csv and peers.csv directly from the specified directory."""
    if not source.is_dir():
        raise NotADirectoryError(f'Expected a directory, got {source}')
    for filename in ('runs.csv','peers.csv'):
        if not (source/filename).is_file():
            raise FileNotFoundError(source/filename)
    return pd.read_csv(source/'runs.csv'),pd.read_csv(source/'peers.csv')


def prepare(source):
    runs,peers=read_data(source)
    if runs.run_id.duplicated().any():raise ValueError('Duplicate run_id')
    p=peers[['run_id','peer_id','completion_time_s']].merge(
        runs[['run_id','deadline_s']],on='run_id',validate='many_to_many')
    if p.duplicated(['run_id','peer_id']).any():raise ValueError('Duplicate peer_id within run')
    p['capped_time_s']=p.completion_time_s.fillna(p.deadline_s).clip(upper=p.deadline_s)
    agg=p.groupby('run_id').agg(capped_mean_s=('capped_time_s','mean'),
                                peers_recorded=('peer_id','size'),
                                completed=('completion_time_s','count')).reset_index()
    d=runs.merge(agg,on='run_id',validate='one_to_one')
    if not d.peers_recorded.eq(d.initial_leechers).all():raise ValueError('Missing peer rows')
    if not d.completed.eq(d.finished_count).all():raise ValueError('Completion count mismatch')
    d['churn_enabled']=d.churn_enabled.astype(bool)
    d['scenario']=d.condition.astype(str)+':'+d.seed.astype(str)
    return d

def select(d, selections):
    glob=pd.read_csv(selections/'global_optimum.csv').iloc[0]
    local=pd.read_csv(selections/'condition_optima.csv')
    if local.condition.duplicated().any():raise ValueError('Duplicate tuning conditions')
    if set(d.condition.unique())-set(local.condition):raise ValueError('Missing tuning-selected conditions')
    arms=[]
    for name, subset in [('PropShare',d[d.policy.eq('prop')]),
                         ('BitTorrent',d[d.policy.eq('unchoke')])]:
        z=subset.copy();z['strategy']=name;arms.append(z)
    hybrid=d[d.policy.eq('hybrid')].copy()
    z=hybrid[np.isclose(hybrid.alpha_s,float(glob.alpha_s)) &
             np.isclose(hybrid.alpha_b,float(glob.alpha_b))].copy()
    z['strategy']='Hybrid global';arms.append(z)
    pairs=local[['condition','alpha_s','alpha_b']].rename(
        columns={'alpha_s':'selected_alpha_s','alpha_b':'selected_alpha_b'})
    z=hybrid.merge(pairs,on='condition',validate='many_to_one')
    z=z[np.isclose(z.alpha_s,z.selected_alpha_s)&np.isclose(z.alpha_b,z.selected_alpha_b)].copy()
    z['strategy']='Hybrid swarm-specific';arms.append(z)
    selected=pd.concat(arms,ignore_index=True)
    if selected.duplicated(['condition','seed','strategy']).any():
        raise ValueError('Multiple selected arms per matched scenario')
    expected=d[['condition','seed']].drop_duplicates().shape[0]
    counts=selected.groupby('strategy').size().to_dict()
    if any(counts.get(s,0)!=expected for s in STRATEGIES):
        raise ValueError(f'Incomplete selected arms: expected {expected} each; got {counts}')
    checksum=selected.groupby('scenario').scenario_sha256.nunique()
    if (checksum>1).any():
        warnings.warn('Some algorithms have different scenario_sha256 in matched scenario IDs')
    return selected

def summary_table(d):
    return d.groupby('strategy',as_index=False).agg(n=('capped_mean_s','size'),
        mean_capped_s=('capped_mean_s','mean'),sd_capped_s=('capped_mean_s','std'),
        mean_finished_fraction=('finished_fraction','mean'),
        complete_swarm_fraction=('swarm_finished','mean'),
        complete_only_mean_s=('t_avg_s','mean'))

def paired(d, keys, left, right, metric="capped_mean_s"):
    p=d.pivot(index=keys,columns='strategy',values=metric)
    if p[[left,right]].isna().any().any():raise ValueError('Missing matched strategy observations')
    diff=p[left]-p[right]
    # Negative differences favour the strategy in `left` (less time is better).
    n=len(diff);avg=diff.mean();sd=diff.std(ddof=1)
    sem=sd/np.sqrt(n) if n>1 else np.nan
    ci=(avg,avg) if n>1 and sd==0 else (stats.t.interval(.95,df=n-1,loc=avg,scale=sem) if n>1 else (np.nan,np.nan))
    pval=stats.ttest_1samp(diff,0).pvalue if n>1 and sd>0 else (1.0 if avg==0 else np.nan)
    return {'n_paired':n,'mean_difference_s':avg,'ci_low_s':ci[0], 'ci_high_s':ci[1],
            'paired_t_pvalue':pval,'mean_left_s':p[left].mean(),
            'mean_right_s':p[right].mean(),
            'relative_improvement_pct':100*(p[right].mean()-p[left].mean())/p[right].mean() if p[right].mean()!=0 else np.nan}

def kaplan_meier_curve(peers: pd.DataFrame) -> tuple[np.ndarray,np.ndarray]:
    """Empirical KM unfinished-peer proportion; censor at common deadline.

    Plot only point estimates: treating peers as independent for confidence bands
    would underestimate uncertainty because peers share simulation runs.
    """
    time=peers['time_s'].to_numpy(dtype=float)
    event=peers['event'].to_numpy(dtype=bool)
    steps=np.sort(np.unique(time[event]))
    probability=1.0
    x=[0.0];y=[1.0]
    for t in steps:
        at_risk=np.count_nonzero(time>=t)
        completions=np.count_nonzero((time==t)&event)
        probability *= 1-completions/at_risk
        x.append(float(t));y.append(float(probability))
    x.append(float(peers['deadline_s'].iloc[0]));y.append(y[-1])
    return np.asarray(x),np.asarray(y)

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('evaluation_data',type=Path,help='Directory containing runs.csv and peers.csv')
    ap.add_argument('--selection',type=Path,required=True,help='Primary output directory')
    ap.add_argument('--out',type=Path,default=Path('evaluation_analysis'))
    args=ap.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    for file in ['global_optimum.csv','condition_optima.csv']:
        if not (args.selection/file).exists():raise FileNotFoundError(args.selection/file)
    raw=prepare(args.evaluation_data)
    d=select(raw,args.selection)
    # Load peer-level outcomes only for the four held-out selected strategies.
    _, peer_csv=read_data(args.evaluation_data)
    peer_events=peer_csv[['run_id','peer_id','completion_time_s']].merge(
        d[['run_id','strategy','condition','seed','deadline_s','free_rider_ratio']],
        on='run_id',validate='many_to_many')
    peer_events['event']=(peer_events.completion_time_s.notna() &
        (peer_events.completion_time_s<=peer_events.deadline_s)).astype(int)
    peer_events['time_s']=np.minimum(
        peer_events.completion_time_s.fillna(peer_events.deadline_s),peer_events.deadline_s)
    if peer_events.deadline_s.nunique()!=1:
        raise ValueError('Kaplan–Meier curves require a common deadline in this script')

    print(f'Evaluation: {len(raw):,} available runs, {d.seed.nunique()} seeds, '
          f'{d.condition.nunique()} swarms; {len(d):,} selected strategy-run rows')
    if d.seed.nunique()!=30:warnings.warn(f'Only {d.seed.nunique()} repetitions, not planned 30')
    print(f'Full completion: {d.swarm_finished.mean():.1%}; '
          f'original t_avg_s absent: {d.t_avg_s.isna().sum():,} selected rows')
    d.to_csv(args.out/'selected_run_metrics.csv',index=False)
    overall=summary_table(d);overall.to_csv(args.out/'strategy_summary.csv',index=False)
    grouped=d.groupby(['condition',*FACTORS,'strategy'],as_index=False).agg(
        mean_capped_s=('capped_mean_s','mean'),sd_capped_s=('capped_mean_s','std'),
        mean_finished_fraction=('finished_fraction','mean'),
        complete_swarm_fraction=('swarm_finished','mean'))
    grouped.to_csv(args.out/'condition_strategy_summary.csv',index=False)

    # Overall balanced comparisons: average each strategy across conditions for
    # each matched seed, then use those 20 seed-block observations for inference.
    block=d.groupby(['seed','strategy'],as_index=False).capped_mean_s.mean()
    comparisons=[];condition_rows=[]
    for hybrid in ['Hybrid global','Hybrid swarm-specific']:
        for baseline in ['BitTorrent','PropShare']:
            res=paired(block,['seed'],hybrid,baseline)
            comparisons.append({'hybrid':hybrid,'baseline':baseline,**res})
            for cond,sub in d.groupby('condition'):
                r=paired(sub,['seed'],hybrid,baseline)
                factors=sub.iloc[0]
                condition_rows.append({'condition':cond,**{k:factors[k] for k in FACTORS},
                                       'hybrid':hybrid,'baseline':baseline,**r})
    overall_cmp=pd.DataFrame(comparisons)
    overall_cmp['holm_pvalue']=multipletests(overall_cmp.paired_t_pvalue.fillna(1),method='holm')[1]
    overall_cmp.to_csv(args.out/'overall_paired_comparisons.csv',index=False)
    # Paired comparison of completion fractions, *at the run/scenario level*.
    # Positive differences mean Hybrid completes a larger share of peers.
    finish_block=d.groupby(['seed','strategy'],as_index=False).finished_fraction.mean()
    rate_results=[];rate_cond=[]
    for hybrid in ['Hybrid global','Hybrid swarm-specific']:
        for baseline in ['BitTorrent','PropShare']:
            v=paired(finish_block,['seed'],hybrid,baseline,metric='finished_fraction')
            rate_results.append({'hybrid':hybrid,'baseline':baseline,**v})
            for condition,part in d.groupby('condition'):
                v=paired(part,['seed'],hybrid,baseline,metric='finished_fraction')
                rate_cond.append({'condition':condition,'hybrid':hybrid,
                                  'baseline':baseline,**v})
    rate_comparisons=pd.DataFrame(rate_results).rename(columns={
        'mean_difference_s':'mean_fraction_difference',
        'ci_low_s':'ci_low_fraction','ci_high_s':'ci_high_fraction',
        'mean_left_s':'mean_left_fraction','mean_right_s':'mean_right_fraction'})
    rate_comparisons['holm_pvalue']=multipletests(
        rate_comparisons.paired_t_pvalue.fillna(1),method='holm')[1]
    rate_comparisons.to_csv(args.out/'overall_completion_rate_comparisons.csv',index=False)
    rate_condition=pd.DataFrame(rate_cond).rename(columns={
        'mean_difference_s':'mean_fraction_difference',
        'ci_low_s':'ci_low_fraction','ci_high_s':'ci_high_fraction',
        'mean_left_s':'mean_left_fraction','mean_right_s':'mean_right_fraction'})
    rate_condition['holm_pvalue']=multipletests(
        rate_condition.paired_t_pvalue.fillna(1),method='holm')[1]
    rate_condition.to_csv(args.out/'condition_completion_rate_comparisons.csv',index=False)
    # Clustered regression of run-level completion fraction on strategy and conditions.
    rate_formula=('finished_fraction ~ C(strategy)*(C(heterogeneity)'
                  '+C(churn_enabled)+C(free_rider_ratio))')
    rate_model=smf.ols(rate_formula,d).fit(
        cov_type='cluster',cov_kwds={'groups':d.scenario})
    (args.out/'completion_rate_interaction_regression.txt').write_text(
        rate_model.summary().as_text(),encoding='utf-8')
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        rate_model.wald_test_terms(skip_single=False,scalar=True).table.to_csv(
            args.out/'completion_rate_interaction_wald_tests.csv')

    by_condition=pd.DataFrame(condition_rows)
    by_condition['holm_pvalue']=multipletests(by_condition.paired_t_pvalue.fillna(1),method='holm')[1]
    by_condition.to_csv(args.out/'condition_paired_comparisons.csv',index=False)

    # Interaction model: baseline/reference contrasts vary with the swarm factors.
    # Cluster by matched scenario because each has up to four correlated outcomes.
    d['strategy']=pd.Categorical(d.strategy,categories=STRATEGIES)
    f=('capped_mean_s ~ C(strategy)*(C(heterogeneity)+C(churn_enabled)+C(free_rider_ratio))')
    mdl=smf.ols(f,d).fit(cov_type='cluster',cov_kwds={'groups':d.scenario})
    (args.out/'algorithm_swarm_regression.txt').write_text(mdl.summary().as_text(),encoding='utf8')
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        terms=mdl.wald_test_terms(skip_single=False,scalar=True).table
    terms.to_csv(args.out/'algorithm_swarm_wald_tests.csv')
    ci=mdl.conf_int()
    pd.DataFrame({'term':mdl.params.index,'coefficient_s':mdl.params.values,
                  'ci_low_s':ci.iloc[:,0].values,'ci_high_s':ci.iloc[:,1].values,
                  'pvalue':mdl.pvalues.values}).to_csv(args.out/'algorithm_swarm_coefficients.csv',index=False)

    # Overall mean performance, with empirical 95% t intervals over seed blocks.
    means=block.groupby('strategy').capped_mean_s.agg(['mean','sem','count']).reindex(STRATEGIES)
    fig,ax=plt.subplots(figsize=(9,4.7));x=np.arange(len(means))
    tcrit=stats.t.ppf(.975,means['count']-1)
    ax.bar(x,means['mean'],color=sns.color_palette('Set2',len(means)))
    ax.errorbar(x,means['mean'],yerr=tcrit*means['sem'],fmt='none',color='black',capsize=4)
    ax.set_xticks(x,STRATEGIES,rotation=15,ha='right')
    ax.set(ylabel='Restricted mean completion time (s)',title='Held-out comparison (95% intervals over seeds)')
    fig.tight_layout();fig.savefig(args.out/'01_overall_strategy_comparison.png',dpi=200);plt.close(fig)

    # Forest plot: negative differences mean Hybrid is faster.
    subset=by_condition[(by_condition.hybrid=='Hybrid swarm-specific')]
    fig,axs=plt.subplots(1,2,figsize=(15,9),sharey=True)
    for ax,(baseline,part) in zip(axs,subset.groupby('baseline',sort=True)):
        part=part.sort_values(FACTORS).reset_index(drop=True)
        yy=np.arange(len(part))
        ax.errorbar(part.mean_difference_s,yy,
                    xerr=[part.mean_difference_s-part.ci_low_s,part.ci_high_s-part.mean_difference_s],
                    fmt='o',capsize=2,markersize=3)
        ax.axvline(0,ls='--',color='gray');ax.set_title(f'Hybrid swarm-specific − {baseline}')
        ax.set_xlabel('Mean paired difference (s); negative favours Hybrid')
        ax.set_yticks(yy,part.condition,fontsize=8)
    fig.tight_layout();fig.savefig(args.out/'02_condition_forest.png',dpi=200);plt.close(fig)

    # Small-multiple factor comparisons with all four strategies.
    fig,axs=plt.subplots(1,3,figsize=(18,5))
    for ax,factor in zip(axs,FACTORS):
        z=d.groupby([factor,'strategy'],observed=True,as_index=False).capped_mean_s.mean()
        sns.lineplot(data=z,x=factor,y='capped_mean_s',hue='strategy',hue_order=STRATEGIES,
                     marker='o',ax=ax)
        ax.set(ylabel='Restricted mean completion time (s)',title=f'By {factor}')
        if ax is not axs[0]:ax.legend_.remove()
    fig.tight_layout();fig.savefig(args.out/'03_strategy_by_factors.png',dpi=200);plt.close(fig)

    # Heatmap of relative improvement over baselines, 24 conditions x four pairs.
    z=by_condition.copy();z['comparison']=z.hybrid.str.replace('Hybrid ','',regex=False)+' vs '+z.baseline
    p=z.pivot(index='condition',columns='comparison',values='relative_improvement_pct')
    fig,ax=plt.subplots(figsize=(11,10))
    mx=max(1.0,float(np.nanmax(abs(p.to_numpy()))))
    sns.heatmap(p,annot=True,fmt='.1f',cmap='RdBu',center=0,vmin=-mx,vmax=mx,
                cbar_kws={'label':'Improvement over baseline (%)'},ax=ax)
    ax.set(xlabel='',ylabel='',title='Held-out relative improvement; positive favours Hybrid')
    fig.tight_layout();fig.savefig(args.out/'04_improvement_heatmap.png',dpi=200);plt.close(fig)

    # Direct assessment of held-out benefit from condition-specific tuning.
    tuning_gain=paired(block,['seed'],'Hybrid swarm-specific','Hybrid global')
    pd.DataFrame([tuning_gain]).to_csv(args.out/'heldout_swarm_specific_vs_global.csv',index=False)
    fig,ax=plt.subplots(figsize=(12,4))
    z=grouped[grouped.strategy.isin(['Hybrid global','Hybrid swarm-specific'])]
    pivot=z.pivot(index='condition',columns='strategy',values='mean_capped_s')
    gain=(pivot['Hybrid global']-pivot['Hybrid swarm-specific']).sort_values(ascending=False)
    gain.plot.bar(ax=ax,color='steelblue')
    ax.set(ylabel='Global minus swarm-specific (s)',xlabel='Swarm condition',
           title='Held-out benefit of swarm-specific tuning')
    fig.tight_layout();fig.savefig(args.out/'05_heldout_tuning_gain.png',dpi=200);plt.close(fig)

    # Kaplan–Meier curves: peer completion time distribution up to deadline.
    # CI omitted since peers within each simulation run are dependent.
    fig,ax=plt.subplots(figsize=(9,5.5))
    for strategy in STRATEGIES:
        group=peer_events[peer_events.strategy.eq(strategy)]
        x,y=kaplan_meier_curve(group)
        ax.step(x,100*y,where='post',label=strategy)
    ax.set(xlabel='Elapsed time (s)',ylabel='Peers not yet completed (%)',
           title='Kaplan–Meier unfinished-peer curves (held-out evaluation)',
           xlim=(0,float(peer_events.deadline_s.iloc[0])),ylim=(0,100))
    ax.legend();fig.tight_layout()
    fig.savefig(args.out/'06_kaplan_meier_overall.png',dpi=200);plt.close(fig)
    levels=sorted(peer_events.free_rider_ratio.unique())
    fig,axs=plt.subplots(1,len(levels),figsize=(5*len(levels),4.5),sharey=True,squeeze=False)
    for ax,level in zip(axs.flat,levels):
        for strategy in STRATEGIES:
            sub=peer_events[(peer_events.free_rider_ratio==level)&
                            peer_events.strategy.eq(strategy)]
            x,y=kaplan_meier_curve(sub)
            ax.step(x,100*y,where='post',label=strategy)
        ax.set_title(f'Free-rider ratio: {level:g}')
        ax.set_xlabel('Elapsed time (s)')
        ax.set_xlim(0,float(peer_events.deadline_s.iloc[0]));ax.set_ylim(0,100)
    axs[0,0].set_ylabel('Peers not yet completed (%)')
    axs[0,0].legend(fontsize=8)
    fig.suptitle('Kaplan–Meier curves by free-rider condition');fig.tight_layout()
    fig.savefig(args.out/'07_kaplan_meier_by_freerider.png',dpi=180);plt.close(fig)
    # Hold-out completion fractions by strategy and factor (run-level aggregation).
    fig,axs=plt.subplots(1,3,figsize=(18,4.8))
    for ax,factor in zip(axs,FACTORS):
        z=d.groupby([factor,'strategy'],observed=True,as_index=False).finished_fraction.mean()
        sns.lineplot(data=z,x=factor,y='finished_fraction',hue='strategy',
                     hue_order=STRATEGIES,marker='o',ax=ax)
        ax.set(title=f'Completion rate by {factor}',ylabel='Peer completion fraction',ylim=(0,1.02))
        if ax is not axs[0]:ax.legend_.remove()
    fig.tight_layout();fig.savefig(args.out/'08_completion_rate_by_factors.png',dpi=200)
    plt.close(fig)
    print('\nStrategy means (180-s restricted seconds):')
    print(overall[['strategy','mean_capped_s','mean_finished_fraction']].to_string(index=False))
    print('\nOverall matched differences (negative favours Hybrid):')
    print(overall_cmp[['hybrid','baseline','mean_difference_s','ci_low_s','ci_high_s']].to_string(index=False))
    print('Files written to',args.out.resolve())

if __name__=='__main__':
    main()
