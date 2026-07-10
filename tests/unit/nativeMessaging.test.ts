import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { NativeMessageReader, writeNativeMessage } from "../../src/bridge/nativeMessaging.js";

function frame(message: unknown): Buffer {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  writeNativeMessage(stream, message);
  return Buffer.concat(chunks);
}

describe("native messaging framing", () => {
  it("writes a little-endian length-prefixed JSON frame", () => {
    const data = frame({ hello: "world" });
    const size = data.readUInt32LE(0);
    expect(size).toBe(data.length - 4);
    expect(JSON.parse(data.subarray(4).toString("utf8"))).toEqual({ hello: "world" });
  });

  it("parses fragmented and back-to-back messages", () => {
    const input = new PassThrough();
    const received: unknown[] = [];
    const onError = vi.fn();
    new NativeMessageReader(input, (message) => received.push(message), onError);
    const data = Buffer.concat([frame({ n: 1 }), frame({ n: 2 })]);
    input.write(data.subarray(0, 3));
    input.write(data.subarray(3, 11));
    input.write(data.subarray(11));
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without crashing the parser", () => {
    const input = new PassThrough();
    const onError = vi.fn();
    new NativeMessageReader(input, vi.fn(), onError);
    const payload = Buffer.from("not-json");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    input.write(Buffer.concat([header, payload]));
    expect(onError).toHaveBeenCalledOnce();
  });
});
