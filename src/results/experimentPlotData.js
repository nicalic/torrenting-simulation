import { STRATEGY_COLOURS } from "../simulation/constants.js";

const rgba = (hex) => {
  const components = [1, 3, 5].map((index) =>
    parseInt(hex.slice(index, index + 2), 16),
  );
  return `rgba(${components.join(",")},0.25)`;
};
export const experimentTraces = (rows) => ({
  area: rows.map((row) => ({
    type: "scatter",
    mode: "lines",
    fill: "tozeroy",
    name: row.policyName,
    x: row.series.timesSeconds,
    y: row.series.completedPeers,
    line: { color: STRATEGY_COLOURS[row.strategy], width: 2.5 },
    fillcolor: rgba(STRATEGY_COLOURS[row.strategy]),
    hovertemplate:
      "%{x:.1f} s<br>" +
      row.policyName +
      "<br>%{y:.0f} completed peers<extra></extra>",
  })),
  boxes: rows
    .filter((row) => row.finishedTimesSeconds.length > 0)
    .map((row) => ({
      type: "box",
      name: row.policyName,
      y: row.finishedTimesSeconds,
      marker: { color: STRATEGY_COLOURS[row.strategy], opacity: 0.55 },
      line: { color: STRATEGY_COLOURS[row.strategy] },
      boxpoints: "all",
      jitter: 0.25,
      pointpos: 0,
      hovertemplate: row.policyName + "<br>%{y:.1f} s<extra></extra>",
    })),
});
