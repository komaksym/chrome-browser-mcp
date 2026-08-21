import type { Readable, Writable } from "node:stream";
export declare class NativeMessageReader {
    private readonly onMessage;
    private readonly onError;
    private buffer;
    constructor(input: Readable, onMessage: (message: unknown) => void, onError: (error: Error) => void);
    feed(chunk: Buffer): void;
}
export declare function writeNativeMessage(output: Writable, message: unknown): void;
