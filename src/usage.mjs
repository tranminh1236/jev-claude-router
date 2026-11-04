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

const MAX_BYTES = 65536;

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
 * that tee's copy independently of the untouched original. Decoded text is capped at the last
 * 65536 bytes seen. A decompression failure, or a stream with nothing usable in it, appends
 * nothing - a broken capture must stay invisible rather than write a misleading row.
 */
export function captureUsage({ stream, reqId, file }) {
  try {
    const tee = new PassThrough();
    stream.pipe(tee);

    const encoding = (stream.headers?.["content-encoding"] || "").toLowerCase();
    const decompressor = decompressorFor(encoding);
    const source = decompressor ? tee.pipe(decompressor) : tee;

    let text = "";
    let failed = false;

    source.on("data", (chunk) => {
      text = (text + chunk.toString("utf8")).slice(-MAX_BYTES);
    });
    source.on("error", () => {
      failed = true;
    });
    if (decompressor) {
      decompressor.on("error", () => {
        failed = true;
      });
    }

    source.on("end", () => {
      if (failed) return;
      try {
        const usage = extractUsage(text);
        const servedModel = extractServedModel(text);
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
