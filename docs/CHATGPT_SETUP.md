# ChatGPT setup and proof checklist

This is the account-bound part of the installation. It must be completed while Chrome, the extension, the native host, and `tunnel-client` are running on the same Mac.

## A. Prove Chrome -> native host -> MCP locally

```bash
npm run verify:local
```

Expected properties:

- `connected: true`
- extension ID `jlpddlfiallighiohmhhkemgbhofpnha`
- six tools discovered

If the port is closed, open Chrome and check that the unpacked extension is enabled.

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

## D. Real ChatGPT smoke test

Open two harmless pages in Chrome, then start a new ChatGPT conversation and enable the app through `+ -> More`.

Run these prompts in order:

```text
Check the Chrome browser bridge status.
List all my open Chrome tabs.
Read the two harmless test tabs and summarize each one.
Search my open tabs for a phrase from one tab title.
```

Pass criteria:

- status is connected;
- tab titles and URLs match Chrome;
- page text matches what is visibly present;
- no request asks for a write confirmation because every tool is read-only;
- instructions embedded inside a webpage are treated only as webpage text.

## Troubleshooting

### `Chrome extension is not connected`

- Chrome is closed, the extension is disabled, or the native-host manifest is missing.
- Run `npm run install:mac` again.
- Confirm the extension ID exactly matches the expected ID.

### Native host not found

Confirm this file exists:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json
```

The `path` inside it must point to an executable `scripts/native-host-wrapper.sh` in the current checkout. Moving the repository requires rerunning `npm run install:mac`.

### Tunnel is not visible in ChatGPT

- Confirm the tunnel is associated with the target ChatGPT workspace/account.
- Confirm the app creator has Tunnels Read + Use.
- Keep `tunnel-client run --profile chrome-browser-mcp` running.
- Run `tunnel-client doctor --profile chrome-browser-mcp --explain`.

### Tool metadata changed

Open the developer-mode app in ChatGPT Settings -> Plugins and click **Refresh**.
