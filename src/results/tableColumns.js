const number = (value, digits = 1) => value === null ? '—' : Number(value).toFixed(digits);
const seconds = (value) => value === null ? '—' : `${number(value)} s`;
const completed = (row) => `${row.completed}/${row.peerCount}`;
export const columns = {
  policy: { label: 'Policy', value: (row) => row.policyName, render: (row) => row.policyName },
  alphaS: { label: 'Selection reciprocity αₛ', value: (row) => row.alphaS, render: (row) => number(row.alphaS, 2) },
  alphaB: { label: 'Allocation reciprocity αᵦ', value: (row) => row.alphaB, render: (row) => number(row.alphaB, 2) },
  downloaded: { label: 'Mean downloaded', value: (row) => row.meanDownloadedPercent, render: (row) => `${number(row.meanDownloadedPercent)}%` },
  completed: { label: 'Completed peers', value: (row) => row.completed, render: completed },
  completion: { label: 'Completion percentage', value: (row) => row.completionPercent, render: (row) => `${number(row.completionPercent)}%` },
  first: { label: 'First peer finish', value: (row) => row.firstFinishSeconds, render: (row) => seconds(row.firstFinishSeconds) },
  full: { label: 'Full swarm finish', value: (row) => row.fullSwarmFinishSeconds, render: (row) => seconds(row.fullSwarmFinishSeconds) },
  meanCompleted: { label: 'Mean finish (completed only)', value: (row) => row.meanCompletedFinishSeconds, render: (row) => seconds(row.meanCompletedFinishSeconds) },
  meanAll: { label: 'Mean peer finish time', value: (row) => row.meanAllPeersFinishSeconds, render: (row) => seconds(row.meanAllPeersFinishSeconds) },
  stopped: { label: 'Stopped at / termination', value: (row) => row.elapsedSeconds, render: (row) => `${seconds(row.elapsedSeconds)} · ${row.termination}` },
  termination: { label: 'Termination status', value: (row) => row.termination, render: (row) => row.termination },
};
export const experimentColumns = ['policy', 'downloaded', 'completed', 'first', 'full', 'meanCompleted', 'stopped'];
export const sweepColumns = ['policy', 'alphaS', 'alphaB', 'downloaded', 'completed', 'completion', 'meanAll', 'full', 'termination'];

export const sortResultRows = (rows, column, direction) => rows.slice().sort((a, b) => {
  const left = columns[column].value(a);
  const right = columns[column].value(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const compared = typeof left === 'number' && typeof right === 'number'
    ? left - right : String(left).localeCompare(String(right));
  return direction === 'asc' ? compared : -compared;
});

