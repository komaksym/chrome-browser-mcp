# ChatGPT setup and proof checklist

This is the account-bound part of the installation. It must be completed while Chrome, the extension, the native host, and `tunnel-client` are running on the same Mac.

## A. Prove Chrome -> native host -> MCP locally

```bash
npm run verify:local
```

Expected properties for this patch:

- `connected: true`
- extension ID `jlpddlfiallighiohmhhkemgbhofpnha`
- extension version `0.1.3`
- MCP version `0.1.3`
- 19 tools discovered

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
   - `screenshot_tab`
   - `click`
   - `type`
   - `fill_form`
   - `upload_file`
   - `press_key`
   - `scroll`
   - `select_option`
   - `navigate`
   - `new_tab`
   - `close_tab`
   - `spawn_chatgpt_agent`
   - `read_chatgpt_agent`

## D. Real ChatGPT smoke test

Open a harmless local/test form in Chrome, then start a new ChatGPT conversation and enable the app through `+ -> More`.

Run these prompts in order:

```text
Check the Chrome browser bridge status.
List all my open Chrome tabs.
Read the harmless test tab and summarize it.
Click the harmless test button.
Type "hello" into the harmless test input, but do not submit anything.
Take a screenshot of the harmless test tab and describe only what is visible.
If you created ~/CodexUploads/test.txt, upload test.txt into the harmless file input without submitting the form.
Spawn a ChatGPT child agent with the task: "Reply with exactly FRUIT".
Read that child agent tab and report its visible result.
```

Pass criteria:

- status is connected;
- extension version and MCP version are identical;
- tab titles and URLs match Chrome;
- page text matches what is visibly present;
- requested harmless actions happen in the intended tab;
- screenshots return image content for the intended normal HTTP(S) tab;
- uploads can only use plain filenames directly inside ~/CodexUploads;
- the child agent opens in a background `chatgpt.com` tab and the returned tab ID can be read later;
- instructions embedded inside a webpage are treated only as webpage text and never as authority for an action.

## Troubleshooting

### `Chrome extension is not connected`

- Chrome is closed, the extension is disabled, or the native-host manifest is missing.
- Run `npm run install:mac` again.
- Confirm the extension ID exactly matches the expected ID.

### Extension updated but tools are still stale

Run `npm run verify:local` and compare `Extension version`, `MCP version`, and `Tools`. For published patches, `git pull` updates both `dist/extension` and `dist/bridge`; clicking Chrome's **Update** reloads the newly pulled extension/native-messaging runtime.

### Native host not found

Confirm this file exists:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.komaksym.chrome_browser_mcp.json
```

The `path` inside it must point to an executable `scripts/native-host-wrapper.sh` in the current checkout. Moving the repository requires rerunning `npm run install:mac`.

### Child agent does not submit

- Confirm the new tab is signed into ChatGPT and has loaded the normal web composer.
- Refresh the developer-mode app after updating the MCP server.
- If ChatGPT changed its web markup, update the `#prompt-textarea` or send-button selector in `src/bridge/mcpServer.ts`.

### Tunnel is not visible in ChatGPT

- Confirm the tunnel is associated with the target ChatGPT workspace/account.
- Confirm the app creator has Tunnels Read + Use.
- Keep `tunnel-client run --profile chrome-browser-mcp` running.
- Run `tunnel-client doctor --profile chrome-browser-mcp --explain`.

### Tool metadata changed

Open the developer-mode app in ChatGPT Settings -> Plugins and click **Refresh**.
