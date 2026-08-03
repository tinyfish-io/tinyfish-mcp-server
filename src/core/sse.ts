/**
 * Incremental SSE parser over a ReadableStream<Uint8Array>.
 *
 * Handles chunk boundaries
 * anywhere — mid-line, mid-event, mid-CRLF, even mid-UTF-8-codepoint (the
 * streaming TextDecoder holds partial sequences) — per the SSE processing
 * model:
 *
 * - Lines end with LF or CRLF (upstream sends LF; CRLF tolerated).
 * - `data:` field values accumulate; multi-line data is joined with "\n".
 * - `event:` / `id:` fields are tolerated and surfaced (currently unused
 *   upstream — every real frame is a bare `data:` line).
 * - `:` comment lines are consumed, never forwarded.
 * - `retry:` and unknown fields are ignored.
 * - A blank line dispatches the pending event; blocks without any `data:`
 *   field dispatch nothing (spec behavior — comments/ids alone are dropped).
 * - A stream that ends without a trailing blank line still dispatches its
 *   pending event.
 *
 * Each yielded event carries BOTH the parsed JSON and the raw joined data
 * payload string, so a relaying transport can pipe upstream's original bytes
 * through untouched instead of re-serializing.
 *
 * Teardown: breaking out of (or throwing from) a for-await over this
 * generator runs its return path, which ends the inner for-await over the
 * stream and cancels the ReadableStream — no orphaned upstream reads.
 */
import { UpstreamProtocolError } from "./errors.js";

export interface SseEvent {
  /** The data payload parsed as JSON (every upstream frame is one JSON-RPC message). */
  message: unknown;
  /**
   * The exact data payload string: field values of every `data:` line in the
   * block, joined with "\n". Relay this verbatim (re-split on "\n" into
   * `data:` lines when re-framing) to preserve upstream's bytes.
   */
  rawData: string;
  /** `event:` field value, if the block carried one (unused upstream). */
  event?: string;
  /** `id:` field value, if the block carried one (unused upstream). */
  id?: string;
}

/**
 * Parse an SSE byte stream into events. Throws UpstreamProtocolError when a
 * data payload is not valid JSON; stream read failures propagate as-is (the
 * consumer maps them to transport errors).
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] | null = null;
  let eventField: string | undefined;
  let idField: string | undefined;

  /** Fold one complete line into the pending event; return it when dispatched. */
  const processLine = (line: string): SseEvent | undefined => {
    if (line === "") {
      // Blank line: dispatch the pending event, if it carried any data.
      const pending = dataLines;
      const event = eventField;
      const id = idField;
      dataLines = null;
      eventField = undefined;
      idField = undefined;
      if (pending === null) return undefined;
      const rawData = pending.join("\n");
      return { message: parseJsonPayload(rawData), rawData, event, id };
    }
    if (line.startsWith(":")) return undefined; // comment — consumed
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // spec: strip one leading space
    switch (field) {
      case "data":
        (dataLines ??= []).push(value);
        break;
      case "event":
        eventField = value;
        break;
      case "id":
        idField = value;
        break;
      default:
        // retry: and unknown fields — ignored.
        break;
    }
    return undefined;
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      // CRLF: the CR waits in the buffer until its LF arrives, so a CRLF pair
      // split across chunks needs no special casing — just strip it here.
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = processLine(line);
      if (event !== undefined) yield event;
    }
  }

  // Stream ended: flush the decoder's partial UTF-8 state and any final line
  // without a trailing newline, then dispatch a pending event (tolerate a
  // stream that ends without the final blank line).
  buffer += decoder.decode();
  if (buffer.length > 0) {
    let line = buffer;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const event = processLine(line);
    if (event !== undefined) yield event;
  }
  const flushed = processLine("");
  if (flushed !== undefined) yield flushed;
}

/**
 * Every upstream frame must be a JSON-RPC message. An empty `data:` payload is
 * therefore a protocol violation too (JSON.parse("") throws): it surfaces as
 * UpstreamProtocolError, same as any other non-JSON payload.
 */
function parseJsonPayload(rawData: string): unknown {
  try {
    return JSON.parse(rawData);
  } catch (err) {
    throw new UpstreamProtocolError("Upstream SSE frame is not valid JSON", undefined, {
      cause: err,
    });
  }
}
