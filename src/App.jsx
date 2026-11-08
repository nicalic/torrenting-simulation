import { useEffect, useRef, useState } from 'react';
import { STRATEGY_COLOURS, STRATEGY_NAMES } from './simulator.js';
import { exportExperiment } from './experiments.js';

const formatNumber = (value, digits = 2) => Number(value).toFixed(digits);
const formatFinishTime = (seconds) => seconds === null ? '—' : `${formatNumber(seconds, 1)} s`;

function ChartPanel({ experiment, results, chartType, title, description }) {
  const chartWidth = 600;
  const chartHeight = 280;
  const leftMargin = 43;
  const rightMargin = 12;
  const topMargin = 12;
  const bottomMargin = 32;
  const plotWidth = chartWidth - leftMargin - rightMargin;
  const plotHeight = chartHeight - topMargin - bottomMargin;
  const durationMinutes = experiment ? experiment.durationMinutes : 0;
  const axisTicks = [0, 0.25, 0.5, 0.75, 1];
  const isCompletionChart = chartType === 'completion';
  const downloaderCount = results.length > 0 ? results[0].peerCount : 1;
  const maxValue = isCompletionChart ? 100 : Math.max(1, downloaderCount);
  const timeDigits = durationMinutes < 10 ? 1 : 0;

  return (
    <section className="panel chart-panel">
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="legend">
        {results.map((result) => (
          <span className="legend-item" key={result.strategy}>
            <i
              className="legend-swatch"
              style={{ background: STRATEGY_COLOURS[result.strategy] }}
            />
            {STRATEGY_NAMES[result.strategy]}
          </span>
        ))}
      </div>
      <div className="chart-wrap">
        <svg
          className="chart-svg"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={title}
        >
          {axisTicks.map((tick) => {
            const x = leftMargin + plotWidth * tick;
            const y = topMargin + plotHeight * tick;
            const value = Math.round(maxValue * (1 - tick));
            const label = isCompletionChart ? `${value}%` : value;
            const minutes = durationMinutes * tick;

            return (
              <g key={tick}>
                <line className="chart-grid-line" x1={leftMargin} y1={y} x2={chartWidth - rightMargin} y2={y} />
                <text className="chart-axis-label" x={leftMargin - 8} y={y} textAnchor="end" dominantBaseline="middle">{label}</text>
                <text className="chart-axis-label" x={x} y={chartHeight - bottomMargin + 15} textAnchor="middle" dominantBaseline="middle">{formatNumber(minutes, timeDigits)}m</text>
              </g>
            );
          })}
          {results.map((result) => {
            const values = isCompletionChart
              ? result.averageCompletion
              : result.completedPeers;
            const chartPoints = values.map((value, index) => {
              const x = leftMargin + plotWidth * result.times[index] / durationMinutes;
              const y = topMargin + plotHeight - (value / maxValue) * plotHeight;
              return `${x},${y}`;
            }).join(' ');

            return (
              <polyline key={result.strategy} fill="none" stroke={STRATEGY_COLOURS[result.strategy]} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" points={chartPoints} />
            );
          })}
          <text className="chart-x-label" x={leftMargin + plotWidth / 2} y={chartHeight - 5} textAnchor="middle">Elapsed time</text>
        </svg>
      </div>
    </section>
  );
}

const initialSettings = {
  peerCount: 17, fileSizeMB: 128, timeLimitSeconds: 1800,
  stepSeconds: 0.1, selectionIntervalSeconds: 10, contributionWindowSeconds: 20,
  heterogeneity: 0, freeRiderRatio: 0, churnEnabled: false,
  meanOnlineSeconds: 300, meanOfflineSeconds: 30,
  alphaS: 0.5, alphaB: 0.5, regularSlots: 3, optimisticSlots: 1,
  seed: 42, repetitions: 3,
};

