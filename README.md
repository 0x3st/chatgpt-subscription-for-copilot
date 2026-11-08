# ChatGPT Subscription for Copilot — Preview

Use eligible **ChatGPT subscription models in GitHub Copilot Chat** through OpenAI's official **Sign in with ChatGPT (SIWC) subscription-sharing Preview**. No separate proxy server, API key, or borrowed Codex client identity is required.

> **Unofficial extension by Lab 530. Not affiliated with OpenAI, GitHub, or Microsoft.** Subscription sharing is a Preview feature subject to account, workspace, region, model, and application eligibility. A ChatGPT subscription alone does not guarantee access. This extension does not bypass Copilot permissions or provide unlimited API usage.
>
> **Development status:** local protocol and mocked integration tests pass. The user has confirmed successful live text inference after the SSE compatibility fix; this was not independently replayed by the agent. Full Agent-tool and cross-platform acceptance remains pending. Source availability and local packaging are not a Marketplace release.

## Requirements

- Desktop **VS Code 1.116 or later** with GitHub Copilot Chat available.
- Any GitHub sign-in or entitlement required by your Copilot setup.
- A ChatGPT account eligible for OpenAI's subscription-sharing Preview.
- Access to the official OpenAI authentication and inference services.

The extension's default interface, account dialogs, browser callback pages, diagnostics, and documentation are in **English**. Conversation content can be in any language supported by the selected model; multilingual text is not translated or discarded.

## Install and connect

1. Open **Extensions → Install from VSIX…** and select the locally built `lab530.chatgpt-for-copilot-0.1.0.vsix`.
2. Run **ChatGPT Subscription: Continue with ChatGPT**.
3. Read the Preview and data-sharing notice, then complete authorization on the official OpenAI page in your browser.
4. In Copilot Chat, open the model picker → **Manage Models…** → **ChatGPT Subscription (Preview)** and enable an available model.
5. Select the model and start a chat. Copilot, not this extension, executes tools and controls approvals.

Silent model discovery never opens a browser. Authentication failures do not silently switch to API-key billing, another account, or a third-party provider.

### Updating a local build

For an existing installation under the **same `lab530` publisher**, run this from the project directory:

```bash
code --install-extension ./artifacts/lab530.chatgpt-for-copilot-0.1.0.vsix --force
```

Then run **Developer: Reload Window**. You can also reinstall through **Install from VSIX…**. Updating the same extension identity does not require signing in again solely because of an SSE parsing fix.

### Migrating from the old `local-dev` build

`local-dev.chatgpt-for-copilot` and `lab530.chatgpt-for-copilot` are **different extension identities**. The new build will not overwrite the old extension or inherit its SecretStorage.

1. If appropriate, sign out in the old extension to attempt remote session revocation.
2. Disable or uninstall the old extension before enabling the new one. Running both can conflict over commands and the model provider vendor.
3. Install the `lab530` build, reload the window, and authorize the new extension.

Credentials are never automatically read or copied from the old extension, Pi, or Codex.

## Features

- Account-specific model discovery from `GET https://api.openai.com/v1/models`; only visible subscription models are offered.
- Streaming text and optional reasoning summaries through the stable VS Code `LanguageModelChatProvider` API. No proposed APIs.
- Namespaced function tools, complete tool-call/result history, and images when the account's model catalog explicitly declares support.
- Tool calls are released to Copilot **only after a successful `response.completed` event**. Truncation, quota errors, malformed JSON, undeclared tools, and inconsistent terminal output fail closed.
- Encrypted reasoning replay for matching tool continuations, isolated by account registration, account epoch, and model. The bounded cache stays in memory, never in logs or on disk.
- Multiple saved account/workspace registrations, PKCE, state, nonce, and ID-token signature/issuer/audience/expiry/subject validation.
- Serialized credential updates and rotating-token refresh across windows. Switching accounts or signing out cancels stale operations.
- Cancellation and finite total deadlines covering authentication, refresh, response headers, and streaming bodies.

## Commands

All commands use the **ChatGPT Subscription** category.

| Command | Purpose |
| --- | --- |
| Continue with ChatGPT | Add an account or workspace registration |
| Manage Accounts | Select a saved registration, reconnect, or grant subscription access |
| Sign Out of Active Account | Cancel requests, attempt session revocation, and clear the active account's local tokens |
| Refresh Models | Clear the model catalog cache |
| Open ChatGPT Usage | Open shared usage information |
| Show Logs | Show operation status, token counts, sanitized errors, HTTP status, allowlisted response type, and request ID |

Registrations remain separate even when they use the same email address. Signing out retains the issued client ID and verified identity mapping for reconnecting. If remote revocation cannot be confirmed, the extension tells you to disconnect the application in ChatGPT Settings.

## Settings

Settings are **machine-scoped**. The extension explicitly reads user/default values, not workspace overrides. There is no configurable backend URL or custom authorization header.

```json
{
  "chatgptSub.reasoningEffort": "default",
  "chatgptSub.showReasoningSummary": false,
  "chatgptSub.requestTimeoutSeconds": 600
}
```

