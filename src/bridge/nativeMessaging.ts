import type { Readable, Writable } from "node:stream";

const MAX_INBOUND_BYTES = 64 * 1024 * 1024;
const MAX_OUTBOUND_BYTES = 1024 * 1024;

/** Decodes length-prefixed Chrome Native Messaging frames from a readable stream. */
export class NativeMessageReader {
  private buffer = Buffer.alloc(0);

  /** Connects stream events to message, protocol-error, and transport-error callbacks. */
  constructor(
    input: Readable,
    private readonly onMessage: (message: unknown) => void,
    private readonly onProtocolError: (error: Error) => void,
    private readonly onTransportError: (error: Error) => void = onProtocolError,
  ) {
    input.on("data", (chunk: Buffer | string) => this.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    input.on("error", (error) => this.onTransportError(error));
  }

  /** Appends a stream chunk and emits every complete decoded Native Messaging payload. */
  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > MAX_INBOUND_BYTES) {
        this.onProtocolError(new Error(`Native message exceeds ${MAX_INBOUND_BYTES} bytes`));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < size + 4) return;
      const payload = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      try {
        this.onMessage(JSON.parse(payload.toString("utf8")) as unknown);
      } catch (error) {
        this.onProtocolError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

/** Writes one length-prefixed Native Messaging frame while enforcing Chrome's host-to-extension limit. */
export function writeNativeMessage(output: Writable, message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_OUTBOUND_BYTES) {
    throw new Error(`Native message exceeds Chrome's ${MAX_OUTBOUND_BYTES}-byte host-to-extension limit`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  output.write(Buffer.concat([header, payload]));
}
