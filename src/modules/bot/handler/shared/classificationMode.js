function isTruthy(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function toPercent(rawValue, fallback) {
  if (rawValue == null || String(rawValue).trim() === "") return fallback;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n);
}

function stableBucketPercent(key) {
  const text = String(key || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

/**
 * Node-эвристики квалификации (smallTalk/service/pricing objections).
 * Приоритет:
 * 1) NODE_LEGACY_CLASSIFICATION (1/0)
 * 2) HF_CORTEX_CLASSIFIER_SOURCE ("node"|"cortex")
 * По умолчанию: cortex.
 */
export function isLegacyNodeClassificationEnabled(env = process.env) {
  const legacyRaw = env?.NODE_LEGACY_CLASSIFICATION;
  if (legacyRaw != null && String(legacyRaw).trim() !== "") {
    return isTruthy(legacyRaw);
  }

  const source = String(env?.HF_CORTEX_CLASSIFIER_SOURCE || "")
    .trim()
    .toLowerCase();
  if (!source) return false;
  return source === "node" || source === "legacy";
}

export function isCortexClassifierEnabled(env = process.env) {
  return !isLegacyNodeClassificationEnabled(env);
}

/**
 * Canary rollout для Cortex-классификации:
 * - 100: Cortex для всех диалогов (по умолчанию)
 * - 0:  fallback на legacy-классификацию
 * - 1..99: детерминированный процент по dialogId
 */
export function getCortexCanaryPercent(env = process.env) {
  return toPercent(env?.HF_CORTEX_CANARY_PERCENT, 100);
}

export function resolveClassifierModeForDialog(dialogId, env = process.env) {
  if (isLegacyNodeClassificationEnabled(env)) return "legacy";

  const canaryPercent = getCortexCanaryPercent(env);
  if (canaryPercent >= 100) return "cortex";
  if (canaryPercent <= 0) return "legacy";

  const bucket = stableBucketPercent(dialogId || "unknown");
  return bucket < canaryPercent ? "cortex" : "legacy";
}

export function isShadowComparisonEnabled(env = process.env) {
  return isTruthy(env?.HF_CORTEX_SHADOW_COMPARE);
}

export function getShadowSamplePercent(env = process.env) {
  return toPercent(env?.HF_CORTEX_SHADOW_SAMPLE_PERCENT, 100);
}

export function shouldRunShadowForDialog(dialogId, env = process.env) {
  if (!isShadowComparisonEnabled(env)) return false;

  const samplePercent = getShadowSamplePercent(env);
  if (samplePercent >= 100) return true;
  if (samplePercent <= 0) return false;

  const bucket = stableBucketPercent(dialogId || "unknown");
  return bucket < samplePercent;
}

/**
 * Быстрый OEM-путь в Node (fastOemFlow) — это legacy-оптимизация.
 * По умолчанию включен только в legacy режиме классификации.
 * Можно принудительно включить/выключить через NODE_FAST_OEM_PATH.
 */
export function isFastOemPathEnabled(env = process.env, legacyClassificationOverride = null) {
  const fastPathRaw = env?.NODE_FAST_OEM_PATH;
  if (fastPathRaw != null && String(fastPathRaw).trim() !== "") {
    return isTruthy(fastPathRaw);
  }
  if (typeof legacyClassificationOverride === "boolean") {
    return legacyClassificationOverride;
  }
  return isLegacyNodeClassificationEnabled(env);
}

export default {
  getCortexCanaryPercent,
  getShadowSamplePercent,
  isShadowComparisonEnabled,
  isLegacyNodeClassificationEnabled,
  isCortexClassifierEnabled,
  isFastOemPathEnabled,
  resolveClassifierModeForDialog,
  shouldRunShadowForDialog,
};
