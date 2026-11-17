import { RECIPROCITY_LEVELS } from "./resultAdapters.js";

const finiteOrNull = (value) => value === null || Number.isFinite(value);
const validResult = (result, peerCount) => {
  if (!result || !["hybrid", "prop", "unchoke"].includes(result.strategy))
    return false;
  if (!Number.isInteger(result.peerCount) || result.peerCount !== peerCount)
    return false;
  if (
    !Array.isArray(result.times) ||
    result.times.length === 0 ||
    !result.times.every(Number.isFinite)
  )
    return false;
  if (
    !Array.isArray(result.averageCompletion) ||
    result.averageCompletion.length !== result.times.length ||
    !result.averageCompletion.every(Number.isFinite)
  )
    return false;
  if (
    !Array.isArray(result.completedPeers) ||
    result.completedPeers.length !== result.times.length ||
    !result.completedPeers.every(Number.isInteger)
  )
    return false;
  if (
    !Array.isArray(result.completionTimesSeconds) ||
    result.completionTimesSeconds.length !== peerCount ||
    !result.completionTimesSeconds.every(finiteOrNull)
  )
    return false;
  if (
    ![
      result.finalCompletion,
      result.completed,
      result.completionFraction,
      result.finishedTimesCount,
      result.elapsedSeconds,
    ].every(Number.isFinite)
  )
    return false;
  if (
    ![
      result.firstFinishMinutes,
      result.swarmFinishSeconds,
      result.meanFinishMinutes,
      result.meanAllPeersFinishSeconds,
    ].every(finiteOrNull)
  )
    return false;
  return ["complete", "deadline"].includes(result.termination);
};

const validConfig = (config) => {
  if (!config || !Array.isArray(config.nodeConfigs)) return false;
  if (
    !Number.isInteger(config.peerCount) ||
    config.peerCount < 1 ||
    config.peerCount > 59
  )
    return false;
  if (config.nodeConfigs.length !== config.peerCount + 1) return false;
  if (
    config.nodeConfigs.filter((node) => node.role === "peer").length !==
    config.peerCount
  )
    return false;
  if (config.nodeConfigs.filter((node) => node.role === "seed").length !== 1)
    return false;
  if (
    ![
      config.fileSizeMB,
      config.heterogeneity,
      config.freeRiderRatio,
      config.meanOnlineSeconds,
      config.meanOfflineSeconds,
      config.seed,
    ].every(Number.isFinite)
  )
    return false;
  if (
    !Number.isInteger(config.seed) ||
    config.seed < 0 ||
    config.seed > 4294967295
  )
    return false;
  if (config.fileSizeMB <= 0 || config.fileSizeMB > 1024) return false;
  if (
    config.heterogeneity < 0 ||
    config.heterogeneity > 1 ||
    config.freeRiderRatio < 0 ||
    config.freeRiderRatio > 1
  )
    return false;
  if (
    config.meanOnlineSeconds <= 0 ||
    config.meanOfflineSeconds <= 0 ||
    typeof config.churnEnabled !== "boolean"
  )
    return false;
  if (
    !Number.isInteger(config.freeRiderCount) ||
    config.freeRiderCount < 0 ||
    config.freeRiderCount > config.peerCount
  )
    return false;
  return true;
};

export const isValidExperiment = (data) => {
  const config = data?.config;
  if (data?.schemaVersion !== 1 || !validConfig(config)) return false;
  if (![config.alphaS, config.alphaB].every(Number.isFinite)) return false;
  if (
    config.alphaS < 0 ||
    config.alphaS > 1 ||
    config.alphaB < 0 ||
    config.alphaB > 1
  )
    return false;
  if (
    !data.network ||
    !Array.isArray(data.network.peerIds) ||
    data.network.peerIds.length !== config.peerCount
  )
    return false;
  if (!Array.isArray(data.network.seedIds) || data.network.seedIds.length !== 1)
    return false;
  if (
    !Array.isArray(data.network.freeRiderIds) ||
    data.network.freeRiderIds.length !== config.freeRiderCount
  )
    return false;
  if (!Number.isFinite(data.durationMinutes) || data.durationMinutes <= 0)
    return false;
  if (!Array.isArray(data.results) || data.results.length !== 3) return false;
  if (new Set(data.results.map((result) => result.strategy)).size !== 3)
    return false;
  return data.results.every((result) => validResult(result, config.peerCount));
};

export const isValidSweep = (data) => {
  const config = data?.config;
  if (data?.schemaVersion !== 1 || !validConfig(config)) return false;
  if (
    !Array.isArray(data.seeds) ||
    data.seeds.length !== 1 ||
    data.seeds[0] !== config.seed
  )
    return false;
  if (
    !Array.isArray(data.alphas) ||
    data.alphas.length !== RECIPROCITY_LEVELS.length ||
    !RECIPROCITY_LEVELS.every((level) => data.alphas.includes(level))
  )
    return false;
  if (!Array.isArray(data.repetitions) || data.repetitions.length !== 1)
    return false;
  const repetition = data.repetitions[0];
  if (
    repetition.seed !== config.seed ||
    !Array.isArray(repetition.comparisons) ||
    repetition.comparisons.length !== 27
  )
    return false;
  const seen = new Set();
  for (const comparison of repetition.comparisons) {
    if (!validResult(comparison?.result, config.peerCount)) return false;
    const key =
      comparison.result.strategy === "hybrid"
        ? `${comparison.alphaS}:${comparison.alphaB}`
        : comparison.result.strategy;
    if (seen.has(key)) return false;
    if (
      comparison.result.strategy === "hybrid" &&
      (!RECIPROCITY_LEVELS.includes(comparison.alphaS) ||
        !RECIPROCITY_LEVELS.includes(comparison.alphaB))
    )
      return false;
    if (
      comparison.result.strategy !== "hybrid" &&
      comparison.family !== "reference"
    )
      return false;
    seen.add(key);
  }
  return seen.size === 27 && seen.has("prop") && seen.has("unchoke");
};
