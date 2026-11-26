/**
 * Forwarding an agent turn to the upstream API, with one retry for the errors that mean the
 * connection died rather than the request being wrong.
 *
 * Node keeps HTTP(S) sockets in a keep-alive pool, and a Mac that has slept comes back with
 * that pool full of sockets the other end forgot hours ago. The first forward after a wake
 * picks one up and is answered with an RST - `read ECONNRESET`, or `socket hang up` if nothing
 * came back at all. The same window also tends to catch DNS before the interface is up
 * (`getaddrinfo ENOTFOUND api.anthropic.com`). None of these say anything about the request, so
 * handing them to Claude Code as a 502 turns a dead socket into a visible "connection reset" in
 * the middle of a session. One retry on a socket outside the pool clears all of them.
 */
import { setTimeout as delay } from "node:timers/promises";

/**
 * Errors that describe a connection, not a request. `EAI_AGAIN` is a DNS lookup that timed
 * out rather than resolving to nothing, which is the shape a wake usually takes.
 */
export const TRANSIENT_UPSTREAM_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);

/** A reply that never arrived, as opposed to one the API refused to give. */
export function isTransientUpstreamError(err) {
  if (!err) return false;
  if (TRANSIENT_UPSTREAM_CODES.has(err.code)) return true;
  // Node reports a socket closed before any reply as this, with no code attached.
  return /socket hang up/i.test(err.message ?? "");
}

/**
 * Sends `body` upstream and hands the reply to `onResponse`. A transient failure before any of
 * the reply has been handed on is retried once, off the keep-alive pool; anything else - and
 * any failure after the reply has started - goes to `onError`, which is where each proxy's
 * existing 502 lives.
 *
 * The retry re-sends the body, which is safe precisely because it is limited to failures where
 * no reply came back: the upstream either never saw the request or never answered it. Once a
 * single byte of a reply has been handed to the client, retrying would send a second copy of a
 * half-read answer, so it does not happen.
 *
 * @param {object} args
 * @param {{ request: Function }} args.request      `http` or `https`
 * @param {object} args.options                     options for `request.request`
 * @param {Buffer | null} args.body                 request body, if any
 * @param {(upstream: object) => void} args.onResponse
 * @param {(err: Error) => void} args.onError
 * @param {() => boolean} args.replyStarted         true once the client has seen part of a reply
 * @param {(line: string) => void} [args.debug]
 * @param {number} [args.retryDelayMs]              a beat for an interface still coming up
 */
export function forwardWithRetry({
  request,
  options,
  body,
  onResponse,
  onError,
  replyStarted,
  debug = () => {},
  retryDelayMs = 150,
}) {
  let retried = false;
  // A reply that arrived is a reply, even if the socket dies while it is being read.
  let answered = false;

  const attempt = (attemptOptions) => {
    const upstream = request.request(attemptOptions, (response) => {
      answered = true;
      onResponse(response);
    });
    upstream.on("error", (err) => {
      const retryable = !retried && !answered && !replyStarted() && isTransientUpstreamError(err);
      if (!retryable) return void onError(err);
      retried = true;
      debug(`upstream ${err.message}, retrying once on a fresh socket`);
      // `agent: false` is the point of the retry: a connection of its own, so a dead socket
      // still sitting in the shared pool cannot be handed out again.
      delay(retryDelayMs).then(() => attempt({ ...attemptOptions, agent: false }));
    });
    if (body?.length) upstream.write(body);
    upstream.end();
  };

  attempt(options);
}
