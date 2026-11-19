export const simulationTimeAt = (elapsedMilliseconds) =>
  Math.min(180, (elapsedMilliseconds / 5000) * 180);

export const areaAt = (row, simulationTime) => {
  const times = row.series.timesSeconds;
  const values = row.series.completedPeers;
  let end = 0;
  while (end + 1 < times.length && times[end + 1] <= simulationTime + 1e-8)
    end += 1;
  const x = times.slice(0, end + 1);
  const y = values.slice(0, end + 1);
  if (x.at(-1) < simulationTime) {
    x.push(simulationTime);
    y.push(y.at(-1));
  }
  return { x, y };
};
