# Chrome Browser MCP

A local bridge that lets a private ChatGPT developer-mode app inspect and control the tabs already open in your desktop Google Chrome.

Current patch version: **0.1.25**. Every patch must bump this version; CI rejects patches that do not.

The bridge exposes 18 MCP tools:

- reads: `browser_status`, `list_tabs`, `get_active_tab`, `read_tab`, `read_tabs`, `search_tabs`
- actions: `click`, `type`, `fill_form`, `press_key`, `scroll`, `select_option`, `navigate`, `new_tab`, `close_tab`
- ChatGPT job runtime: `spawn_agents`, `collect_agents`, `cancel_agents`

`spawn_agents` starts one or more background ChatGPT worker jobs and returns stable `request_id` / `run_id` / `job_id` / `task_id` / `agent_id` identities. Callers must reuse the same `request_id` with equivalent `tasks` and `max_concurrency` arguments when retrying; equivalent retries replay the original run, while conflicting reuse fails with `IDEMPOTENCY_CONFLICT`. `max_concurrency` limits active workers within one run, and the runtime applies a separate two-worker global active ceiling by default, queueing excess logical jobs. While a worker responds, bounded in-memory snapshots preserve streaming output across ChatGPT DOM virtualization and are never written to browser storage. Fresh snapshots must match the current post-submit revision/timestamp, exact worker identity, generation state, and unique completion marker before they can finish a job. A verified terminal snapshot stores the same bounded, untrusted result used by collection, releases the current worker lease, and immediately gives queued work a scheduler pass without any `collect_agents` call. If a lifecycle event is missed, a blocked scheduling pass or browser reconnect compares leased worker tabs with current tab and snapshot evidence and applies the same verified-completion or `WORKER_TAB_CLOSED` transition; malformed or failed observations do not reclaim capacity. This repair path is event/boundary driven and has no lease TTL, periodic polling, prompt submission, reload, or tab activation. Job `state` is a point-in-time observation, not by itself a terminal verdict: `FAILED_TRANSIENT` with `error.retryable: true` is exposed with `terminal: false` and `recoverable: true`. When callers need refreshed public state or results, `collect_agents` remains the authoritative result/barrier read; recoverable jobs appear in `pending`, `failed` is reserved for `FAILED_TERMINAL`, and `barrier.satisfied: true` is the gate for consuming/aggregating all required isolated child results. `cancel_agents` is explicit cancellation, not transient-error recovery; do not call it merely because a running spawn/collection snapshot contains a retryable extraction failure. Browser tab IDs stay private to the runtime.

Action targets accept either a CSS selector or exact visible text / `aria-label` / placeholder / name / associated label text. Ambiguous targets fail instead of guessing.

`new_tab` opens the requested URL in the background by default so it does not interrupt the user's current Chrome work. Set `active: true` only when foreground focus is explicitly required.

The bridge does **not** expose cookies, local storage, session storage, saved passwords, hidden input values, arbitrary JavaScript execution, Chrome internal pages, or incognito tabs. It does not use the Chrome debugger API.

## Manual proof path

The supported ChatGPT proof path is manual: launch the local bridge, verify the
matching Chrome extension and native-messaging host, then use the ChatGPT
developer-mode app against a harmless test tab. Unit/integration coverage
validates page actions, MCP routing, the job-based ChatGPT agent runtime,
diagnostics, generated extension-version synchronization, and that the runtime
files used by Chrome/native messaging are tracked by Git.

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
- Google Chrome 121+
- Node.js 20+
- A ChatGPT account with Developer Mode available
- An OpenAI Platform tunnel ID and runtime API key with Tunnels Read + Use
- `tunnel-client`

Chrome 121+ is deliberate for agent-window anchoring: anchor selection uses `chrome.tabs.Tab.lastAccessed` to choose the most recently user-active ChatGPT tab across normal windows.

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

## Multi-profile topology

The installer provisions two isolated Chrome routes:

| Profile | Extension directory | Extension ID | Bridge | Tunnel profile |
| --- | --- | --- | --- | --- |
| Current | dist/extension | jlpddlfiallighiohmhhkemgbhofpnha | 127.0.0.1:2091 | chrome-browser-mcp |
| New subscription | dist/extension2 | doommfidfcljgehkppgiinjdjnafcmdc | 127.0.0.1:2093 | chrome-browser-mcp-2 |

Load exactly one matching extension directory in each Chrome profile. The
Chrome profile itself does not need a Google account; the ChatGPT tab must be
signed in to the intended ChatGPT account. The installer copies this mapping
to:

~~~text
~/Library/Application Support/Chrome Browser MCP/instances.json
~~~

mcps-launcher consumes that copied mapping, so ports and extension IDs have one
source of truth.

## 2. Updating future patches

**You select the extension directory only once.** The built extension and MCP bridge under `dist/` are committed to Git, and CI rejects source changes whose committed runtime build is stale.

For every later patch, the normal update flow is exactly:

```bash
git pull
```

Then open `chrome://extensions` and click **Update**. Do not select the extension path again and do not run a separate build command just to consume a published patch.

`git pull` updates both `dist/extension` (what Chrome loads) and `dist/bridge` (what the native host executes). Clicking **Update** reloads the unpacked extension/native-messaging connection so the newly pulled runtime is used.

