import { STRATEGY_NAMES } from '../simulation/constants.js';

export const DEADLINE_SECONDS = 180;
export const SAMPLE_SECONDS = [0, 30, 60, 90, 120, 150, 180];
export const RECIPROCITY_LEVELS = [0, 0.25, 0.5, 0.75, 1];
export const METRICS = {
  meanTime: { label: 'Mean peer completion time', unit: 's' },
  completion: { label: 'Completion percentage', unit: '%' },
};

const valueAt = (times, values, second) => {
  let index = 0;
  while (index + 1 < times.length && times[index + 1] <= second + 1e-8) index += 1;
  return values[index];
};

export const adaptResult = (result, { id, alphaS = null, alphaB = null, family = null } = {}) => {
  const timesSeconds = result.times.map((minute) => minute * 60);
  const finalSecond = timesSeconds.at(-1);
  const extendedTimes = finalSecond < DEADLINE_SECONDS
    ? [...timesSeconds, DEADLINE_SECONDS] : timesSeconds.slice();
  const extendedDownloaded = finalSecond < DEADLINE_SECONDS
    ? [...result.averageCompletion, result.averageCompletion.at(-1)] : result.averageCompletion.slice();
  const extendedCompleted = finalSecond < DEADLINE_SECONDS
    ? [...result.completedPeers, result.completedPeers.at(-1)] : result.completedPeers.slice();
  const finishedTimesSeconds = result.completionTimesSeconds.filter((value) => value !== null);
  return {
    id: id ?? result.strategy,
    strategy: result.strategy,
    policyName: STRATEGY_NAMES[result.strategy],
    family,
    alphaS,
    alphaB,
    meanDownloadedPercent: result.finalCompletion,
    completed: result.completed,
    peerCount: result.peerCount,
    completionPercent: result.completionFraction * 100,
    firstFinishSeconds: result.firstFinishMinutes === null ? null : result.firstFinishMinutes * 60,
    fullSwarmFinishSeconds: result.swarmFinishSeconds,
    meanCompletedFinishSeconds: result.meanFinishMinutes === null ? null : result.meanFinishMinutes * 60,
    meanAllPeersFinishSeconds: result.meanAllPeersFinishSeconds,
    elapsedSeconds: result.elapsedSeconds,
    termination: result.termination,
    finishedTimesSeconds,
    unfinishedCount: result.peerCount - finishedTimesSeconds.length,
    series: {
      timesSeconds: extendedTimes,
      downloadedPercent: extendedDownloaded,
      completedPeers: extendedCompleted,
      sampledCompleted: SAMPLE_SECONDS.map((second) => valueAt(timesSeconds, result.completedPeers, second)),
    },
  };
};

export const adaptExperiment = (experiment) => ({
  mode: 'experiment',
  rows: experiment.results.map((result) => adaptResult(result, {
    alphaS: result.strategy === 'hybrid' ? experiment.config.alphaS : null,
    alphaB: result.strategy === 'hybrid' ? experiment.config.alphaB : null,
  })),
});

export const adaptSweep = (sweepResult) => ({
  mode: 'sweep',
  rows: sweepResult.repetitions[0].comparisons.map((comparison, index) => adaptResult(comparison.result, {
    id: comparison.family === 'reference' ? comparison.result.strategy : `hybrid:${comparison.alphaS}:${comparison.alphaB}`,
    alphaS: comparison.alphaS ?? null,
    alphaB: comparison.alphaB ?? null,
    family: comparison.family,
    index,
  })),
});

export const metricValue = (row, metric) => metric === 'meanTime'
  ? row.meanAllPeersFinishSeconds : row.completionPercent;

export const buildHeatmap = (rows, metric) => {
  const hybrids = new Map(rows.filter((row) => row.strategy === 'hybrid')
    .map((row) => [`${row.alphaS}:${row.alphaB}`, row]));
  return RECIPROCITY_LEVELS.map((alphaB) => RECIPROCITY_LEVELS.map((alphaS) => {
    const row = hybrids.get(`${alphaS}:${alphaB}`) ?? null;
    return { alphaS, alphaB, row, value: row ? metricValue(row, metric) : null };
  }));
};

export const bestHybrid = (rows) => rows.filter((row) => row.strategy === 'hybrid')
  .slice().sort((a, b) =>
    b.completionPercent - a.completionPercent ||
    (a.meanAllPeersFinishSeconds ?? Infinity) - (b.meanAllPeersFinishSeconds ?? Infinity) ||
    a.alphaS - b.alphaS || a.alphaB - b.alphaB)[0] ?? null;

export const sweepComparison = (rows, selectedId) => {
  const best = bestHybrid(rows);
  const references = ['prop', 'unchoke'].map((strategy) => rows.find((row) => row.strategy === strategy)).filter(Boolean);
  const selected = rows.find((row) => row.id === selectedId && row.strategy === 'hybrid') ?? best;
  return [selected && { ...selected, comparisonLabel: selected.id === best?.id ? 'Best hybrid' : 'Selected hybrid' },
    ...references.map((row) => ({ ...row, comparisonLabel: row.policyName })),
  ].filter(Boolean);
};
