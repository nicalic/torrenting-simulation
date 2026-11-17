import { useEffect, useMemo, useRef, useState } from "react";
import { DEADLINE_SECONDS } from "./resultAdapters.js";
import PlotFigure from "./PlotFigure.jsx";
import { experimentTraces } from "./experimentPlotData.js";
import { areaAt, simulationTimeAt } from "./raceData.js";

const axis = (title, extra = {}) => ({
  title,
  gridcolor: "#e3e8ec",
  zeroline: false,
  ...extra,
});

function Panel({ title, description, action, children }) {
  return (
    <section className="panel chart-panel">
      <div className="chart-head experiment-chart-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function ExperimentCharts({ rows }) {
  const areaRef = useRef(null);
  const frameRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  const traces = useMemo(() => experimentTraces(rows), [rows]);
  const play = () => {
    cancelAnimationFrame(frameRef.current);
    setPlaying(true);
    let startedAt = null;
    let lastAreaDraw = -Infinity;
    const tick = (now) => {
      startedAt ??= now;
      const simulationTime = simulationTimeAt(now - startedAt);
      if (now - lastAreaDraw >= 30 || simulationTime === DEADLINE_SECONDS) {
        const points = rows.map((row) => areaAt(row, simulationTime));
        areaRef.current?.restyle(
          {
            x: points.map((point) => point.x),
            y: points.map((point) => point.y),
          },
          rows.map((_, index) => index),
        );
        lastAreaDraw = now;
      }
      if (simulationTime < DEADLINE_SECONDS)
        frameRef.current = requestAnimationFrame(tick);
      else {
        frameRef.current = null;
        setPlaying(false);
      }
    };
    tick(performance.now());
  };
  const areaLayout = useMemo(
    () => ({
      xaxis: axis("Elapsed simulation time (s)", {
        range: [0, DEADLINE_SECONDS],
      }),
      yaxis: axis("Completed initial leechers", {
        autorange: true,
        rangemode: "tozero",
        dtick: rows[0]?.peerCount > 24 ? 5 : rows[0]?.peerCount > 12 ? 2 : 1,
      }),
      showlegend: true,
      legend: { orientation: "h", y: -0.24 },
    }),
    [rows],
  );
  const boxesLayout = useMemo(
    () => ({
      xaxis: axis("Policy"),
      yaxis: axis("Completion time (s)", { autorange: true }),
      showlegend: false,
    }),
    [],
  );
  return (
    <div className="chart-grid">
      <Panel
        title="Completed peers over time"
        description="Cumulative completed initial leechers for each policy."
        action={
          <button
            type="button"
            className="small-button"
            onClick={play}
            disabled={playing}
          >
            Play race
          </button>
        }
      >
        <PlotFigure
          ref={areaRef}
          data={traces.area}
          layout={areaLayout}
          className="completed-area-figure"
        />
      </Panel>
      <Panel
        title="Completed peers' finish times"
        description="Distribution of finish times among peers that completed before the deadline."
      >
        {traces.boxes.length > 0 ? (
          <PlotFigure data={traces.boxes} layout={boxesLayout} />
        ) : (
          <p className="empty-chart">No peers finished before the deadline.</p>
        )}
        <p className="chart-summary">
          {rows
            .map(
              (row) =>
                `${row.policyName}: ${row.finishedTimesSeconds.length} finished, ${row.unfinishedCount} unfinished`,
            )
            .join(" · ")}
        </p>
      </Panel>
    </div>
  );
}
