/**
 * Unit tests for the incremental SSE parser (src/core/sse.ts): chunk
 * boundaries anywhere, multi-line data, comments, CRLF, event:/id: fields,
 * huge frames, raw-payload fidelity.
 */
import { describe, expect, it } from "vitest";
import { UpstreamProtocolError } from "../src/core/errors.js";
import { parseSseStream, type SseEvent } from "../src/core/sse.js";

const encoder = new TextEncoder();

/** A ReadableStream that enqueues each given chunk (string or bytes) as-is. */
function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

/** Split a string's UTF-8 bytes into chunks of `size` bytes (may split codepoints). */
function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.slice(i, i + size));
  }
  return chunks;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }
  return events;
}

describe("parseSseStream", () => {
  it("parses a simple single-frame stream and preserves the raw payload", async () => {
    const events = await collect(streamOf('data: {"a":1}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].message).toEqual({ a: 1 });
    expect(events[0].rawData).toBe('{"a":1}');
    expect(events[0].event).toBeUndefined();
    expect(events[0].id).toBeUndefined();
  });

  it("parses multiple frames in order", async () => {
    const events = await collect(streamOf('data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n'));
    expect(events.map((e) => e.message)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("handles an event split across chunks mid-line and mid-event", async () => {
    const events = await collect(
      streamOf('da', 'ta: {"sp', 'lit":tr', "ue}\n", "\ndata: ", '{"next":2}\n\n')
    );
    expect(events.map((e) => e.message)).toEqual([{ split: true }, { next: 2 }]);
    expect(events[0].rawData).toBe('{"split":true}');
  });

  it("joins multi-line data with \\n and preserves the joined raw payload", async () => {
    // JSON tolerates embedded newlines between tokens, so the joined payload
    // still parses while proving multi-line reassembly.
    const events = await collect(streamOf('data: {"a":\ndata: 1}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].rawData).toBe('{"a":\n1}');
    expect(events[0].message).toEqual({ a: 1 });
  });

  it("consumes comment lines without forwarding them", async () => {
    const events = await collect(
      streamOf(': heartbeat comment\n\ndata: {"a":1,\n: mid-event comment\ndata: "b":2}\n\n')
    );
    // The comment-only block dispatches nothing; the data block survives
    // intact with the comment line dropped from between its data lines.
    expect(events).toHaveLength(1);
    expect(events[0].rawData).toBe('{"a":1,\n"b":2}');
    expect(events[0].message).toEqual({ a: 1, b: 2 });
  });

  it("handles CRLF line endings, including a CRLF pair split across chunks", async () => {
    const events = await collect(streamOf('data: {"crlf":1}\r\n\r', '\ndata: {"crlf":2}\r\n\r\n'));
    expect(events.map((e) => e.message)).toEqual([{ crlf: 1 }, { crlf: 2 }]);
    expect(events[0].rawData).toBe('{"crlf":1}');
  });

  it("tolerates event: and id: fields and surfaces them on the yielded item", async () => {
    const events = await collect(streamOf('event: message\nid: 42\ndata: {"a":1}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message");
    expect(events[0].id).toBe("42");
    expect(events[0].message).toEqual({ a: 1 });
  });

  it("ignores retry: and unknown fields and field-name-only lines", async () => {
    const events = await collect(
      streamOf('retry: 3000\nunknown: x\nnocolonline\ndata: {"a":1}\n\n')
    );
    expect(events).toHaveLength(1);
    expect(events[0].rawData).toBe('{"a":1}');
  });

  it("strips exactly one leading space from field values", async () => {
    // "data:  x" → value " x" (only the first space is field-syntax).
    const events = await collect(streamOf('data:  " padded"\n\ndata:"tight"\n\n'));
    expect(events[0].rawData).toBe(' " padded"');
    expect(events[0].message).toBe(" padded");
    expect(events[1].rawData).toBe('"tight"');
    expect(events[1].message).toBe("tight");
  });

  it("reassembles a huge frame split over many small chunks", async () => {
    const big = { blob: "x".repeat(256 * 1024), tail: [1, 2, 3] };
    const payload = JSON.stringify(big);
    const text = `data: ${payload}\n\ndata: {"after":true}\n\n`;
    const events = await collect(streamOf(...byteChunks(text, 1024)));
    expect(events).toHaveLength(2);
    expect(events[0].rawData).toBe(payload);
    expect(events[0].message).toEqual(big);
    expect(events[1].message).toEqual({ after: true });
  });

  it("decodes multi-byte UTF-8 characters split across chunk boundaries", async () => {
    const text = 'data: {"emoji":"🐟🐟🐟"}\n\n';
    // 3-byte chunks guarantee the 4-byte emoji codepoints straddle boundaries.
    const events = await collect(streamOf(...byteChunks(text, 3)));
    expect(events).toHaveLength(1);
    expect(events[0].message).toEqual({ emoji: "🐟🐟🐟" });
  });

  it("dispatches a trailing event when the stream ends without a blank line", async () => {
    const events = await collect(streamOf('data: {"a":1}\n\ndata: {"tail":true}'));
    expect(events.map((e) => e.message)).toEqual([{ a: 1 }, { tail: true }]);
  });

  it("dispatches nothing for blocks without a data field", async () => {
    const events = await collect(streamOf("event: ping\nid: 7\n\n: comment only\n\n"));
    expect(events).toHaveLength(0);
  });

  it("preserves non-canonical JSON payload bytes verbatim in rawData", async () => {
    const raw = '{ "spaced" : true , "arr" : [ 1 , 2 ] }';
    const events = await collect(streamOf(`data: ${raw}\n\n`));
    expect(events[0].rawData).toBe(raw);
    expect(events[0].message).toEqual({ spaced: true, arr: [1, 2] });
  });

  it("throws UpstreamProtocolError on a non-JSON data payload", async () => {
    await expect(collect(streamOf("data: not json\n\n"))).rejects.toBeInstanceOf(
      UpstreamProtocolError
    );
  });

  it("throws UpstreamProtocolError on an empty data payload (every frame must be JSON-RPC)", async () => {
    await expect(collect(streamOf("data:\n\n"))).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  it("cancels the underlying stream when the consumer breaks early", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"n":1}\n\ndata: {"n":2}\n\n'));
        // Never closes — an un-canceled reader would hang forever.
      },
      cancel() {
        canceled = true;
      },
    });
    for await (const event of parseSseStream(stream)) {
      expect(event.message).toEqual({ n: 1 });
      break;
    }
    expect(canceled).toBe(true);
  });
});
