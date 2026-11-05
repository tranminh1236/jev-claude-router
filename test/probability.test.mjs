import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.mjs";
import { THRESHOLDS } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const at = (jev, current = "opus") =>
  decide({ prompt: "what changed here", jev, current, available: ALL, contextTokens: 0 });

test("a spread distribution does not downgrade, even at high confidence", () => {
  // confidence measures how concentrated the distribution is, not how likely the top answer
  // is to be right. These two disagree exactly where the gate matters.
  const jev = { choice: "haiku", confidence: 0.95, probabilities: { haiku: 0.4, sonnet: 0.35, opus: 0.2, fable: 0.05 } };
  assert.equal(at(jev).tier, "opus");
  assert.equal(at(jev).reason, "low-confidence-no-downgrade/no-change");
});

test("a settled distribution downgrades, even at low confidence", () => {
  const jev = { choice: "haiku", confidence: 0.2, probabilities: { haiku: 0.9, sonnet: 0.06, opus: 0.03, fable: 0.01 } };
  assert.equal(at(jev).tier, "haiku");
  assert.equal(at(jev).reason, "jev");
});

test("an answer with no probabilities still works off confidence", () => {
  assert.equal(at({ choice: "haiku", confidence: 0.95 }).tier, "haiku");
  assert.equal(at({ choice: "haiku", confidence: 0.3 }).tier, "opus");
});

test("the threshold is named for what it now measures", () => {
  assert.equal(typeof THRESHOLDS.minTopProbability, "number");
  assert.equal(THRESHOLDS.minConfidence, undefined);
});
