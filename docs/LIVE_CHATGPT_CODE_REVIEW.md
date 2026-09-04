# Live strict code-review smoke

This is an opt-in end-to-end check for issue #37. It uses a real headed Google
Chrome process, a fresh ChatGPT parent conversation, the visible ChatGPT app
picker, the local MV3/native-messaging/MCP stack, and the configured tunnel.
The parent must route the request through `@skills-mcp /code-review`, create
exactly two independent worker conversations, and return both verified results.

## One-time setup

1. Build and verify the committed runtime artifacts in a clean checkout.
2. Set `LIVE_CHATGPT_PROFILE_DIR` to a new persistent directory outside this
   repository and outside your normal Chrome profile tree.
3. Open Google Chrome once with that directory as its user data directory and
   sign in to ChatGPT manually. Complete MFA or other bootstrap steps yourself;
   the smoke test never handles credentials, cookies, or storage.
4. In ChatGPT developer mode, add both `skills-mcp` and the dedicated
   `chrome-mcp` app to the profile. The Chrome MCP app must point at the tunnel
   profile used below.

The profile is retained between runs so authentication and app configuration do
not need to be repeated. The runner closes only browser targets created during
its current run.

Configure a dedicated tunnel profile, for example:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
./scripts/configure-tunnel.sh tunnel_0123456789abcdef0123456789abcdef \
  chrome-browser-mcp-live-smoke http://127.0.0.1:2191/mcp
```

Keep the API key in the shell environment. Do not put it in this repository or
in a test artifact.

## Run

```bash
export LIVE_CHATGPT_PROFILE_DIR="/absolute/path/to/chrome-browser-mcp-live-profile"
npm run test:e2e:live:code-review
```

The command starts its own isolated bridge on port `2191` behind a unique
run-scoped MCP path, provisions a unique native-host manifest without
replacing the normal manifest and restores/removes it on normal exit or
SIGINT/SIGTERM, uses the
dedicated tunnel profile `chrome-browser-mcp-live-smoke`, fetches and records
the canary's current base/head refs and SHAs, and prints a bounded JSON success
report.

Useful overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LIVE_CHATGPT_CANARY` | `komaksym/chrome-browser-mcp#34` | `owner/repo#pull-request` canary |
| `LIVE_CHATGPT_PROFILE_DIR` | `~/.chrome-browser-mcp/live-smoke/chrome-profile` | Dedicated persistent Chrome profile |
| `LIVE_CHATGPT_TUNNEL_PROFILE` | `chrome-browser-mcp-live-smoke` | Dedicated tunnel-client profile |
| `LIVE_CHATGPT_MCP_PORT` | `2191` | Isolated loopback MCP port |
| `LIVE_CHATGPT_CHROME_PATH` | installed Google Chrome | Explicit Chrome executable |
| `LIVE_CHATGPT_WORKFLOW_TIMEOUT_MS` | `600000` | Overall worker/collection phase timeout |
| `LIVE_CHATGPT_ARTIFACT_DIR` | system temp directory | Sanitized failure artifacts |

The run also accepts `LIVE_CHATGPT_SKILLS_MCP_APP_LABEL` and
`LIVE_CHATGPT_CHROME_MCP_APP_LABEL` when the visible ChatGPT app names differ.
The normal bridge ports `2091` and `2093` are rejected to prevent accidentally
using a user's normal browser bridge.

## Failure evidence and safety

Failures are classified as authentication, profile, Chrome, native host,
extension, tunnel/app, endpoint collision, canary, worker, workflow, or
artifact failures. Screenshots, a Playwright trace, target IDs/types/windows,
run identity, marker state, and pinned canary metadata are written outside the
repository under the configured artifact directory. The structured JSON strips
URLs to origin and path and excludes page text, titles, credentials, cookies,
and storage; screenshots and traces are browser captures, so keep the artifact
directory private and inspect them before sharing.

The runner deliberately does not mock `chatgpt.com`, call `spawn_agents`,
`collect_agents`, or `cancel_agents` from the test, use a hidden ChatGPT API, or
replace the parent with a synthetic conversation. It only uses the public MCP
client for setup/status and read-only active-tab focus checks; the acceptance
path is the parent ChatGPT UI and the parent's own MCP calls.
