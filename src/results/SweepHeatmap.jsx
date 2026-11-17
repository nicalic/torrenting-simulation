import { useCallback, useMemo } from 'react';
import { bestHybrid, buildHeatmap, METRICS, RECIPROCITY_LEVELS } from './resultAdapters.js';
import PlotFigure from './PlotFigure.jsx';

const format = (value, unit) => value === null ? 'Unavailable' : `${value.toFixed(1)} ${unit}`;

export default function SweepHeatmap({ rows, metric, onMetricChange, selectedId, onSelect }) {
  const cells = useMemo(() => buildHeatmap(rows, metric), [rows, metric]);
  const best = useMemo(() => bestHybrid(rows), [rows]);
  const selected = rows.find((row) => row.id === selectedId) ?? best;
  const unavailable = useMemo(() => cells.flat().filter((cell) => cell.row && cell.value === null), [cells]);
  const data = useMemo(() => [{
    type: 'heatmap',
    x: RECIPROCITY_LEVELS, y: RECIPROCITY_LEVELS,
    z: cells.map((line) => line.map((cell) => cell.value)),
    customdata: cells.map((line) => line.map((cell) => cell.row
      ? [cell.row.completed, cell.row.peerCount, cell.row.termination] : [null, null, 'unavailable'])),
    colorscale: 'RdYlGn', reversescale: metric === 'meanTime',
    zmin: metric === 'completion' ? 0 : undefined,
    zmax: metric === 'completion' ? 100 : undefined,
    colorbar: { title: METRICS[metric].unit, thickness: 14 },
    hovertemplate: 'αₛ %{x}<br>αᵦ %{y}<br>' + METRICS[metric].label + ': %{z:.1f} ' + METRICS[metric].unit +
      '<br>Completed: %{customdata[0]}/%{customdata[1]}<br>Status: %{customdata[2]}<extra></extra>',
  }, {
    type: 'scatter', mode: 'markers+text', showlegend: false,
    x: unavailable.map((cell) => cell.alphaS), y: unavailable.map((cell) => cell.alphaB),
    text: unavailable.map(() => '×'), textfont: { color: '#687078', size: 17 },
    marker: { color: 'rgba(0,0,0,0)', size: 30 },
    customdata: unavailable.map((cell) => [cell.row.completed, cell.row.peerCount, cell.row.termination]),
    hovertemplate: 'αₛ %{x}<br>αᵦ %{y}<br>' + METRICS[metric].label + ': unavailable' +
      '<br>Completed: %{customdata[0]}/%{customdata[1]}<br>Status: %{customdata[2]}<extra></extra>',
  }], [cells, metric, unavailable]);
  const layout = useMemo(() => ({
    xaxis: { title: 'Selection reciprocity αₛ', tickvals: RECIPROCITY_LEVELS, range: [-0.125, 1.125], fixedrange: true },
    yaxis: { title: 'Bandwidth allocation reciprocity αᵦ', tickvals: RECIPROCITY_LEVELS, range: [-0.125, 1.125], fixedrange: true },
    showlegend: false,
  }), []);
  const handleClick = useCallback((event) => {
    const point = event.points[0];
    const row = cells.flat().find((cell) => cell.alphaS === point.x && cell.alphaB === point.y)?.row;
    if (row) onSelect(row.id);
  }, [cells, onSelect]);
  return <section className="panel chart-panel sweep-figure">
    <div className="chart-head"><h3>Reciprocity performance heatmap</h3><p>Click a hybrid setting to compare it with the references.</p></div>
    <label className="metric-selector">Performance metric <select value={metric} onChange={(event) => onMetricChange(event.target.value)}>
      {Object.entries(METRICS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
    </select></label>
    <PlotFigure data={data} layout={layout} onClick={handleClick} />
    {best && <p className="selection-summary">Best hybrid: αₛ = {best.alphaS}, αᵦ = {best.alphaB} · {METRICS[metric].label}: {format(best[metric === 'meanTime' ? 'meanAllPeersFinishSeconds' : 'completionPercent'], METRICS[metric].unit)} · {best.completed}/{best.peerCount} completed · {best.termination}</p>}
    {selected && <p className="selection-summary">Selected hybrid: αₛ = {selected.alphaS}, αᵦ = {selected.alphaB} · {METRICS[metric].label}: {format(selected[metric === 'meanTime' ? 'meanAllPeersFinishSeconds' : 'completionPercent'], METRICS[metric].unit)} · {selected.completed}/{selected.peerCount} completed · {selected.termination}</p>}
  </section>;
}
