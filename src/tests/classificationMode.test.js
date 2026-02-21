import assert from "node:assert/strict";
import test from "node:test";

import {
  getCortexCanaryPercent,
  getShadowSamplePercent,
  isCortexClassifierEnabled,
  isFastOemPathEnabled,
  isLegacyNodeClassificationEnabled,
  isShadowComparisonEnabled,
  resolveClassifierModeForDialog,
  shouldRunShadowForDialog,
} from "../modules/bot/handler/shared/classificationMode.js";

test("classificationMode: defaults to cortex classifier", () => {
  const env = {};
  assert.equal(isLegacyNodeClassificationEnabled(env), false);
  assert.equal(isCortexClassifierEnabled(env), true);
});

test("classificationMode: HF_CORTEX_CLASSIFIER_SOURCE=node enables legacy mode", () => {
  const env = { HF_CORTEX_CLASSIFIER_SOURCE: "node" };
  assert.equal(isLegacyNodeClassificationEnabled(env), true);
  assert.equal(isCortexClassifierEnabled(env), false);
});

test("classificationMode: NODE_LEGACY_CLASSIFICATION has priority over source", () => {
  const env = {
    HF_CORTEX_CLASSIFIER_SOURCE: "cortex",
    NODE_LEGACY_CLASSIFICATION: "1",
  };
  assert.equal(isLegacyNodeClassificationEnabled(env), true);
  assert.equal(isCortexClassifierEnabled(env), false);
});

test("classificationMode: fast OEM path follows legacy mode by default", () => {
  assert.equal(isFastOemPathEnabled({}), false);
  assert.equal(
    isFastOemPathEnabled({ HF_CORTEX_CLASSIFIER_SOURCE: "node" }),
    true,
  );
});

test("classificationMode: NODE_FAST_OEM_PATH overrides legacy inference", () => {
  assert.equal(
    isFastOemPathEnabled({
      HF_CORTEX_CLASSIFIER_SOURCE: "node",
      NODE_FAST_OEM_PATH: "0",
    }),
    false,
  );
  assert.equal(
    isFastOemPathEnabled({
      HF_CORTEX_CLASSIFIER_SOURCE: "cortex",
      NODE_FAST_OEM_PATH: "1",
    }),
    true,
  );
});

test("classificationMode: canary percent defaults to 100 and is clamped", () => {
  assert.equal(getCortexCanaryPercent({}), 100);
  assert.equal(getCortexCanaryPercent({ HF_CORTEX_CANARY_PERCENT: "-5" }), 0);
  assert.equal(getCortexCanaryPercent({ HF_CORTEX_CANARY_PERCENT: "250" }), 100);
});

test("classificationMode: canary=0 forces legacy even in cortex mode", () => {
  const env = {
    HF_CORTEX_CLASSIFIER_SOURCE: "cortex",
    NODE_LEGACY_CLASSIFICATION: "0",
    HF_CORTEX_CANARY_PERCENT: "0",
  };
  assert.equal(resolveClassifierModeForDialog("chat-canary-1", env), "legacy");
});

test("classificationMode: canary sampling is stable for same dialog", () => {
  const env = {
    HF_CORTEX_CLASSIFIER_SOURCE: "cortex",
    NODE_LEGACY_CLASSIFICATION: "0",
    HF_CORTEX_CANARY_PERCENT: "37",
  };
  const first = resolveClassifierModeForDialog("chat-stable-42", env);
  const second = resolveClassifierModeForDialog("chat-stable-42", env);
  assert.equal(first, second);
});

test("classificationMode: shadow flags and sampling", () => {
  const envDisabled = { HF_CORTEX_SHADOW_COMPARE: "0", HF_CORTEX_SHADOW_SAMPLE_PERCENT: "100" };
  assert.equal(isShadowComparisonEnabled(envDisabled), false);
  assert.equal(shouldRunShadowForDialog("chat-shadow-1", envDisabled), false);

  const envEnabled = { HF_CORTEX_SHADOW_COMPARE: "1", HF_CORTEX_SHADOW_SAMPLE_PERCENT: "0" };
  assert.equal(isShadowComparisonEnabled(envEnabled), true);
  assert.equal(getShadowSamplePercent(envEnabled), 0);
  assert.equal(shouldRunShadowForDialog("chat-shadow-1", envEnabled), false);
});
