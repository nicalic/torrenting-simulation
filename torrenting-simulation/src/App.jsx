import { useEffect, useState } from 'react';
import {
  BASE_DOWNLOAD_MBPS,
  BASE_UPLOAD_MBPS,
  STRATEGY_COLOURS,
  STRATEGY_NAMES,
  runExperiment,
  createRandomGenerator,
} from './simulator.js';

const formatNumber = (value, digits = 2) => Number(value).toFixed(digits);
const formatFinishTime = (minutes) => {
  if (minutes === null) return '-';
  return `${formatNumber(minutes, 1)} min`;
};

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
              const x = leftMargin + (plotWidth * index) / (values.length - 1);
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

function App() {
  const [settings, setSettings] = useState({
    averageNeighbours: 6, durationMinutes: 20, fileSizeMB: 512,
    regularSlots: 3, optimisticSlots: 1, seed: 42,
  });
  const [nodeConfigs, setNodeConfigs] = useState(Array.from({ length: 18 }, (_, i) => ({
    role: i === 0 ? 'seed' : 'peer', uploadMultiplier: 1, downloadMultiplier: 1,
  })));
  const [experiment, setExperiment] = useState(null);
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const seedCount = nodeConfigs.filter((node) => node.role === 'seed').length;
  const peerCount = nodeConfigs.length - seedCount;
  const freeRiderCount = nodeConfigs.filter(
    (node) => node.role === 'peer' && node.uploadMultiplier === 0,
  ).length;

  const updateSetting = (key, value) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const updateNode = (index, key, value) => {
    setNodeConfigs((current) =>
      current.map((node, nodeIndex) =>
        nodeIndex === index ? { ...node, [key]: value } : node,
      ),
    );
  };

  const handleAddNode = (role) => {
    setNodeConfigs((current) => {
      if (current.length === 60) return current;
      return [...current, { role, uploadMultiplier: 1, downloadMultiplier: 1 }];
    });
  };

  const handleRemoveNode = (index) => setNodeConfigs((current) => current.filter((_, i) => i !== index));

  const randomiseRates = () => {
    const random = createRandomGenerator(settings.seed);

    setNodeConfigs((current) =>
      current.map((node) => ({
        ...node,
        uploadMultiplier: Math.floor(random() * 51) / 10,
        downloadMultiplier: (Math.floor(random() * 50) + 1) / 10,
      })),
    );
  };

  const changeFreeRiderCount = (count) => {
    setNodeConfigs((current) => {
      const updated = current.slice();
      let freeRiderCount = current.filter(
        (node) => node.role === 'peer' && node.uploadMultiplier === 0,
      ).length;

      if (count > freeRiderCount) {
        for (let index = 0; index < updated.length && freeRiderCount < count; index += 1) {
          const node = updated[index];
          if (node.role !== 'peer' || node.uploadMultiplier === 0) continue;

          updated[index] = { ...node, uploadMultiplier: 0 };
          freeRiderCount += 1;
        }
      } else {
        for (let index = updated.length - 1; index >= 0 && freeRiderCount > count; index -= 1) {
          const node = updated[index];
          if (node.role !== 'peer' || node.uploadMultiplier !== 0) continue;

          updated[index] = { ...node, uploadMultiplier: 1 };
          freeRiderCount -= 1;
        }
      }

      return updated;
    });
  };

  const handleRunSimulation = () => {
    setError('');
    if (nodeConfigs.length < 1) {
      setError('Add at least one node');
      return;
    }
    if (
      nodeConfigs.some(
        (node) =>
          node.uploadMultiplier < 0 ||
          node.uploadMultiplier > 5 ||
          node.downloadMultiplier < 0.1 ||
          node.downloadMultiplier > 5,
      )
    ) {
      setError('Upload multipliers must be 0×–5× and download multipliers must be 0.1×–5×');
      return;
    }

    setIsRunning(true);
    requestAnimationFrame(() => {
      try {
        const results = runExperiment({
          nodeConfigs,
          averageNeighbours: settings.averageNeighbours,
          durationMinutes: settings.durationMinutes,
          fileSizeMB: settings.fileSizeMB,
          regularSlots: Math.max(0, settings.regularSlots),
          optimisticSlots: Math.max(0, settings.optimisticSlots),
          seed: settings.seed,
        });
        setExperiment(results);
      } catch (err) {
        setError(`Simulation error: ${err.message}`);
      } finally {
        setIsRunning(false);
      }
    });
  };

  useEffect(() => {
    handleRunSimulation();
  }, []);

  const results = experiment?.results ?? [];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div>
            <div className="eyebrow">COMP3821 Project</div>
            <h1>Torrenting simulation</h1>
            <p className="subtitle">Examining the impact of peer reciprocity in common torrenting scenarios.</p>
          </div>
        </div>
      </header>

      <div className="layout">
        <aside className="panel controls">
          <h2 className="section-title">Simulation setup</h2>
          <div className="field">
            <div className="field-head">
              <label htmlFor="degree">Average neighbours</label>
              <output>{settings.averageNeighbours}</output>
            </div>
            <input id="degree" type="range" min="2" max="14" step="1" value={settings.averageNeighbours} onChange={(e) => updateSetting('averageNeighbours', Number(e.target.value))} />
            <div className="range-bounds"><span>2</span><span>14</span></div>
          </div>
          <div className="two-col">
            <div className="field">
              <div className="field-head"><label htmlFor="duration">Duration</label></div>
              <select id="duration" value={settings.durationMinutes} onChange={(e) => updateSetting('durationMinutes', Number(e.target.value))}>
                {[5, 10, 20, 30, 60].map((minutes) => (
                  <option value={minutes} key={minutes}>{minutes} min</option>
                ))}
              </select>
            </div>
            <div className="field">
              <div className="field-head"><label htmlFor="fileSize">File size</label></div>
              <select id="fileSize" value={settings.fileSizeMB} onChange={(e) => updateSetting('fileSizeMB', Number(e.target.value))}>
                <option value="128">128 MB</option>
                <option value="256">256 MB</option>
                <option value="512">512 MB</option>
                <option value="1024">1 GB</option>
              </select>
            </div>
          </div>

          <section className="node-roster" aria-labelledby="nodes-title">
            <div className="node-roster-head">
              <h2 id="nodes-title" className="section-title">
                Nodes <small>{nodeConfigs.length} total · {seedCount} seed{seedCount === 1 ? '' : 's'}</small>
              </h2>
              <div className="node-actions">
                <button className="small-button" type="button" onClick={() => handleAddNode('seed')} disabled={nodeConfigs.length === 60}>+ Seed</button>
                <button className="small-button" type="button" onClick={() => handleAddNode('peer')} disabled={nodeConfigs.length === 60}>+ Peer</button>
              </div>
            </div>
            <div className="node-randomise-row">
              <button className="small-button" type="button" onClick={randomiseRates}>Randomise rates (once per seed)</button>
            </div>
            <div className="node-columns"><span>ID</span><span>Type</span><span>Up ×</span><span>Down ×</span><span /></div>
            <div className="node-list" aria-label="Peer and seed settings">
              {nodeConfigs.map((node, index) => (
                <div className="node-row" key={index}>
                  <span className="node-id">{String(index + 1).padStart(2, '0')}</span>
                  <select
                    className="node-type"
                    value={node.role}
                    aria-label={`Node ${index + 1} type`}
                    onChange={(e) => updateNode(index, 'role', e.target.value)}
                  >
                    <option value="peer">Peer</option>
                    <option value="seed">Seed</option>
                  </select>
                  <input
                    className="upload-multiplier"
                    type="number"
                    min="0"
                    max="5"
                    step="0.1"
                    value={node.uploadMultiplier}
                    aria-label={`Node ${index + 1} upload multiplier`}
                    title="Upload multiplier"
                    onChange={(e) => updateNode(index, 'uploadMultiplier', Number(e.target.value))}
                  />
                  <input
                    className="download-multiplier"
                    type="number"
                    min="0.1"
                    max="5"
                    step="0.1"
                    value={node.downloadMultiplier}
                    aria-label={`Node ${index + 1} download multiplier`}
                    title="Download multiplier"
                    onChange={(e) => updateNode(index, 'downloadMultiplier', Number(e.target.value))}
                  />
                  <button className="node-remove" type="button" onClick={() => handleRemoveNode(index)} aria-label={`Remove node ${index + 1}`} title="Remove node">×</button>
                </div>
              ))}
            </div>
            <p className="hint">Upload = {BASE_UPLOAD_MBPS} mbps × up, download = {BASE_DOWNLOAD_MBPS} mbps × down. You can still set an individual node's upload to 0×.</p>
          </section>

          <section className="free-rider-box" aria-labelledby="free-riders-title">
            <h2 id="free-riders-title" className="section-title">Free riders</h2>
            <div className="free-rider-control">
              <input
                className="free-rider-input"
                type="number"
                min="0"
                max={peerCount}
                step="1"
                value={freeRiderCount}
                aria-label="Number of free rider peers"
                onChange={(e) => {
                  const count = Number(e.target.value);
                  if (Number.isFinite(count)) {
                    changeFreeRiderCount(
                      Math.max(0, Math.min(peerCount, Math.floor(count))),
                    );
                  }
                }}
              />
              <span>/</span>
              <span>{peerCount}</span>
            </div>
            <p className="hint">Increasing this count sets peer uploads to 0× from the top down. Decreasing it restores them to 1× from the bottom up.</p>
          </section>

          <div className="two-col">
            <div className="field">
              <div className="field-head"><label htmlFor="regular">Regular slots kᵣ</label></div>
              <input
                id="regular"
                type="number"
                min="0"
                max="14"
                value={settings.regularSlots}
                onChange={(e) => updateSetting('regularSlots', Number(e.target.value))}
              />
            </div>
            <div className="field">
              <div className="field-head"><label htmlFor="optimistic">Optimistic slots kₒ</label></div>
              <input
                id="optimistic"
                type="number"
                min="0"
                max="14"
                value={settings.optimisticSlots}
                onChange={(e) => updateSetting('optimisticSlots', Number(e.target.value))}
              />
            </div>
          </div>
          <div className="field">
            <div className="field-head"><label htmlFor="seed">Random seed</label></div>
            <input
              id="seed"
              type="number"
              min="0"
              max="999999"
              value={settings.seed}
              onChange={(e) => updateSetting('seed', Number(e.target.value))}
            />
          </div>

          <div className="divider" />
          <h2 className="section-title">Reciprocity algorithms</h2>
          <div className="algorithm-row">
            <span className="strategy-dot" style={{ background: STRATEGY_COLOURS.prop }} />
            <span className="strategy-row">
              <span>
                <strong>Proportional share</strong>
              </span>
            </span>
          </div>
          <div className="algorithm-row">
            <span className="strategy-dot" style={{ background: STRATEGY_COLOURS.unchoke }} />
            <span className="strategy-row">
              <span>
                <strong>Reciprocity based on unchoking</strong>
              </span>
            </span>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="run-button" type="button" onClick={handleRunSimulation} disabled={isRunning}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m8 5 11 7-11 7z" />
            </svg>
            {isRunning ? 'Running…' : 'Run experiment'}
          </button>
        </aside>

        <main className="main">
          <section className="panel intro">
            <div>
              <h2>Swarm completion</h2>
              <p>Comparing completion time depending on reciprocity algorithm.</p>
            </div>
            <div className="run-meta">
              {experiment ? (
                <>
                  <br />
                  {experiment.network.peerIds.length} peers · {experiment.network.freeRiderIds.length} free riders · {experiment.network.seedIds.length} seeds · {experiment.durationMinutes} min · seed {experiment.seed}
                </>
              ) : (
                <><br />Set parameters and run</>
              )}
            </div>
          </section>

          <section className="panel table-panel">
            <div className="table-head">
              <h3>End-of-run results</h3>
              <span>
                {experiment
                  ? `${experiment.network.fileSizeMB} MB file · ${experiment.network.pieceCount} pieces at 256 KiB`
                  : ''}
              </span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Reciprocity algorithm</th>
                    <th>Average completion</th>
                    <th>Completed peers</th>
                    <th>First peer finish time</th>
                    <th>Last peer finish time</th>
                    <th>Mean finish time</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={result.strategy}>
                      <td>
                        <span
                          className="strategy-dot"
                          style={{ background: STRATEGY_COLOURS[result.strategy] }}
                        />
                        {STRATEGY_NAMES[result.strategy]}
                      </td>
                      <td>{formatNumber(result.finalCompletion, 1)}%</td>
                      <td>{result.completed} / {result.peerCount}</td>
                      <td>{formatFinishTime(result.firstFinishMinutes)}</td>
                      <td>{formatFinishTime(result.lastFinishMinutes)}</td>
                      <td>
                        {result.meanFinishMinutes === null
                          ? '—'
                          : `${formatNumber(result.meanFinishMinutes, 1)} min (${result.finishedTimesCount})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="chart-grid">
            <ChartPanel
              experiment={experiment}
              results={results}
              chartType="completion"
              title="Average swarm completion vs time"
              description="Mean time for peers to download the entire file"
            />
            <ChartPanel
              experiment={experiment}
              results={results}
              chartType="completed"
              title="Completed peers vs time"
              description="Number of peers that have downloaded the entire file"
            />
          </div>

          <div className="note">
            <strong>Model assumptions.</strong> The file is split into 256 KiB pieces, with a shorter final piece if required. Seeds start with all the pieces, peers start with no pieces. All nodes have a base 20 mbps upload rate and 100 mbps download rate which is scaled with their multipliers. Peers can only upload pieces that they own or have completely downloaded, using the rarest first rule, and they can only upload to neighbours who still need pieces. Each step simulates 10 seconds. The model assumes a fixed number of nodes and does not account for new arrivals, departures, or network behaviour. 
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
