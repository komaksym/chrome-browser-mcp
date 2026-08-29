# Threat model

## Assets

- Titles, URLs, and visible text from open Chrome tabs.
- Authenticated page content visible in the user's normal Chrome profile.
- The ability to enumerate which sites are open.
- User-authorized control of normal HTTP(S) tabs: screenshotting the visible viewport, clicking, typing, selecting, scrolling, navigation, opening, and closing tabs.
- User-authorized attachment of one explicitly named regular file directly inside `~/CodexUploads` to an HTML file input.

The bridge does not intentionally expose cookies, browser storage, password-manager data, hidden input values, browsing history, downloads, bookmarks, incognito tabs, arbitrary JavaScript execution, generic filesystem reads, or Chrome debugger access.

## Trust boundaries

1. **Webpage -> extension**: webpage content is hostile input.
2. **Extension -> native host**: Chrome Native Messaging, allowlisted to one stable extension ID.
3. **Native host -> local MCP**: loopback-only Streamable HTTP.
4. **Local MCP -> OpenAI**: outbound Secure MCP Tunnel.
5. **Tool output -> model**: page text remains untrusted evidence and is never action authority.

## Main threats and controls

### Prompt injection in webpage text

Threat: a page says to ignore the user, read other tabs, reveal secrets, or invoke write tools.

Controls:

- every read result contains `contentIsUntrusted: true` and a warning;
- server instructions and tool descriptions explicitly say not to follow page instructions;
- a page cannot choose MCP tool arguments or send messages to the native host;
- write tools act only on arguments supplied by the MCP caller;
- human-readable action targets must match exactly and ambiguous matches are rejected;
- actions are limited to normal HTTP(S) tabs; there is no arbitrary JavaScript tool.

Residual risk: model-level prompt-injection defenses are not mathematically perfect. Use write tools only for user-directed tasks, not unattended autonomous browsing.

### Sensitive browser data leakage

Controls:

- no `cookies`, `debugger`, history, downloads, bookmarks, or storage permissions;
- no cookie or storage APIs in code;
- extraction uses visible `innerText`, headings, links, and metadata;
- form values are never read;
- URL usernames/passwords and fragments are removed, and sensitive query keys are redacted in returned metadata;
- incognito is excluded;
- non-HTTP(S) schemes are rejected;
- output size is bounded;
- screenshot requests validate the target as a normal HTTP(S), non-incognito tab before capture and verify it stayed active across the capture.
- Chrome's `captureVisibleTab` requires the extension-level `<all_urls>` host permission for unattended capture; runtime guards still reject non-HTTP(S), incognito, and restricted targets before the capability is used.

Residual risk: visible page text and screenshot pixels can themselves be sensitive. The user must treat enabling this app as granting ChatGPT read access and user-directed control over normal open HTTP(S) tabs.

### Restricted file upload

Threat: the model tries to read or upload an arbitrary local file, escape the approved directory, follow a symlink outside it, or send an approved document to the wrong site.

Controls:

- the MCP tool accepts only a plain filename, never an arbitrary path;
- the native host reads only files directly inside `~/CodexUploads`;
- the resolved real path must remain directly under that directory, so symlink escapes are rejected;
- only regular files are accepted;
- files are limited to 10 MiB;
- bytes are sent only to the targeted HTML file input and are not returned in MCP output;
- no general filesystem read/list/delete/write tool is exposed;
- upload uses ordinary page/extension primitives and does not add Chrome debugger access.

Residual risk: uploading a permitted file to the wrong website is still a data disclosure. The browser agent must keep the destination and user-requested task in scope.

### Unintended browser side effects

Threat: a click, Enter key, navigation, or tab close can submit data, trigger a remote action, or discard page state.

Controls:

- write tools are explicitly marked non-read-only in MCP metadata;
- click, Enter-key, and close-tab tools are marked destructive;
- ambiguous targets are rejected rather than guessed;
- actions cannot access Chrome internal pages or incognito tabs;
- the extension uses ordinary DOM actions and `chrome.tabs`, not debugger/CDP or arbitrary script execution.

Residual risk: normal webpages can attach consequential behavior to otherwise ordinary DOM interactions. The caller must respect the user's requested scope and any product-level confirmation prompts.

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

## Explicit non-goals

- Defending against malware already running as the same macOS user.
- Extracting content from cross-origin frames, Chrome internal pages, or DRM/canvas surfaces.
- Supporting multiple simultaneous Chrome profiles on one fixed port.
- Unattended autonomous browser operation.
- Arbitrary filesystem access or arbitrary OS/computer control.
