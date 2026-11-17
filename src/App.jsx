import { useEffect, useMemo, useRef, useState } from 'react';
import { exportExperiment } from './simulator.js';
import { adaptExperiment, adaptSweep } from './results/resultAdapters.js';
import ResultsTable from './results/ResultsTable.jsx';
import ExperimentCharts from './results/ExperimentCharts.jsx';
import SweepHeatmap from './results/SweepHeatmap.jsx';
import SweepComparisonChart from './results/SweepComparisonChart.jsx';

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
  const [allReciprocityLevels, setAllReciprocityLevels] = useState(false);
  const [experiment, setExperiment] = useState(null);
  const [sweepResult, setSweepResult] = useState(null);
  const [sweepMetric, setSweepMetric] = useState('meanTime');
  const [selectedHybridId, setSelectedHybridId] = useState(null);
  const [resultVersion, setResultVersion] = useState(0);
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
    setSweepResult(null);
    setSelectedHybridId(null);
    if (allReciprocityLevels) setExperiment(null);
    const nextWorker = new Worker(new URL('./simulation.worker.js', import.meta.url), { type: 'module' });
    worker.current = nextWorker;
    setIsRunning(true);
    nextWorker.onmessage = ({ data }) => {
      if (allReciprocityLevels) setSweepResult(data.result);
      else setExperiment(data.result);
      setResultVersion((version) => version + 1);
      nextWorker.terminate();
      worker.current = null;
      setIsRunning(false);
    };
    nextWorker.onerror = cancel;
    nextWorker.postMessage({ config, allReciprocityLevels });
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
      setAllReciprocityLevels(false);
      setSweepResult(null);
      setSelectedHybridId(null);
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
      setResultVersion((version) => version + 1);
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
  const adapted = useMemo(() => sweepResult ? adaptSweep(sweepResult)
    : experiment ? adaptExperiment(experiment) : null, [experiment, sweepResult]);


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
          <div className="field"><label><input type="checkbox" checked={allReciprocityLevels}
            onChange={(e) => setAllReciprocityLevels(e.target.checked)} /> All reciprocity levels</label></div>
          {!allReciprocityLevels && <>
            {numberField('alphaS', 'Hybrid selection reciprocity αₛ', 0, 1, 0.25)}
            {numberField('alphaB', 'Hybrid allocation reciprocity αᵦ', 0, 1, 0.05)}
          </>}
          <p className="hint">Hybrid uses four slots and δ = 2 Mbps. Proportional sharing serves all eligible receivers.</p>
          {numberField('seed', 'Random seed', 0, 4294967295)}
          <button className="run-button" disabled={isRunning} onClick={run}>Run comparison</button>
          {isRunning && <><p role="status">Running simulation…</p><button onClick={cancel}>Cancel</button></>}
          {sweepResult && !isRunning && <p role="status">Sweep complete: {sweepResult.repetitions[0].comparisons.length} comparisons.</p>}
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
          {adapted && <ResultsTable key={resultVersion} rows={adapted.rows} mode={adapted.mode} />}
          {adapted?.mode === 'experiment' && <ExperimentCharts rows={adapted.rows} />}
          {adapted?.mode === 'sweep' && <SweepHeatmap rows={adapted.rows} metric={sweepMetric}
            onMetricChange={setSweepMetric} selectedId={selectedHybridId} onSelect={setSelectedHybridId} />}
          {adapted?.mode === 'sweep' && <SweepComparisonChart rows={adapted.rows} metric={sweepMetric} selectedId={selectedHybridId} />}
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