- **Reasoning effort:** `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `default` omits the field. Explicit model capability metadata is checked before sending; unsupported efforts are not silently substituted.
- **Reasoning summary:** rendered as ordinary text without proposed APIs. This is the provider's summary, not access to private chain-of-thought.
- **Total request timeout:** 10–1,800 seconds, including credential refresh and streaming.

## Authentication and privacy

This implementation follows Pi 1.5.0's newer **`openai` → Sign in with ChatGPT** flow: dynamic client registration, the `chatgpt.tokens.use.direct` scope, issued-client token exchange and refresh, and the public Responses endpoint. It is **not** the legacy `openai-codex` Beta backend. Sharing the OAuth protocol does not mean every request field or the entire client implementation is identical to Pi.

- Credential-bearing authentication requests use fixed `auth.openai.com` endpoints. Inference uses `https://api.openai.com/v1/responses`. HTTP redirects and non-official metadata URLs are rejected.
- Tokens, verified account identity, and a stable installation host ID are stored independently in VS Code SecretStorage. Pi/Codex account files are never imported.
- The loopback OAuth callback binds only to `127.0.0.1`, validates Host/path/state/client ID, and closes after authorization, cancellation, or a bounded sign-in deadline.
- Cross-window locks live in this extension's local `globalStorage` directory and contain no tokens. Do not manually delete locks during sign-in; crash leftovers can take about a minute to become stale.
- Conversation context supplied by Copilot—including code, images, and tool results—is sent to OpenAI. **`store: false` is not a promise of zero retention across the service chain.** Follow your organization's data policies.
- No extension-operated proxy, analytics collector, or telemetry service is included. See the [privacy notice](https://github.com/0x3st/chatgpt-for-copilot/blob/HEAD/PRIVACY.md).
- Restricted Mode, web extension hosts, and virtual workspaces are not supported. In SSH/container workspaces, the extension is configured to run as a local UI extension.

## Preview limitations

- The public Responses endpoint does **not** make subscription authorization generally available. See OpenAI's [subscription-sharing Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
- HTTP requests use `store: false`, `stream: true`, and the full required history. Unsupported fields such as `max_output_tokens`, `temperature`, and `previous_response_id` are omitted.
- Hosted tools—including image generation, hosted MCP, file search, Code Interpreter, and Responses tool search—are not called. Copilot's client-side function tools do not enable those hosted capabilities.
- Audio/video, the Files upload API, and transcription APIs are not supported. Unknown attachment/message types fail explicitly rather than silently losing context.
- Image support is enabled only when explicitly declared in the account model catalog.
- Missing token-limit metadata uses conservative **32K input / 4K output estimates**, labeled in model tooltips. Token counting is also an estimate; these values are not upstream output limits.
- Encrypted reasoning is eligible for replay for 30 minutes, with a cache limit of 256 entries / 8 MiB. Expired entries are removed on access; deactivation clears the cache. Reloading or cache expiry may require starting a new conversation.
- The extension does not automatically retry inference or switch billing routes. Copilot may independently retry a provider failure. Usage reset times are not guessed; check [ChatGPT Usage](https://chatgpt.com/settings/usage).
- Live text inference has been confirmed by the user. Full Agent tool execution, Windows/Linux, remote workspaces, and different Copilot versions still require end-to-end acceptance. Local tests do not guarantee upstream availability.

## Troubleshooting

### `command 'chatgptSub.signIn' not found`

An early development build incorrectly required a `file:` storage URI, rejecting desktop VS Code profiles using `vscode-userdata:`. Current builds support both local schemes while still rejecting web hosts, remote authorities, and relative paths. Reinstall the correct package and reload the window. Account data does not need to be deleted.

### “The service did not return SSE” or a Copilot 502

An early build rejected any MIME type other than `text/event-stream`. Pi's OpenAI SDK instead selects SSE parsing from `stream: true`; current builds follow that behavior and use its default `Accept: application/json`. Valid event framing, successful completion, and tool validation are still required. JSON errors and HTML pages are not treated as successful model replies.

The old MIME check ran only after an HTTP 2xx response, so a Copilot 502 wrapper did not establish an upstream HTTP 502. Current diagnostics preserve the real status, allowlisted media type, sanitized request ID, and failure-body classification—never raw response text or arbitrary header parameters.

If a request still fails, open **Show Logs** and share only the relevant `Responses transport` and sanitized error lines. Never post tokens, callback/authorization URLs, or complete requests/responses. The actual content type of the original failed response was not recorded; the compatibility fix is not proof that all upstream causes have been resolved.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run compile
npm run package
```

Packaging creates `artifacts/lab530.chatgpt-for-copilot-0.1.0.vsix` locally. It does **not** upload, publish, tag, or deploy anything. The `vscode:prepublish` hook only compiles the bundle before local packaging.

The `lab530` publisher is configured; credentials and publishing permissions have not been verified. Publishing preparation is tracked separately in the source checkout. The project-level minimatch override pins vsce's dependency to 11.0.1 to address the reported globparts-amplification advisory; packaging has been tested with this override.

The VSIX allowlist includes only the runtime bundle, manifest, English README/privacy notice, selected PNG icon, and license notices. It excludes tests, audit evidence, reference repositories, other brand assets, credentials, and node_modules. Runtime dependencies are bundled.

You can also press **F5** to open an extension development host. Any sign-in there uses real account authorization and is **not** part of the mock test suite. Tests use synthetic OpenAI responses; OAuth listener tests use temporary local ports. They do not read your account or call real models.

## Support, references, and license

- [Source](https://github.com/0x3st/chatgpt-for-copilot)
- [Issues](https://github.com/0x3st/chatgpt-for-copilot/issues) — do not include secrets or sensitive code.
- [MIT license](https://github.com/0x3st/chatgpt-for-copilot/blob/HEAD/LICENSE). Bundled dependency notices are in `THIRD_PARTY_NOTICES.md`.
- Design references: [Pi](https://github.com/earendil-works/pi) and [DeepSeek V4 for Copilot](https://github.com/Vizards/deepseek-v4-for-copilot). This extension implements its own authentication and minimal protocol adapter.

Official protocol references:

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
