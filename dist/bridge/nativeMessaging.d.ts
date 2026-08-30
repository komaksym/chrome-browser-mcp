import type { Readable, Writable } from "node:stream";
/** Decodes length-prefixed Chrome Native Messaging frames from a readable stream. */
export declare class NativeMessageReader {
    private readonly onMessage;
    private readonly onProtocolError;
    private readonly onTransportError;
    private buffer;
    /** Connects stream events to message, protocol-error, and transport-error callbacks. */
    constructor(input: Readable, onMessage: (message: unknown) => void, onProtocolError: (error: Error) => void, onTransportError?: (error: Error) => void);
    /** Appends a stream chunk and emits every complete decoded Native Messaging payload. */
    feed(chunk: Buffer): void;
}
/** Writes one length-prefixed Native Messaging frame while enforcing Chrome's host-to-extension limit. */
export declare function writeNativeMessage(output: Writable, message: unknown): void;