function App() {
  const [settings, setSettings] = useState(initialSettings);
  const [experiment, setExperiment] = useState(null);
  const [sweep, setSweep] = useState(null);
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const worker = useRef(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const update = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const cancel = () => {
    worker.current?.terminate();
    worker.current = null;
    setIsRunning(false);
  };
  const run = (mode) => {
    setError('');
    if (!Number.isInteger(settings.peerCount) || settings.peerCount < 1 || settings.peerCount > 59 ||
        !Number.isInteger(settings.repetitions) || settings.repetitions < 1 || settings.repetitions > 100 ||
        settings.freeRiderRatio < 0 || settings.freeRiderRatio > 1) {
      setError('Use 1–59 leechers, 1–100 repetitions, and a free-rider ratio from 0 to 1.');
      return;
    }
    const config = {
      ...settings,
      nodeConfigs: [{ role: 'seed' }, ...Array.from({ length: settings.peerCount }, () => ({ role: 'peer' }))],
      freeRiderCount: Math.round(settings.peerCount * settings.freeRiderRatio),
    };
    worker.current?.terminate();
    const nextWorker = new Worker(new URL('./simulation.worker.js', import.meta.url), { type: 'module' });
    worker.current = nextWorker;
    setIsRunning(true);
    nextWorker.onmessage = ({ data }) => {
      if (data.error) setError(data.error);
      else if (mode === 'sweep') setSweep(data.result);
      else setExperiment(data.result);
      nextWorker.terminate();
      worker.current = null;
      setIsRunning(false);
    };
    nextWorker.onerror = (event) => { setError(event.message); cancel(); };
    nextWorker.postMessage({ mode, config });
  };
  const download = (value, filename) => {
    const url = URL.createObjectURL(new Blob([exportExperiment(value)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const numberField = (key, label, min, max, step = 1) => (
    <div className="field" key={key}>
      <div className="field-head"><label htmlFor={key}>{label}</label></div>
      <input id={key} type="number" min={min} max={max} step={step} value={settings[key]}
        onChange={(e) => update(key, Number(e.target.value))} />
    </div>
  );
  const results = experiment?.results ?? [];
  const sweepRows = sweep?.repetitions.flatMap((rep) =>
    rep.comparisons.map((comparison) => ({ ...comparison, seed: rep.seed }))) ?? [];

  return (
    <div className="shell">
      <header className="topbar"><div className="brand">
        <div className="eyebrow">COMP3821 Project</div>
        <h1>Torrenting simulation</h1>
        <p className="subtitle">Compare reciprocity policies under the same swarm conditions.</p>
      </div></header>
      <div className="layout">
        <aside className="panel controls">
          <h2 className="section-title">Swarm conditions</h2>
          {numberField('peerCount', 'Initial leechers (plus one seeder)', 1, 59)}
          {numberField('fileSizeMB', 'File size (MB)', 0.01, 1024, 0.01)}
          {numberField('heterogeneity', 'Upload heterogeneity h', 0, 1, 0.05)}
          {numberField('freeRiderRatio', 'Free-rider ratio', 0, 1, 0.05)}
          <p className="hint">{Math.round(settings.peerCount * settings.freeRiderRatio)} free riders, sampled without replacement. Count rounds to the nearest whole peer.</p>
          <div className="field"><label><input type="checkbox" checked={settings.churnEnabled}
            onChange={(e) => update('churnEnabled', e.target.checked)} /> Enable churn</label></div>
          {settings.churnEnabled && <>
            {numberField('meanOnlineSeconds', 'Mean online duration (s)', 0.1, 100000, 0.1)}
            {numberField('meanOfflineSeconds', 'Mean offline duration (s)', 0.1, 100000, 0.1)}
          </>}
          <h2 className="section-title">Timing</h2>
          {numberField('timeLimitSeconds', 'Time limit (s)', 0.1, 100000, 0.1)}
          {numberField('stepSeconds', 'Simulation step (s)', 0.01, 10, 0.01)}
          {numberField('selectionIntervalSeconds', 'Selection interval (s)', 0.1, 1000, 0.1)}
          {numberField('contributionWindowSeconds', 'Contribution window (s)', 0.1, 1000, 0.1)}
          <h2 className="section-title">Policies</h2>
          {numberField('alphaS', 'Hybrid selection reciprocity αₛ', 0, 1, 0.25)}
          {numberField('alphaB', 'Hybrid allocation reciprocity αᵦ', 0, 1, 0.05)}
          {numberField('regularSlots', 'Unchoking regular slots', 0, 59)}
          {numberField('optimisticSlots', 'Unchoking optimistic slots', 0, 59)}
          <p className="hint">Hybrid uses four slots and δ = 2 Mbps. Proportional sharing serves all eligible receivers.</p>
          {numberField('seed', 'Random seed', 0, 4294967295)}
          {numberField('repetitions', 'Sweep repetitions (consecutive seeds)', 1, 100)}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="run-button" disabled={isRunning} onClick={() => run('single')}>Run comparison</button>
          <button className="run-button" disabled={isRunning} onClick={() => run('sweep')}>Run all sweeps</button>
          {isRunning && <><p role="status">Running simulation…</p><button onClick={cancel}>Cancel</button></>}
        </aside>
        <main className="main">
          <section className="panel intro"><div>
            <h2>Swarm completion</h2>
            <p>{experiment ? `${experiment.network.peerIds.length} leechers · ${experiment.network.freeRiderIds.length} free riders · seed ${experiment.seed}` : 'Set conditions and run a comparison.'}</p>
          </div>
          {experiment && <button onClick={() => download(experiment, 'comparison.json')}>Export comparison</button>}
          </section>
          <section className="panel table-panel">
            <div className="table-head"><h3>Comparison results</h3><span>Times measured from the start of the run</span></div>
            <div className="table-scroll"><table>
              <thead><tr><th>Policy</th><th>Mean downloaded</th><th>Completed</th><th>First finish</th><th>Full swarm finish</th><th>Mean finish (completed only)</th><th>Stopped at</th></tr></thead>
              <tbody>{results.map((r) => <tr key={r.strategy}>
                <td>{STRATEGY_NAMES[r.strategy]}</td><td>{formatNumber(r.finalCompletion, 1)}%</td>
                <td>{r.completed}/{r.peerCount} ({formatNumber(r.completionFraction * 100, 1)}%)</td>
                <td>{formatFinishTime(r.firstFinishMinutes === null ? null : r.firstFinishMinutes * 60)}</td>
                <td>{formatFinishTime(r.swarmFinishSeconds)}</td>
                <td>{formatFinishTime(r.meanFinishMinutes === null ? null : r.meanFinishMinutes * 60)} ({r.finishedTimesCount})</td>
                <td>{formatFinishTime(r.elapsedSeconds)} · {r.termination}</td>
              </tr>)}</tbody>
            </table></div>
          </section>
          <div className="chart-grid">
            <ChartPanel experiment={experiment} results={results} chartType="completion" title="Mean downloaded percentage" description="Average fraction of file data held by initial leechers." />
            <ChartPanel experiment={experiment} results={results} chartType="completed" title="Completed initial leechers" description="Peers holding the entire file; includes peers currently offline." />
          </div>
          {sweep && <section className="panel table-panel">
            <div className="table-head"><h3>Sweep results · {sweep.seeds.length} seeds</h3>
              <button onClick={() => download(sweep, 'sweeps.json')}>Export sweeps</button></div>
            <div className="table-scroll"><table><thead><tr><th>Seed</th><th>Family / policy</th><th>αₛ</th><th>αᵦ</th><th>Completed</th><th>Full swarm finish</th></tr></thead>
              <tbody>{sweepRows.map((row, i) => <tr key={i}><td>{row.seed}</td>
                <td>{row.family === 'reference' ? STRATEGY_NAMES[row.result.strategy] : row.family}</td>
                <td>{row.alphaS ?? '—'}</td><td>{row.alphaB ?? '—'}</td>
                <td>{row.result.completed}/{row.result.peerCount}</td><td>{formatFinishTime(row.result.swarmFinishSeconds)}</td></tr>)}</tbody>
            </table></div>
          </section>}
          <div className="note"><strong>Model assumptions.</strong> Complete graph; one permanent initial seeder at 20 Mbps.
            Leecher upload capacities are sampled once from 20 × U(1−h, 1+h) Mbps; download caps are 100 Mbps.
            Free riders never upload, including after completion. All peers start online; exponential churn preserves data.
            Pieces are 256 KiB (with a shorter final piece), rarest first, with one sender per receiver–piece pair.
            Only complete pieces can be uploaded. Download limits scale desired rates proportionally; unused allocations are not redistributed.
            Slot selections persist until invalid and refill only at selection rounds. Seeders use random selection and equal allocation.
            Contributions count useful bytes over the configured window. Completed peers remain in the swarm subject to churn.
            Sweeps use α = 0, 0.25, 0.5, 0.75, 1 and reuse conditions within each seed.
            A dash for full-swarm finish means at least one peer did not finish before the deadline.</div>
        </main>
      </div>
    </div>
  );
}
export default App;
