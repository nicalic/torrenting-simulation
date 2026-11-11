import { useEffect, useRef, useState } from 'react';
import { STRATEGY_COLOURS, STRATEGY_NAMES, exportExperiment } from './simulator.js';

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
  peerCount: 31, fileSizeMB: 128,
  heterogeneity: 0, freeRiderRatio: 0, churnEnabled: false,
  meanOnlineSeconds: 300, meanOfflineSeconds: 30,
  alphaS: 0.5, alphaB: 0.5,
  seed: 42,
};

const isValidComparison = (data) => {
  const config = data?.config;
  if (data?.schemaVersion !== 1 || !config || !data.network || !Array.isArray(data.results)) return false;
  if (!Array.isArray(config.nodeConfigs) || !Array.isArray(data.network.peerIds)) return false;
  if (config.nodeConfigs.length !== config.peerCount + 1) return false;
  if (config.nodeConfigs.filter((node) => node.role === 'peer').length !== config.peerCount) return false;
  if (config.nodeConfigs.filter((node) => node.role === 'seed').length !== 1) return false;
  if (data.network.peerIds.length !== config.peerCount || !Number.isFinite(data.durationMinutes) || data.durationMinutes <= 0) return false;

  const numbers = [
    config.peerCount, config.fileSizeMB, config.heterogeneity, config.freeRiderRatio,
    config.meanOnlineSeconds, config.meanOfflineSeconds, config.alphaS, config.alphaB, config.seed,
  ];
  if (!numbers.every(Number.isFinite)) return false;
  if (!Number.isInteger(config.peerCount) || config.peerCount < 1 || config.peerCount > 59) return false;
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 4294967295) return false;
  if (config.fileSizeMB <= 0 || config.fileSizeMB > 1024) return false;
  if (config.heterogeneity < 0 || config.heterogeneity > 1 || config.freeRiderRatio < 0 || config.freeRiderRatio > 1) return false;
  if (config.alphaS < 0 || config.alphaS > 1 || config.alphaB < 0 || config.alphaB > 1) return false;
  if (config.meanOnlineSeconds <= 0 || config.meanOfflineSeconds <= 0 || typeof config.churnEnabled !== 'boolean') return false;
  if (!Array.isArray(data.network.seedIds) || data.network.seedIds.length !== 1) return false;
  if (!Array.isArray(data.network.freeRiderIds) || data.results.length !== 3) return false;
  if (!Number.isInteger(config.freeRiderCount) || data.network.freeRiderIds.length !== config.freeRiderCount) return false;

  return data.results.every((result) =>
    ['hybrid', 'prop', 'unchoke'].includes(result.strategy) &&
    Array.isArray(result.times) &&
    Array.isArray(result.averageCompletion) &&
    Array.isArray(result.completedPeers) &&
    result.times.length > 0 &&
    result.averageCompletion.length === result.times.length &&
    result.completedPeers.length === result.times.length &&
    result.times.every(Number.isFinite) &&
    result.averageCompletion.every(Number.isFinite) &&
    result.completedPeers.every(Number.isFinite) &&
    result.peerCount === config.peerCount &&
    Number.isFinite(result.finalCompletion) &&
    Number.isFinite(result.completed) &&
    Number.isFinite(result.completionFraction) &&
    Number.isFinite(result.finishedTimesCount) &&
    Number.isFinite(result.elapsedSeconds) &&
    ['complete', 'deadline'].includes(result.termination) &&
    (result.firstFinishMinutes === null || Number.isFinite(result.firstFinishMinutes)) &&
    (result.swarmFinishSeconds === null || Number.isFinite(result.swarmFinishSeconds)) &&
    (result.meanFinishMinutes === null || Number.isFinite(result.meanFinishMinutes)),
  );
};

