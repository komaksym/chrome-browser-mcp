import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BrowserClient, type BrowserError } from "../../src/bridge/browserClient.js";
import { NativeMessageReader, writeNativeMessage } from "../../src/bridge/nativeMessaging.js";

describe("BrowserClient", () => {
  it("round-trips a request over the native messaging protocol", async () => {
    const fromExtension = new PassThrough();
    const toExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, toExtension, 2_000);

    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    const requests: unknown[] = [];
    new NativeMessageReader(
      toExtension,
      (message) => {
        requests.push(message);
        const request = message as { id: string };
        writeNativeMessage(fromExtension, { type: "response", id: request.id, result: { tabs: [] } });
      },
      (error) => {
        throw error;
      },
    );

    await expect(client.request("list_tabs")).resolves.toEqual({ tabs: [] });
    expect(requests).toHaveLength(1);
    expect(client.status()).toEqual({ connected: true, extensionVersion: "0.1.0", extensionId: "test-extension" });
  });

  it("refuses browser calls before the extension is ready", async () => {
    const client = new BrowserClient(new PassThrough(), new PassThrough(), 50);
    await expect(client.request("list_tabs")).rejects.toThrow("not connected");
  });

  it("reports a structured transient error when a browser request times out", async () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 1);
    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    await expect(client.request("list_tabs")).rejects.toEqual(
      expect.objectContaining<Partial<BrowserError>>({
        name: "BrowserError",
        code: "TIMEOUT",
        detail: "Browser request timed out: list_tabs",
      }),
    );
  });

  it("reports a structured transient error when the native connection closes", async () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    const request = client.request("list_tabs");
    fromExtension.end();

    await expect(request).rejects.toEqual(
      expect.objectContaining<Partial<BrowserError>>({
        name: "BrowserError",
        code: "BROWSER_DISCONNECTED",
        detail: "Chrome native messaging connection closed",
      }),
    );
  });

  it("reports a non-retryable protocol error for malformed native frames", async () => {
    const fromExtension = new PassThrough();
    const client = new BrowserClient(fromExtension, new PassThrough(), 2_000);
    writeNativeMessage(fromExtension, {
      type: "ready",
      extensionVersion: "0.1.0",
      extensionId: "test-extension",
    });

    const request = client.request("list_tabs");
    fromExtension.write(Buffer.from([1, 0, 0, 0, 123]));

    await expect(request).rejects.toEqual(
      expect.objectContaining<Partial<BrowserError>>({
        name: "BrowserError",
        code: "BROWSER_PROTOCOL_ERROR",
      }),
    );
  });
});
