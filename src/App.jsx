import { useEffect, useMemo, useRef, useState } from 'react';
import { exportExperiment } from './simulator.js';
import { adaptExperiment, adaptSweep } from './results/resultAdapters.js';
import ResultsTable from './results/ResultsTable.jsx';
import ExperimentCharts from './results/ExperimentCharts.jsx';
import SweepHeatmap from './results/SweepHeatmap.jsx';
import SweepComparisonChart from './results/SweepComparisonChart.jsx';
import { isValidExperiment, isValidSweep } from './results/resultValidation.js';

const initialSettings = {
  peerCount: 31, fileSizeMB: 128,
  heterogeneity: 0, freeRiderRatio: 0, churnEnabled: false,
  meanOnlineSeconds: 300, meanOfflineSeconds: 30,
  alphaS: 0.5, alphaB: 0.5,
  seed: 42,
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
      const imported = JSON.parse(await file.text());
      const isExperiment = isValidExperiment(imported);
      const isSweep = !isExperiment && isValidSweep(imported);
      if (!isExperiment && !isSweep) throw new Error();

      worker.current?.terminate();
      worker.current = null;
      setIsRunning(false);
      setAllReciprocityLevels(isSweep);
      setSweepResult(isSweep ? imported : null);
      setSelectedHybridId(null);
      setSettings({
        peerCount: imported.config.peerCount,
        fileSizeMB: imported.config.fileSizeMB,
        heterogeneity: imported.config.heterogeneity,
        freeRiderRatio: imported.config.freeRiderRatio,
        churnEnabled: imported.config.churnEnabled,
        meanOnlineSeconds: imported.config.meanOnlineSeconds,
        meanOfflineSeconds: imported.config.meanOfflineSeconds,
        alphaS: imported.config.alphaS ?? initialSettings.alphaS,
        alphaB: imported.config.alphaB ?? initialSettings.alphaB,
        seed: imported.config.seed,
      });
      setExperiment(isExperiment ? imported : null);
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
            <p>{experiment ? `${experiment.network.peerIds.length} leechers · ${experiment.network.freeRiderIds.length} free riders · seed ${experiment.seed}`
              : sweepResult ? `${sweepResult.config.peerCount} leechers · ${sweepResult.config.freeRiderCount} free riders · seed ${sweepResult.seeds[0]}`
                : 'Set conditions and run a comparison.'}</p>
          </div>
          <div className="intro-actions">
            <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={importComparison} />
            <button className="small-button" onClick={() => importInput.current.click()}>Import JSON</button>
            {experiment && <button className="small-button" onClick={() => download(experiment, 'comparison.json')}>Export comparison</button>}
            {sweepResult && <button className="small-button" onClick={() => download(sweepResult, 'sweep.json')}>Export sweep</button>}
          </div>
          </section>
          {adapted && <ResultsTable key={resultVersion} rows={adapted.rows} mode={adapted.mode} />}
          {adapted?.mode === 'experiment' && <ExperimentCharts key={resultVersion} rows={adapted.rows} />}
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
