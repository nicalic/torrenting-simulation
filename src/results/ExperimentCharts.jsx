import { useMemo } from 'react';
import { DEADLINE_SECONDS, SAMPLE_SECONDS } from './resultAdapters.js';
import PlotFigure from './PlotFigure.jsx';
import { experimentTraces } from './experimentPlotData.js';

const axis = (title, extra = {}) => ({ title, gridcolor: '#e3e8ec', zeroline: false, ...extra });

function Panel({ title, description, children }) {
  return <section className="panel chart-panel"><div className="chart-head"><h3>{title}</h3><p>{description}</p></div>{children}</section>;
}

export default function ExperimentCharts({ rows }) {
  const traces = useMemo(() => experimentTraces(rows), [rows]);
  const areaLayout = useMemo(() => ({
    xaxis: axis('Elapsed simulation time (s)', { range: [0, DEADLINE_SECONDS] }),
    yaxis: axis('Mean downloaded (%)', { range: [0, 100] }),
    showlegend: true, legend: { orientation: 'h', y: -0.24 },
  }), []);
  const barsLayout = useMemo(() => ({
    xaxis: axis('Elapsed simulation time (s)', { tickvals: SAMPLE_SECONDS, range: [-10, 190] }),
    yaxis: axis('Completed initial leechers', { range: [0, rows[0]?.peerCount ?? 1], dtick: 1 }),
    barmode: 'group', bargap: 0.2,
    showlegend: true, legend: { orientation: 'h', y: -0.24 },
  }), [rows]);
  const boxesLayout = useMemo(() => ({
    xaxis: axis('Policy'), yaxis: axis('Completion time (s)', { range: [0, DEADLINE_SECONDS] }),
    showlegend: false,
  }), []);
  return <div className="chart-grid">
    <Panel title="Mean downloaded percentage over time" description="Overlapping areas show average file progress for each policy.">
      <PlotFigure data={traces.area} layout={areaLayout} />
    </Panel>
    <Panel title="Completed peers over time" description="Cumulative completed initial leechers at 30-second intervals.">
      <PlotFigure data={traces.bars} layout={barsLayout} />
    </Panel>
    <Panel title="Completed peers' finish times" description="Distribution of finish times among peers that completed before the deadline.">
      {traces.boxes.length > 0 ? <PlotFigure data={traces.boxes} layout={boxesLayout} /> : <p className="empty-chart">No peers finished before the deadline.</p>}
      <p className="chart-summary">{rows.map((row) => `${row.policyName}: ${row.finishedTimesSeconds.length} finished, ${row.unfinishedCount} unfinished`).join(' · ')}</p>
    </Panel>
  </div>;
}