function App() {
  const [settings, setSettings] = useState(initialSettings);
  const [experiment, setExperiment] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const worker = useRef(null);
  const importInput = useRef(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const update = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const cancel = () => {
    worker.current?.terminate();
    worker.current = null;
    setIsRunning(false);
  };
  const run = () => {
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
      setExperiment(data.result);
      nextWorker.terminate();
      worker.current = null;
      setIsRunning(false);
    };
    nextWorker.onerror = cancel;
    nextWorker.postMessage({ config });
  };
  const download = (value, filename) => {
    const url = URL.createObjectURL(new Blob([exportExperiment(value)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importComparison = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const comparison = JSON.parse(await file.text());
      if (!isValidComparison(comparison)) throw new Error();

      worker.current?.terminate();
      worker.current = null;
      setIsRunning(false);
      setSettings({
        peerCount: comparison.config.peerCount,
        fileSizeMB: comparison.config.fileSizeMB,
        heterogeneity: comparison.config.heterogeneity,
        freeRiderRatio: comparison.config.freeRiderRatio,
        churnEnabled: comparison.config.churnEnabled,
        meanOnlineSeconds: comparison.config.meanOnlineSeconds,
        meanOfflineSeconds: comparison.config.meanOfflineSeconds,
        alphaS: comparison.config.alphaS,
        alphaB: comparison.config.alphaB,
        seed: comparison.config.seed,
      });
      setExperiment(comparison);
    } catch {
      window.alert('Invalid JSON file');
    }

    event.target.value = '';
  };
  const numberField = (key, label, min, max, step = 1) => (
    <div className="field" key={key}>
      <div className="field-head"><label htmlFor={key}>{label}</label></div>
      <input id={key} type="number" min={min} max={max} step={step} value={settings[key]}
        onChange={(e) => update(key, Number(e.target.value))} />
    </div>
  );
  const results = experiment?.results ?? [];


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
          <h2 className="section-title">Policies</h2>
          {numberField('alphaS', 'Hybrid selection reciprocity αₛ', 0, 1, 0.25)}
          {numberField('alphaB', 'Hybrid allocation reciprocity αᵦ', 0, 1, 0.05)}
          <p className="hint">Hybrid uses four slots and δ = 2 Mbps. Proportional sharing serves all eligible receivers.</p>
          {numberField('seed', 'Random seed', 0, 4294967295)}
          <button className="run-button" disabled={isRunning} onClick={run}>Run comparison</button>
          {isRunning && <><p role="status">Running simulation…</p><button onClick={cancel}>Cancel</button></>}
        </aside>
        <main className="main">
          <section className="panel intro"><div>
            <h2>Swarm completion</h2>
            <p>{experiment ? `${experiment.network.peerIds.length} leechers · ${experiment.network.freeRiderIds.length} free riders · seed ${experiment.seed}` : 'Set conditions and run a comparison.'}</p>
          </div>
          <div className="intro-actions">
            <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={importComparison} />
            <button className="small-button" onClick={() => importInput.current.click()}>Import JSON</button>
            {experiment && <button className="small-button" onClick={() => download(experiment, 'comparison.json')}>Export comparison</button>}
          </div>
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
          <div className="note"><strong>Model assumptions.</strong> Complete graph; one permanent initial seeder at 20 Mbps.
            Leecher upload capacities are sampled once from 20 × U(1−h, 1+h) Mbps; download caps are 100 Mbps.
            Free riders never upload, including after completion. All peers start online; exponential churn preserves data.
            Pieces are 256 KiB (with a shorter final piece), rarest first, with one sender per receiver–piece pair.
            Only complete pieces can be uploaded. Download limits scale desired rates proportionally; unused allocations are not redistributed.
            Slot selections persist until invalid and refill only at selection rounds. Seeders use random selection and equal allocation.
            Contributions count useful bytes over the configured window. Completed peers remain in the swarm subject to churn.
            A dash for full-swarm finish means at least one peer did not finish before the deadline.</div>
        </main>
      </div>
    </div>
  );
}
export default App;
