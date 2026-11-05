import { PassThrough } from "node:stream";
import { createGunzip, createBrotliDecompress, createInflate } from "node:zlib";
import { appendLine } from "./decision-log.mjs";

const FIELD_PATTERNS = {
  inputTokens: /"input_tokens":(\d+)/g,
  outputTokens: /"output_tokens":(\d+)/g,
  cacheReadTokens: /"cache_read_input_tokens":(\d+)/g,
  cacheCreationTokens: /"cache_creation_input_tokens":(\d+)/g,
};

/**
 * Extracts token-usage fields from raw (decompressed) SSE text. Anthropic repeats `usage`
 * across `message_start`/`message_delta` events in the same stream, and later values are the
 * more complete ones, so this keeps the LAST match per field rather than the first. A field
 * that never appears is omitted entirely - never defaulted to 0, which would read as "zero
 * tokens used" instead of "unknown".
 */
export function extractUsage(text) {
  const usage = {};
  for (const [key, pattern] of Object.entries(FIELD_PATTERNS)) {
    let match;
    let last;
    while ((match = pattern.exec(text)) !== null) last = match;
    if (last) usage[key] = Number(last[1]);
  }
  return usage;
}

const MODEL_PATTERN = /"model":"([^"]+)"/;

/** First `"model":"..."` id in `text`, or null when the stream never named one. */
export function extractServedModel(text) {
  const match = MODEL_PATTERN.exec(text);
  return match ? match[1] : null;
}

/**
 * How much decoded text is carried between chunks. A usage object or a `"model":"..."` pair
 * never spans more than a few hundred bytes, so this only has to be long enough that a field
 * split across a chunk boundary is still whole in `carry + chunk`.
 */
const CARRY_BYTES = 4096;

function decompressorFor(encoding) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "br":
      return createBrotliDecompress();
    case "deflate":
      return createInflate();
    default:
      return null;
  }
}

/**
 * Taps a response stream to recover token usage and the served model, purely for the decision
 * log - it must never affect the real response. It pipes into its own PassThrough tee (never
 * pausing/resuming `stream` itself) and, when the upstream used a content-encoding, decompresses
 * that tee's copy independently of the untouched original.
 *
 * Extraction runs per chunk, not once over a trailing window: Anthropic puts the served model
 * and the input/cache counts in `message_start`, at the very front of the stream, and the final
 * output-token count at the very end, so any reply long enough to push the two apart would
 * otherwise lose the front half of its own bill. Only `CARRY_BYTES` of text is held at a time.
 *
 * A decompression failure, or a stream with nothing usable in it, appends nothing - a broken
 * capture must stay invisible rather than write a misleading row. On failure the tee is also
 * unpiped and drained: `stream` is the same readable the client's response is piped from, so an
 * abandoned tee filling to its highWaterMark would backpressure the reply the user is reading.
 */
export function captureUsage({ stream, reqId, file }) {
  try {
    const tee = new PassThrough();
    stream.pipe(tee);

    const encoding = (stream.headers?.["content-encoding"] || "").toLowerCase();
    const decompressor = decompressorFor(encoding);
    const source = decompressor ? tee.pipe(decompressor) : tee;

    const usage = {};
    let servedModel = null;
    let carry = "";
    let failed = false;

    const giveUp = () => {
      if (failed) return;
      failed = true;
      stream.unpipe(tee);
      // Flowing mode with no 'data' listener discards whatever is already buffered, so the
      // tee can never hold the shared readable back again.
      tee.resume();
    };

    source.on("data", (chunk) => {
      const text = carry + chunk.toString("utf8");
      // Later values win per field (`message_delta` completes what `message_start` began);
      // the model id is whatever named itself first.
      Object.assign(usage, extractUsage(text));
      if (servedModel === null) servedModel = extractServedModel(text);
      carry = text.slice(-CARRY_BYTES);
    });
    source.on("error", giveUp);
    if (decompressor) decompressor.on("error", giveUp);

    source.on("end", () => {
      if (failed) return;
      try {
        if (Object.keys(usage).length === 0 && servedModel === null) return;
        appendLine(file, { kind: "usage", reqId, ts: Date.now(), usage, servedModel });
      } catch {
        // A broken capture must never surface - the response it was describing already went out.
      }
    });
  } catch {
    // Same rule as above: tapping the stream must never risk the real request/response path.
  }
}
