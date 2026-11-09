# Privacy Notice

**ChatGPT Subscription for Copilot** is an unofficial extension published under the `lab530` publisher. This notice describes the extension's own behavior; it does not replace OpenAI, GitHub, Microsoft, or your organization's policies. Configuring a publisher does not mean a Marketplace release has occurred.

## Data sent to OpenAI

When you explicitly sign in, the extension uses OpenAI's official Sign in with ChatGPT subscription-sharing Preview. Authorization uses PKCE, state, nonce, an issued application client ID, a stable opaque installation host ID, and a local loopback callback. Identity metadata and public signing keys are retrieved to validate ID tokens. Browser sign-in is handled by OpenAI; this extension does not collect your password or read browser cookies.

When you select a model and submit a request through Copilot, the extension sends the conversation context provided by Copilot directly to `https://api.openai.com/v1/responses`. This can include:

- Your prompts and prior assistant replies.
- Code, editor context, tool descriptions, tool arguments, and tool results supplied by Copilot.
- Images supplied by Copilot, only when the model catalog explicitly declares image support.
- The chosen model, supported reasoning settings, and opaque session/cache identifiers.
- Previously returned encrypted reasoning associated with matching tool-call history, when available in the in-memory cache.

The extension also requests your account's visible model catalog from `https://api.openai.com/v1/models` and refreshes or revokes tokens through fixed official OpenAI authentication endpoints. It does not expose a workspace-configurable backend or send credentials to an extension-operated proxy.

Requests use `store: false`. **This does not guarantee zero retention, exempt requests from provider policies, or disable logging elsewhere in Copilot, VS Code, the browser, or OpenAI.** Your subscription usage may be shared with other applications and may be subject to workspace-admin limits.

## Data stored locally

The extension stores its own tokens, issued client IDs, verified account identifiers/email labels, and a stable installation host ID in **VS Code SecretStorage**. Accounts/workspaces are kept as separate registrations. It does not read Pi/Codex account files or automatically import credentials from older extension identities.

A token-free filesystem lock under the extension's local global-storage directory coordinates credential updates across VS Code windows. User settings store reasoning preferences and request deadlines. Local extension state records acknowledgment of the Preview notice.

Encrypted reasoning replay stays **only in process memory**, isolated by account registration, epoch, and model. It is eligible for replay for 30 minutes, bounded to 256 entries and 8 MiB. Expired entries are removed when the cache is accessed; deactivation clears it. It is not written to disk or logs. Reloading the editor can therefore make earlier reasoning context unavailable.

## Live Notebook tools (0.2.0)

When enabled and invoked by Copilot, the Notebook tools list already-open Jupyter notebook editor documents, read an individual cell's live source (including unsaved text), and update that cell in the editor after snapshot/lock validation. Notebook URIs, cell identities, languages, versions, lock states, and read source can be returned to Copilot and become context for its selected model, including a model supplied by another extension. The tools themselves make no direct network or model calls.

Cell identities, AI locks, and at most 256 short-lived read snapshots remain in this extension host's memory. Snapshots contain document references, versions, language IDs and source hashes, not retained copies of full cell source. Snapshot eligibility expires after 15 minutes or earlier eviction; expired entries are pruned on subsequent reads/updates, and closing a notebook removes its snapshots. Disposal clears this state. Locks are not written into notebook metadata or settings and do not synchronize across windows.

These tools do not directly rewrite disk files, explicitly save, execute code, or edit outputs or metadata. VS Code Auto Save can still persist live editor changes according to your settings. AI locks govern only this extension's update tool, not other tools or filesystem access. Editor source is not added to this extension's diagnostic logs.

## Logs and telemetry

This extension does not include its own analytics collector, telemetry upload, or separate proxy server.

Local output logs contain operation status, reported token counts, tool-call counts, sanitized error codes/messages, actual HTTP status, allowlisted response media types, and sanitized request IDs. They do not intentionally record access/refresh/ID tokens, authorization or callback URLs, passwords, complete requests/responses, chat text, source code, or arbitrary response headers. OpenAI-returned error message bodies are not echoed into diagnostics.

GitHub Copilot, VS Code, OpenAI, and installed extensions may have separate telemetry and retention behavior. This extension cannot disable or make guarantees about those systems.

## User controls

- Cancel an in-progress request in Copilot; total deadlines also limit request duration.
- Use **Manage Accounts** to select a registration, reconnect, or grant subscription access.
- Use **Sign Out of Active Account** to cancel ongoing operations, attempt remote session revocation, and clear the active registration's local tokens. Other saved registrations are unaffected.
- Signing out retains the issued client ID and verified identity mapping to support reconnecting. Remote revocation failures are reported; disconnect the application in ChatGPT Settings if necessary.
- Uninstalling or changing publisher identity is not a substitute for revoking a remote authorization and does not necessarily delete data retained by VS Code or OpenAI.
- Review context and tool approvals in Copilot. Do not submit sensitive information unless permitted by your organization's policies.
- Enable or disable the live Notebook tools in Copilot's tools picker. Use the cell's **AI editable / AI locked** action or **Toggle AI Cell Lock** to block this extension's future AI edits to that cell; closing the notebook or reloading the extension clears its in-memory lock.

## Support

Use the project's [issue tracker](https://github.com/0x3st/chatgpt-subscription-for-copilot/issues) for non-sensitive questions. Do not post tokens, authorization/callback URLs, raw request/response bodies, or private code. Private publishing credentials should never be shared in an issue or chat.
