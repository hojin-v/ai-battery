function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function firstFiniteEntry(source, keys) {
  for (const key of [keys].flat().filter(Boolean)) {
    const value = source?.[key];
    if (Number.isFinite(value)) return { key, value };
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return { key, value: numeric };
    }
  }
  return null;
}

function firstFiniteValue(source, keys) {
  return firstFiniteEntry(source, keys)?.value ?? null;
}

function keyUsesFractionalPercent(key) {
  return /(?:ratio|fraction|utilization)$/i.test(String(key));
}

function percentValue(value, options = {}) {
  if (!Number.isFinite(value)) return null;
  return options.scaleFraction && value >= 0 && value <= 1 ? value * 100 : value;
}

function firstPercentValue(source, keys) {
  const entry = firstFiniteEntry(source, keys);
  if (!entry) return null;
  return percentValue(entry.value, {
    scaleFraction: keyUsesFractionalPercent(entry.key)
  });
}

function usageInputTokens(usage) {
  if (!usage) return null;
  const inputTokens = firstFiniteValue(usage, ["input_tokens", "inputTokens"]);
  const cacheCreationTokens = firstFiniteValue(usage, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
  const cacheReadTokens = firstFiniteValue(usage, ["cache_read_input_tokens", "cacheReadInputTokens"]);
  if (
    !Number.isFinite(inputTokens)
    && !Number.isFinite(cacheCreationTokens)
    && !Number.isFinite(cacheReadTokens)
  ) {
    return null;
  }
  return (Number(inputTokens) || 0) + (Number(cacheCreationTokens) || 0) + (Number(cacheReadTokens) || 0);
}

function resetEpochSeconds(value) {
  if (Number.isFinite(value)) return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return resetEpochSeconds(numeric);
    const millis = Date.parse(value);
    if (!Number.isNaN(millis)) return Math.floor(millis / 1000);
  }
  return null;
}

function normalizeLimit(limit, options = {}) {
  if (!limit) return null;

  const usedKeys = options.usedKey || "used_percent";
  const remainingKeys = [options.remainingKey].flat().filter(Boolean);
  const windowMinutes = options.windowMinutes ?? limit?.window_minutes ?? limit?.windowMinutes ?? null;
  const usedValue = firstPercentValue(limit, usedKeys);
  const remainingValue = firstPercentValue(limit, remainingKeys);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetsAtSeconds = resetEpochSeconds(limit.resets_at ?? limit.resetsAt ?? limit.reset_at ?? limit.resetAt);
  const resetPassed = Number.isFinite(resetsAtSeconds) && resetsAtSeconds <= nowSeconds;
  const inferResetPassed = options.inferResetPassed !== false;

  if (!Number.isFinite(usedValue) && !Number.isFinite(remainingValue) && !(resetPassed && inferResetPassed)) return null;

  let usedPercent = resetPassed && inferResetPassed
    ? 0
    : Number.isFinite(usedValue)
      ? clamp(Math.round(usedValue), 0, 100)
      : clamp(100 - Math.round(remainingValue), 0, 100);
  let remainingPercent = resetPassed && inferResetPassed
    ? 100
    : Number.isFinite(remainingValue)
      ? clamp(Math.round(remainingValue), 0, 100)
      : clamp(100 - usedPercent, 0, 100);

  return {
    usedPercent,
    remainingPercent,
    windowMinutes,
    resetsAt: resetsAtSeconds ? new Date(resetsAtSeconds * 1000).toISOString() : null,
    resetsInSeconds: resetsAtSeconds ? Math.max(0, resetsAtSeconds - nowSeconds) : null,
    resetPassed
  };
}

function cacheAgeSeconds(timestamp) {
  if (!timestamp) return null;
  const millis = Date.parse(timestamp);
  if (Number.isNaN(millis)) return null;
  return Math.max(0, Math.floor((Date.now() - millis) / 1000));
}
export {
  cacheAgeSeconds,
  clamp,
  firstFiniteEntry,
  firstFiniteValue,
  firstPercentValue,
  keyUsesFractionalPercent,
  normalizeLimit,
  percentValue,
  resetEpochSeconds,
  usageInputTokens
};