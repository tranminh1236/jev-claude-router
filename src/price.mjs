// List-price estimates, USD per million tokens, as of this file's last edit. Anthropic's
// published pricing changes without notice and per-account discounts vary, so these are
// estimates only — overridable by editing this table, not by environment variable, this round.
export const PRICE_TABLE = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-5": { input: 15, output: 75, cacheRead: 1.5 },
};

const PER_MILLION = 1_000_000;

/**
 * USD cost of one turn's usage against a model's list price. Cache writes bill as input
 * (Anthropic's own billing treats a cache-creation token as an input token write).
 */
export function costOf(modelId, usage) {
  const price = PRICE_TABLE[modelId];
  if (!price || !usage) return null;
  const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0 } = usage;
  return (
    ((inputTokens + cacheCreationTokens) * price.input +
      outputTokens * price.output +
      cacheReadTokens * price.cacheRead) /
    PER_MILLION
  );
}

/** Sums actual vs. a hypothetical baseline-model cost across decision-log rows with usage. */
export function computeSavings(rows, { baselineModel }) {
  let actualUsd = 0;
  let baselineUsd = 0;
  let rowsWithUsage = 0;
  let rowsWithoutUsage = 0;
  for (const row of rows) {
    const actual = costOf(row.servedModel, row.usage);
    if (actual === null) {
      rowsWithoutUsage++;
      continue;
    }
    rowsWithUsage++;
    actualUsd += actual;
    baselineUsd += costOf(baselineModel, row.usage) ?? 0;
  }
  return { actualUsd, baselineUsd, savedUsd: baselineUsd - actualUsd, rowsWithUsage, rowsWithoutUsage };
}
