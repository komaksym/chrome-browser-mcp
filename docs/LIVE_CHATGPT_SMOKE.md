# Isolated live ChatGPT smoke preflight

This is the opt-in, account-bound preflight for the future live ChatGPT smoke suite. It starts real headed Google Chrome, the built MV3 extension, the real native-messaging host, an isolated loopback MCP bridge, and a dedicated `tunnel-client` profile. It connects Playwright to that Chrome instance over CDP.

This preflight does **not** submit a ChatGPT prompt. Authentication, MFA, app creation, and any credentials remain manual.

## Isolation defaults

The live preflight deliberately does not use the normal Chrome MCP endpoint or your normal Chrome profile:

- Chrome profile: `~/.chrome-browser-mcp/live-smoke/chrome-profile`
- MCP endpoint: `http://127.0.0.1:2191/mcp`
- tunnel profile: `chrome-browser-mcp-live-smoke`
- canary: `komaksym/chrome-browser-mcp#34`

The runner rejects profiles inside this repository and known normal Chrome profile trees. It also fails if the isolated MCP port is already occupied instead of attaching to an existing bridge.

## 1. Install the native host and configure the dedicated tunnel once

Install the current checkout's native host first:

```bash
npm run install:mac
```

The live runner validates that installed host instead of rewriting the user-global native-host registration during the test. The spawned Chrome process inherits the isolated live-smoke MCP port, so the host starts a separate bridge process for this profile.

Use a tunnel reserved for live smoke. The helper stores the tunnel-client profile, not your runtime API key.

```bash
export LIVE_CHATGPT_MCP_PORT=2191
./scripts/configure-live-smoke-tunnel.sh tunnel_0123456789abcdef0123456789abcdef
```

Keep the runtime API key only in the shell that runs the preflight:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
```

Do not put that value in `.env`, repository files, screenshots, or test fixtures.

If you choose another port, set the same `LIVE_CHATGPT_MCP_PORT` while configuring the tunnel and while running the preflight.

## 2. Bootstrap the dedicated Chrome profile

Run:

```bash
npm run test:e2e:live:preflight -- --bootstrap
```

The runner opens the dedicated headed Chrome profile. In that Chrome window, sign into ChatGPT manually and ensure both `skills-mcp` and the Chrome MCP app are enabled for the account. The Chrome MCP app must use the dedicated live-smoke tunnel configured above.

Return to the terminal and press Enter. The runner then performs the normal preflight without writing into the ChatGPT composer.

The persistent profile is intentionally retained between runs so the authenticated ChatGPT session can be reused. Delete it manually if you want to reset that dedicated session.

## 3. Run the normal preflight

```bash
npm run test:e2e:live:preflight
```

A successful run reports only bounded setup metadata: dedicated profile path, isolated endpoint, tunnel profile, stable extension ID, MCP tool count, Chrome/extension/native-bridge/MCP versions, and the canary PR base/head refs and SHAs.

The runner performs these checks before any later smoke test is allowed to submit ChatGPT work:

- committed `dist/` artifacts rebuild cleanly;
- real Google Chrome starts with the dedicated profile and built extension;
- native messaging connects and the isolated MCP bridge becomes ready;
- extension identity is `jlpddlfiallighiohmhhkemgbhofpnha`;
- package, built manifest, extension, and MCP runtime versions match;
- expected MCP tools are advertised;
- the dedicated tunnel profile passes `tunnel-client doctor` and stays running;
- the configured canary PR resolves;
- ChatGPT is authenticated in the dedicated profile;
- ChatGPT exposes both `skills-mcp` and the Chrome MCP app.

No passwords, MFA values, cookies, tokens, screenshots, HTML dumps, or personal-profile contents are written by the runner.

## Configuration

The normal defaults should be used unless isolation requires an override:

```text
LIVE_CHATGPT_PROFILE_DIR          dedicated persistent profile outside the repo
LIVE_CHATGPT_CHROME_PATH          explicit Google Chrome executable
LIVE_CHATGPT_MCP_PORT             isolated loopback port (default 2191)
LIVE_CHATGPT_TUNNEL_PROFILE       dedicated tunnel-client profile
LIVE_CHATGPT_CANARY               owner/repo#pr (default komaksym/chrome-browser-mcp#34)
LIVE_CHATGPT_SKILLS_MCP_APP_LABEL ChatGPT label override for skills-mcp
LIVE_CHATGPT_CHROME_MCP_APP_LABEL ChatGPT label override for chrome-mcp
```

`GITHUB_TOKEN` is optional for canary lookup. If supplied, it is sent only as the GitHub API authorization header and is never printed.

## Classified setup failures

Failures are prefixed with one of these categories so setup problems are distinguishable from future product smoke failures:

```text
auth
chrome-profile
chrome
extension
native-host
tunnel-app
endpoint-collision
stale-build-artifacts
canary
```

The deterministic `npm run test:e2e` suite remains separate. Both suites use the same Chrome/native-host startup support module so extension loading, native-host registration, CDP connection, bridge readiness, diagnostics, and cleanup cannot drift into two independent harnesses.