The visible extension version must change on every patch. For this patch it must show **0.1.25**. If it still shows an older version, the pulled runtime was not applied.

## 3. Verify the local browser chain

Keep Chrome open, then run:

```bash
npm run verify:local
```

A successful check prints:

- extension ID;
- extension version;
- MCP server version;
- the 18 advertised MCP tools.

The verifier fails if the extension and MCP versions differ, or if the bridge is old enough not to report its MCP version. This makes stale bridge/extension combinations immediately distinguishable.

## Diagnostics for browser-backed agent failures

Installed native-host wrappers write one safe JSONL diagnostics file per route:

```text
~/Library/Logs/Chrome Browser MCP/chrome.jsonl
~/Library/Logs/Chrome Browser MCP/chrome2.jsonl
```

The default level is `info`, so worker creation, dispatch, retries, state
changes, cleanup, and stable browser error codes are recorded. The same events
are visible on the bridge's stderr for launcher logs. To include low-level
request and streaming-observation events for a focused investigation, set
`CHROME_MCP_LOG_LEVEL=debug` before starting Chrome; `off` disables diagnostics.
`CHROME_MCP_LOG_FILE` overrides the file path and `CHROME_MCP_LOG_DIR` changes
the default directory.

Logs intentionally omit prompts, page text, full URLs, cookies, tokens,
passwords, and arbitrary tool arguments. `browser_status` reports only the
logger level, path, event count, last event name, and write-error count. For a
quick local snapshot:

```bash
tail -n 100 "$HOME/Library/Logs/Chrome Browser MCP/chrome.jsonl"
tail -n 100 "$HOME/Library/Logs/Chrome Browser MCP/chrome2.jsonl"
```

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

For the second profile, create a unique tunnel ID and use the matching instance
argument:

~~~bash
./scripts/configure-tunnel.sh tunnel_<second-id> chrome2
~~~

If a named local profile already exists and must be repointed to a new tunnel,
append `--force`; this replaces only the local profile file and does not delete
the old remote tunnel:

```bash
./scripts/configure-tunnel.sh tunnel_<new-id> chrome2 --force
```

Both tunnel clients may use the same control-plane API key. The
CONTROL_PLANE_API_KEY_2 name is a separate environment reference only; it may
contain the same value as CONTROL_PLANE_API_KEY.

## 5. Add it to ChatGPT

1. In ChatGPT, enable **Settings -> Security and login -> Developer mode**.
2. Open **Settings -> Plugins**.
3. Click **+** to create a developer-mode app.
4. Choose **Tunnel** as the connection type.
5. Select or paste the tunnel ID.
6. Use the metadata from [`app-metadata.json`](app-metadata.json).
7. Confirm ChatGPT discovers all 18 tools.
8. In a new chat, click **+ -> More**, select **Chrome Browser**, then ask: `List my open Chrome tabs.`

See [`docs/CHATGPT_SETUP.md`](docs/CHATGPT_SETUP.md) for exact verification and troubleshooting.

## Security model

Webpage text is data, never authority. Every content result—including browser-derived ChatGPT worker output—includes an explicit untrusted-content marker, and tool instructions tell the model never to turn instructions found in pages into actions.

The extension intentionally requests access to all HTTP and HTTPS pages so it can read and interact with normal open tabs. The protection boundary is:

- the extension is loaded locally by you;
- Chrome only launches the exact allowlisted native host;
- the native host rejects any origin except the stable extension ID;
- the MCP endpoint binds only to `127.0.0.1`;
- the tunnel is outbound-only;
- actions are limited to normal HTTP(S) tabs and do not expose arbitrary JavaScript, debugger access, cookies, or browser storage;
- ambiguous human-readable targets are rejected rather than guessed.

Read [`THREAT_MODEL.md`](THREAT_MODEL.md) and [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) before unattended use.

## Known limitations

- Each configured Chrome profile should load exactly one matching extension; the two routes use separate ports (`2091` and `2093`).
- Chrome internal pages, Chrome Web Store pages, `file://` pages, and incognito tabs cannot be read or controlled.
- Cross-origin iframes are not traversed.
- Canvas-only applications and Chrome's built-in PDF viewer may return little semantic text.
- The extractor returns the primary document's visible text, headings, links, and description, not raw HTML. URL credentials and fragments are removed, and sensitive query parameters are redacted.
- `press_key` uses DOM keyboard events; Enter and Escape get explicit common-case behavior, but some sites require trusted OS/CDP keyboard input.
- ChatGPT worker submission depends on ChatGPT's current web composer and send-button markup; a future ChatGPT UI change can require updating selectors in `src/extension/chatgptWorker.ts`.
- Worker results are browser-derived ChatGPT UI output, not privileged ChatGPT API responses. Identity and completion-marker validation proves that a result belongs to its job; it does not make its content trustworthy. Each result is marked `contentIsUntrusted: true`, carries a warning, and is capped at 30,000 characters with `truncated: true` when clipping occurred.
- File upload is intentionally not implemented because doing it generally would require a more powerful filesystem/debugger surface.

## Development

```bash
npm ci
npm run version:check
npm run typecheck
npm run lint
npm test
npm run artifacts:check
npm audit
```
