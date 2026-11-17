import { useEffect, useMemo, useRef, useState } from 'react';
import { DEADLINE_SECONDS, SAMPLE_SECONDS } from './resultAdapters.js';
import PlotFigure from './PlotFigure.jsx';
import { experimentTraces } from './experimentPlotData.js';
import { areaAt, barsAt } from './raceData.js';

const axis = (title, extra = {}) => ({ title, gridcolor: '#e3e8ec', zeroline: false, ...extra });

function Panel({ title, description, children }) {
  return <section className="panel chart-panel"><div className="chart-head"><h3>{title}</h3><p>{description}</p></div>{children}</section>;
}

export default function ExperimentCharts({ rows }) {
  const areaRef = useRef(null);
  const barsRef = useRef(null);
  const frameRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  const traces = useMemo(() => experimentTraces(rows), [rows]);
  const play = () => {
    cancelAnimationFrame(frameRef.current);
    setPlaying(true);
    let startedAt = null;
    let lastAreaDraw = -Infinity;
    let lastBarBucket = -1;
    const tick = (now) => {
      startedAt ??= now;
      const simulationTime = Math.min(DEADLINE_SECONDS, (now - startedAt) / 5000 * DEADLINE_SECONDS);
      if (now - lastAreaDraw >= 30 || simulationTime === DEADLINE_SECONDS) {
        const points = rows.map((row) => areaAt(row, simulationTime));
        areaRef.current?.restyle({ x: points.map((point) => point.x), y: points.map((point) => point.y) }, rows.map((_, index) => index));
        lastAreaDraw = now;
      }
      const barBucket = Math.floor(simulationTime / 30);
      if (barBucket !== lastBarBucket) {
        barsRef.current?.restyle({ y: rows.map((row) => barsAt(row, simulationTime)) }, rows.map((_, index) => index));
        lastBarBucket = barBucket;
      }
      if (simulationTime < DEADLINE_SECONDS) frameRef.current = requestAnimationFrame(tick);
      else { frameRef.current = null; setPlaying(false); }
    };
    tick(performance.now());
  };
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
  return <><div className="playback-actions"><button type="button" className="small-button" onClick={play} disabled={playing}>Play race</button></div><div className="chart-grid">
    <Panel title="Mean downloaded percentage over time" description="Overlapping areas show average file progress for each policy.">
      <PlotFigure ref={areaRef} data={traces.area} layout={areaLayout} />
    </Panel>
    <Panel title="Completed peers over time" description="Cumulative completed initial leechers at 30-second intervals.">
      <PlotFigure ref={barsRef} data={traces.bars} layout={barsLayout} />
    </Panel>
    <Panel title="Completed peers' finish times" description="Distribution of finish times among peers that completed before the deadline.">
      {traces.boxes.length > 0 ? <PlotFigure data={traces.boxes} layout={boxesLayout} /> : <p className="empty-chart">No peers finished before the deadline.</p>}
      <p className="chart-summary">{rows.map((row) => `${row.policyName}: ${row.finishedTimesSeconds.length} finished, ${row.unfinishedCount} unfinished`).join(' · ')}</p>
    </Panel>
  </div></>;
}
