# Threat model

## Assets

- Titles, URLs, and visible text from open Chrome tabs.
- Authenticated page content visible in the user's normal Chrome profile.
- The ability to enumerate which sites are open.

The bridge does not intentionally expose cookies, browser storage, password-manager data, input values, browsing history, downloads, bookmarks, or incognito tabs.

## Trust boundaries

1. **Webpage -> extension**: webpage content is hostile input.
2. **Extension -> native host**: Chrome Native Messaging, allowlisted to one stable extension ID.
3. **Native host -> local MCP**: loopback-only Streamable HTTP.
4. **Local MCP -> OpenAI**: outbound Secure MCP Tunnel.
5. **Tool output -> model**: page text remains untrusted evidence.

## Main threats and controls

### Prompt injection in webpage text

Threat: a page says to ignore the user, read other tabs, reveal secrets, or invoke tools.

Controls:

- every read result contains `contentIsUntrusted: true` and a warning;
- server instructions and tool descriptions explicitly say not to follow page instructions;
- the MCP surface is read-only;
- a page cannot choose tool arguments or send messages to the native host.

Residual risk: model-level prompt-injection defenses are not mathematically perfect. Do not add write tools to this same trust surface without explicit approvals and stronger policy enforcement.

### Sensitive browser data leakage

Controls:

- no `cookies`, `debugger`, history, downloads, bookmarks, or storage permissions;
- no cookie or storage APIs in code;
- extraction uses visible `innerText`, headings, links, and metadata;
- form values are never read;
- URL usernames/passwords and fragments are removed, and sensitive query keys are redacted;
- incognito is excluded;
- non-HTTP(S) schemes are rejected;
- output size is bounded.

Residual risk: visible page text can itself be sensitive. The user must treat enabling this app as granting ChatGPT read access to normal open HTTP(S) tabs.

### Malicious or substituted extension

Controls:

- a fixed manifest public key creates a stable extension ID;
- the native-host manifest allowlists only that origin;
- the native process independently rejects any other origin argument.

### Public exposure of the MCP server

Controls:

- the server binds to `127.0.0.1` only;
- no public ingress is required;
- Secure MCP Tunnel initiates outbound HTTPS.

Residual risk: another process running as the same local user can call the loopback MCP endpoint while Chrome is connected. The local OS account is part of the trust boundary. A future multi-user release should add local authentication or use an in-process/stdio tunnel integration.

### Denial of service and oversized pages

Controls:

- per-tab character limits;
- a maximum of 20 tabs per batch;
- four concurrent reads per batch;
- native-message size limits matching Chrome's protocol limits;
- request timeouts;
- per-tab failures do not abort a batch.

### Arbitrary browser control

Control: there are no navigation, click, form-submit, execute-code, or tab-mutating MCP tools.

## Explicit non-goals

- Defending against malware already running as the same macOS user.
- Extracting content from cross-origin frames, Chrome internal pages, or DRM/canvas surfaces.
- Supporting multiple simultaneous Chrome profiles on one fixed port.
- Providing autonomous browser actions.
