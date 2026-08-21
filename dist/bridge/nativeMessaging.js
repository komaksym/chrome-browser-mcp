const MAX_INBOUND_BYTES = 64 * 1024 * 1024;
const MAX_OUTBOUND_BYTES = 1024 * 1024;
export class NativeMessageReader {
    onMessage;
    onError;
    buffer = Buffer.alloc(0);
    constructor(input, onMessage, onError) {
        this.onMessage = onMessage;
        this.onError = onError;
        input.on("data", (chunk) => this.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        input.on("error", (error) => this.onError(error));
    }
    feed(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const size = this.buffer.readUInt32LE(0);
            if (size > MAX_INBOUND_BYTES) {
                this.onError(new Error(`Native message exceeds ${MAX_INBOUND_BYTES} bytes`));
                this.buffer = Buffer.alloc(0);
                return;
            }
            if (this.buffer.length < size + 4)
                return;
            const payload = this.buffer.subarray(4, size + 4);
            this.buffer = this.buffer.subarray(size + 4);
            try {
                this.onMessage(JSON.parse(payload.toString("utf8")));
            }
            catch (error) {
                this.onError(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
}
export function writeNativeMessage(output, message) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.length > MAX_OUTBOUND_BYTES) {
        throw new Error(`Native message exceeds Chrome's ${MAX_OUTBOUND_BYTES}-byte host-to-extension limit`);
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    output.write(Buffer.concat([header, payload]));
}
//# sourceMappingURL=nativeMessaging.js.map