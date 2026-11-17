import { useMemo } from 'react';
import { STRATEGY_COLOURS } from '../simulation/constants.js';
import { METRICS, metricValue, sweepComparison } from './resultAdapters.js';
import PlotFigure from './PlotFigure.jsx';

const label = (row) => row.strategy === 'hybrid'
  ? `${row.comparisonLabel} (αₛ ${row.alphaS}, αᵦ ${row.alphaB})` : row.comparisonLabel;

export default function SweepComparisonChart({ rows, metric, selectedId }) {
  const comparisons = useMemo(() => sweepComparison(rows, selectedId), [rows, selectedId]);
  const available = useMemo(() => comparisons.filter((row) => metricValue(row, metric) !== null), [comparisons, metric]);
  const unavailable = comparisons.filter((row) => metricValue(row, metric) === null);
  const data = useMemo(() => [{
    type: 'bar', orientation: 'h',
    x: available.map((row) => metricValue(row, metric)),
    y: available.map(label),
    marker: { color: available.map((row) => STRATEGY_COLOURS[row.strategy]) },
    customdata: available.map((row) => [row.completed, row.peerCount, row.termination]),
    hovertemplate: '%{y}<br>' + METRICS[metric].label + ': %{x:.1f} ' + METRICS[metric].unit +
      '<br>Completed: %{customdata[0]}/%{customdata[1]}<br>Status: %{customdata[2]}<extra></extra>',
  }], [available, metric]);
  const layout = useMemo(() => ({
    xaxis: { title: `${METRICS[metric].label} (${METRICS[metric].unit})`, range: metric === 'completion' ? [0, 100] : undefined,
      gridcolor: '#e3e8ec', zeroline: false },
    yaxis: { title: '', autorange: 'reversed', automargin: true },
    barmode: 'group', showlegend: false,
    margin: { l: 220, r: 20, t: 15, b: 55 },
  }), [metric]);
  return <section className="panel chart-panel sweep-figure">
    <div className="chart-head"><h3>Hybrid vs reference algorithms</h3>
      <p>Starts with the best hybrid. Click a heatmap cell to compare a different hybrid with the references.</p></div>
    {available.length > 0 ? <PlotFigure data={data} layout={layout} /> : <p className="empty-chart">No all-peer mean completion times are available.</p>}
    {unavailable.length > 0 && <p className="selection-summary">All-peer mean unavailable (incomplete): {unavailable.map(label).join(', ')}.</p>}
  </section>;
}
