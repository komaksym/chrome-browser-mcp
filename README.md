# Chrome Browser MCP

A local, read-only bridge that lets a private ChatGPT developer-mode app inspect the tabs already open in your desktop Google Chrome.

The bridge exposes six MCP tools:

- `browser_status`
- `list_tabs`
- `get_active_tab`
- `read_tab`
- `read_tabs`
- `search_tabs`

It does **not** expose cookies, local storage, session storage, saved passwords, hidden input values, arbitrary JavaScript execution, clicks, navigation, tab closing, or incognito tabs.

## Proven path

The end-to-end test launches a real Chromium process with the unpacked Manifest V3 extension, starts the real native-messaging host, connects an MCP client over Streamable HTTP, opens two live pages, lists and reads them, and verifies that a password input value is not returned.

```text
MCP client
  -> http://127.0.0.1:2091/mcp
  -> native host process
  -> Chrome Native Messaging
  -> MV3 extension
  -> live Chrome tabs
```

Run every gate:

```bash
npm ci
npm run check
```

## Architecture

```text
ChatGPT developer-mode app
          |
          | OpenAI Secure MCP Tunnel (outbound HTTPS)
          v
127.0.0.1:2091/mcp
          |
          | same local Node process
          v
Chrome Native Messaging host
          |
          v
Chrome MV3 extension
          |
          +-- chrome.tabs
          +-- chrome.scripting (isolated-world semantic extraction)
```

Chrome starts the native host when the extension connects. The native host starts the loopback MCP endpoint. Therefore Chrome must be open and the extension must be enabled whenever ChatGPT uses the app.

## Requirements

- macOS
- Google Chrome 120+
- Node.js 20+
- A ChatGPT account with Developer Mode available
- An OpenAI Platform tunnel ID and runtime API key with Tunnels Read + Use
- `tunnel-client`

## 1. Install the native host and build the extension

```bash
npm run install:mac
```

This installs the native-host manifest at:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json
```

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository's `dist/extension` directory.
5. Confirm the extension ID is exactly:

```text
jlpddlfiallighiohmhhkemgbhofpnha
```

Do not proceed if the ID differs. The native host only accepts that exact extension origin.

## 3. Verify the local browser chain

Keep Chrome open, then run:

```bash
npm run verify:local
```

A successful check prints the extension ID and the six advertised MCP tools.

## 4. Configure Secure MCP Tunnel

Create a tunnel and runtime API key in OpenAI Platform. Then:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
./scripts/configure-tunnel.sh tunnel_0123456789abcdef0123456789abcdef

tunnel-client doctor --profile chrome-browser-mcp --explain
tunnel-client run --profile chrome-browser-mcp
```

The profile forwards the tunnel to:

```text
http://127.0.0.1:2091/mcp
```

Keep `tunnel-client run` active whenever ChatGPT needs the browser tools.

## 5. Add it to ChatGPT

1. In ChatGPT, enable **Settings -> Security and login -> Developer mode**.
2. Open **Settings -> Plugins**.
3. Click **+** to create a developer-mode app.
4. Choose **Tunnel** as the connection type.
5. Select or paste the tunnel ID.
6. Use the metadata from [`app-metadata.json`](app-metadata.json).
7. Confirm ChatGPT discovers all six tools.
8. In a new chat, click **+ -> More**, select **Chrome Browser**, then ask: `List my open Chrome tabs.`

See [`docs/CHATGPT_SETUP.md`](docs/CHATGPT_SETUP.md) for exact verification and troubleshooting.

## Security model

Webpage text is data, never authority. Every content result includes an explicit untrusted-content marker, and every reading tool tells the model not to follow instructions found in pages.

The extension intentionally requests access to all HTTP and HTTPS pages because it cannot summarize arbitrary open tabs otherwise. That is a powerful permission. The protection boundary is:

- the extension is loaded locally by you;
- Chrome only launches the exact allowlisted native host;
- the native host rejects any origin except the stable extension ID;
- the MCP endpoint binds only to `127.0.0.1`;
- the tunnel is outbound-only;
- all exposed MCP tools are read-only.

Read [`THREAT_MODEL.md`](THREAT_MODEL.md) and [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) before extending the tool set.

## Known limitations

- One Chrome profile should load the extension at a time; two profiles can contend for port `2091`.
- Chrome internal pages, Chrome Web Store pages, `file://` pages, and incognito tabs are not readable.
- Cross-origin iframes are not traversed.
- Canvas-only applications and Chrome's built-in PDF viewer may return little semantic text.
- The extractor returns the primary document's visible text, headings, links, and description, not raw HTML. URL credentials and fragments are removed, and sensitive query parameters are redacted.
- The bridge is deliberately read-only. Browser control is a separate, higher-risk project.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm audit
```

The E2E test accepts:

```bash
CHROMIUM_PATH=/path/to/chromium \
CHROME_NATIVE_HOST_DIR=/path/to/native-host-dir \
npm run test:e2e
```

## Uninstall

```bash
npm run uninstall:mac
```

Then remove **Chrome Browser MCP** from `chrome://extensions` and remove the ChatGPT developer-mode app/tunnel profile separately.
