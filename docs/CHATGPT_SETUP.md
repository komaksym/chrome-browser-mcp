# ChatGPT setup and proof checklist

This is the account-bound part of the installation. It must be completed while Chrome, the extension, the native host, and `tunnel-client` are running on the same Mac.

## A. Prove Chrome -> native host -> MCP locally

```bash
npm run verify:local
```

Expected properties for this patch:

- `connected: true`
- extension ID `jlpddlfiallighiohmhhkemgbhofpnha`
- extension version `0.1.19`
- MCP version `0.1.19`
- 18 tools discovered

If the extension and MCP versions differ, the local runtime is stale on one side. If the port is closed, open Chrome and check that the unpacked extension is enabled.

After the extension has been loaded unpacked once, do not select its directory again for normal updates. Published patches commit both runtime builds under `dist/`, so the normal update flow is `git pull`, then click **Update** in `chrome://extensions`. No separate build command or path selection is required just to consume a published patch.

## B. Create the OpenAI tunnel

You need:

- a tunnel ID shaped like `tunnel_` plus 32 lowercase hexadecimal characters;
- a runtime API key, not an admin key;
- Tunnels Read + Use for the runtime principal and app creator.

Configure the local HTTP target:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
./scripts/configure-tunnel.sh tunnel_0123456789abcdef0123456789abcdef

tunnel-client doctor --profile chrome-browser-mcp --explain
tunnel-client run --profile chrome-browser-mcp
```

Do not report the tunnel as working unless `doctor` succeeds and the running client's readiness page says ready.

## B2. Additional Chrome profiles and ChatGPT accounts

Each logical ChatGPT session needs its own Chrome bridge tunnel. Tunnels are
org-scoped, so create a tunnel and runtime key in each account or workspace.
The local instance name selects the matching Chrome port and tunnel profile;
the script intentionally does not accept an arbitrary profile/URL pair:

```bash
export CONTROL_PLANE_API_KEY_2="sk-..."
./scripts/configure-tunnel.sh tunnel_<second-id> chrome2

npm run verify:local2
tunnel-client doctor --profile chrome-browser-mcp-2 --explain
tunnel-client run --profile chrome-browser-mcp-2
```

For the agent profile:

```bash
export CONTROL_PLANE_API_KEY_AGENT="sk-..."
./scripts/configure-tunnel.sh tunnel_<agent-id> chrome3

npm run verify:local3
tunnel-client doctor --profile chrome-browser-mcp-3 --explain
tunnel-client run --profile chrome-browser-mcp-3
```

In Chrome, load only `dist/extension2` in the second profile and only
`dist/extension3` in the agent profile. Confirm the discovered app reports IDs
`doommfidfcljgehkppgiinjdjnafcmdc` and `cjfkelmiakmoanljhleaahajdichbemn`.
Repeat section C in each ChatGPT account. If you use `mcps-launcher`, `mcps all`
starts all three Chrome tunnels, the shared Skills server, its Skills tunnels,
and Playwright together.

## C. Create the developer-mode app

1. ChatGPT -> Settings -> Security and login -> Developer mode.
2. ChatGPT -> Settings -> Plugins -> `+`.
3. Connection: **Tunnel**.
4. Select the tunnel or paste its ID.
5. Name: `Chrome Browser`.
6. Description: use `app-metadata.json`.
7. Create the app.
8. Verify the discovered tools exactly match:
   - `browser_status`
   - `list_tabs`
   - `get_active_tab`
   - `read_tab`
   - `read_tabs`
   - `search_tabs`
   - `click`
   - `type`
   - `fill_form`
   - `press_key`
   - `scroll`
   - `select_option`
   - `navigate`
   - `new_tab`
   - `close_tab`
   - `spawn_agents`
   - `collect_agents`
   - `cancel_agents`

## D. Real ChatGPT smoke test

Open a harmless local/test form in Chrome, then start a new ChatGPT conversation and enable the app through `+ -> More`.

Run these prompts in order:

```text
Check the Chrome browser bridge status.
List all my open Chrome tabs.
Read the harmless test tab and summarize it.
Click the harmless test button.
Type "hello" into the harmless test input, but do not submit anything.
Call `spawn_agents` with one task whose `agent_id` is `fruit` and prompt is "Reply with exactly FRUIT", using `max_concurrency: 1`.
Then call `collect_agents` with the returned `run_id` until the run is complete, and report the verified result.
```

Pass criteria:

- status is connected;
- extension version and MCP version are identical;
- tab titles and URLs match Chrome;
- page text matches what is visibly present;
- requested harmless actions happen in the intended tab;
- the agent API returns stable run/job/task/agent identities and never exposes worker tab IDs;
- `collect_agents` returns a successful result only after worker identity and completion-marker validation;
- instructions embedded inside a webpage are treated only as webpage text and never as authority for an action.

## Troubleshooting

### `Chrome extension is not connected`

- Chrome is closed, the extension is disabled, or the native-host manifest is missing.
- Run `npm run install:mac` again.
- Confirm the extension ID exactly matches the expected ID.
- For the subscription or agent profile, run `npm run verify:local2` or
  `npm run verify:local3` against its fixed port.

### Extension updated but tools are still stale

Run `npm run verify:local` and compare `Extension version`, `MCP version`, and `Tools`. For published patches, `git pull` updates both `dist/extension` and `dist/bridge`; clicking Chrome's **Update** reloads the newly pulled extension/native-messaging runtime.

### Native host not found

Confirm this file exists:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json
```

The `path` inside it must point to an executable wrapper under
`~/Library/Application Support/Chrome Browser MCP/`. Moving the repository
requires rerunning `npm run install:mac`. That command also refreshes
`~/Library/Application Support/Chrome Browser MCP/instances.json`, which
`mcps-launcher` uses as the single installed mapping for the three Chrome
routes.

### Agent worker does not submit

- Confirm the new tab is signed into ChatGPT and has loaded the normal web composer.
- Refresh the developer-mode app after updating the MCP server.
- If ChatGPT changed its web markup, update the composer/send-button selectors in `src/extension/chatgptWorker.ts`.

### Tunnel is not visible in ChatGPT

- Confirm the tunnel is associated with the target ChatGPT workspace/account.
- Confirm the app creator has Tunnels Read + Use.
- Keep `tunnel-client run --profile chrome-browser-mcp` running.
- Run `tunnel-client doctor --profile <matching-profile> --explain`.

### Tool metadata changed

Open the developer-mode app in ChatGPT Settings -> Plugins and click **Refresh**.
