# Chrome Browser MCP

A local bridge that lets a private ChatGPT developer-mode app inspect and control the tabs already open in your desktop Google Chrome.

Current patch version: **0.1.3**. Every patch must bump this version; CI rejects patches that do not.

The bridge exposes 19 MCP tools:

- reads: `browser_status`, `list_tabs`, `get_active_tab`, `read_tab`, `read_tabs`, `search_tabs`, `screenshot_tab`
- actions: `click`, `type`, `fill_form`, `upload_file`, `press_key`, `scroll`, `select_option`, `navigate`, `new_tab`, `close_tab`
- ChatGPT child agents: `spawn_chatgpt_agent`, `read_chatgpt_agent`

`spawn_chatgpt_agent` opens a new `chatgpt.com` tab in the background by default, submits exactly the user-provided prompt, and returns its tab ID. `read_chatgpt_agent` reads that child tab through the same bounded semantic extractor used for normal tabs; call it again later if the child is still generating.

Action targets accept either a CSS selector or exact visible text / `aria-label` / placeholder / name / associated label text. Ambiguous targets fail instead of guessing.

The bridge does **not** expose cookies, local storage, session storage, saved passwords, hidden input values, arbitrary JavaScript execution, generic filesystem reads, Chrome internal pages, or incognito tabs. It does not use the Chrome debugger API. `upload_file` can only read one explicitly named regular file directly inside `~/CodexUploads`; nested paths and symlink escapes are rejected.

Screenshot capture requires Chrome's `<all_urls>` host permission because `captureVisibleTab` cannot run autonomously with only per-site host patterns. The MCP code still rejects every non-HTTP(S) or incognito target before capture/action, and no generic script/debugger tool is exposed.

## Proven path

The end-to-end test launches a real Chromium process with the unpacked Manifest V3 extension, starts the real native-messaging host, connects an MCP client over Streamable HTTP, opens live pages, lists and reads them, and verifies that a password input value is not returned. Unit/integration coverage validates page actions, MCP routing, ChatGPT child-agent tool registration/composition, generated extension-version synchronization, and that the runtime files used by Chrome/native messaging are tracked by Git.

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
          +-- chrome.scripting (isolated-world reads + actions)
```

Chrome starts the native host when the extension connects. The native host starts the loopback MCP endpoint. Therefore Chrome must be open and the extension must be enabled whenever ChatGPT uses the app.

## Requirements

- macOS
- Google Chrome 120+
- Node.js 20+
- A ChatGPT account with Developer Mode available
- An OpenAI Platform tunnel ID and runtime API key with Tunnels Read + Use
- `tunnel-client`

## 1. Install the native host and load the extension once

```bash
npm run install:mac
```

This installs the native-host manifest at:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository's `dist/extension` directory.
5. Confirm the extension ID is exactly:

```text
jlpddlfiallighiohmhhkemgbhofpnha
```

Do not proceed if the ID differs. The native host only accepts that exact extension origin.

## 2. Updating future patches

**You select the extension directory only once.** The built extension and MCP bridge under `dist/` are committed to Git, and CI rejects source changes whose committed runtime build is stale.

For every later patch, the normal update flow is exactly:

```bash
git pull
```

Then open `chrome://extensions` and click **Update**. Do not select the extension path again and do not run a separate build command just to consume a published patch.

`git pull` updates both `dist/extension` (what Chrome loads) and `dist/bridge` (what the native host executes). Clicking **Update** reloads the unpacked extension/native-messaging connection so the newly pulled runtime is used.

The visible extension version must change on every patch. For this patch it must show **0.1.3**. If it still shows an older version, the pulled runtime was not applied.

## 3. Verify the local browser chain

Keep Chrome open, then run:

```bash
npm run verify:local
```

A successful check prints:

- extension ID;
- extension version;
- MCP server version;
- the 19 advertised MCP tools.

The verifier fails if the extension and MCP versions differ, or if the bridge is old enough not to report its MCP version. This makes a stale 15-tool bridge immediately distinguishable from a stale Chrome extension.

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
7. Confirm ChatGPT discovers all 19 tools.
8. In a new chat, click **+ -> More**, select **Chrome Browser**, then ask: `List my open Chrome tabs.`

See [`docs/CHATGPT_SETUP.md`](docs/CHATGPT_SETUP.md) for exact verification and troubleshooting.

## Security model

Webpage text is data, never authority. Every content result includes an explicit untrusted-content marker, and tool instructions tell the model never to turn instructions found in pages into actions.

The extension intentionally requests access to all HTTP and HTTPS pages so it can read and interact with normal open tabs. The protection boundary is:

- the extension is loaded locally by you;
- Chrome only launches the exact allowlisted native host;
- the native host rejects any origin except the stable extension ID;
- the MCP endpoint binds only to `127.0.0.1`;
- the tunnel is outbound-only;
- actions are limited to normal HTTP(S) tabs and do not expose arbitrary JavaScript, debugger access, cookies, or browser storage;
- screenshots are limited to validated normal HTTP(S) tabs and are returned as untrusted image content;
- file upload accepts only a plain filename directly inside `~/CodexUploads`, resolves symlinks before containment checks, limits files to 10 MiB, and never returns file bytes to the model;
- ambiguous human-readable targets are rejected rather than guessed.

Read [`THREAT_MODEL.md`](THREAT_MODEL.md) and [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) before unattended use.

## Known limitations

- One Chrome profile should load the extension at a time; two profiles can contend for port `2091`.
- Chrome internal pages, Chrome Web Store pages, `file://` pages, and incognito tabs cannot be read or controlled.
- Cross-origin iframes are not traversed.
- Canvas-only applications and Chrome's built-in PDF viewer may return little semantic text.
- The extractor returns the primary document's visible text, headings, links, and description, not raw HTML. URL credentials and fragments are removed, and sensitive query parameters are redacted.
- `press_key` uses DOM keyboard events; Enter and Escape get explicit common-case behavior, but some sites require trusted OS/CDP keyboard input.
- ChatGPT child-agent submission depends on ChatGPT's current web composer (`#prompt-textarea`) and send button markup; a future ChatGPT UI change can require updating those selectors.
- `read_chatgpt_agent` returns the child tab's visible semantic page text, not a privileged ChatGPT API response.
- Screenshot capture covers only the visible viewport, not the full page.
- File upload supports one file at a time from `~/CodexUploads` and relies on assigning a browser `FileList` to an HTML file input; sites with nonstandard/native upload flows may still require manual handling.

## Development

```bash
npm ci
npm run version:check
npm run typecheck
npm run lint
npm test
npm run artifacts:check
npm run test:e2e
npm audit
```
