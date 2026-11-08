# ChatGPT Subscription for Copilot — Preview

Use eligible **ChatGPT subscription models in GitHub Copilot Chat** through OpenAI's official **Sign in with ChatGPT (SIWC) subscription-sharing Preview**. No separate proxy server, API key, or borrowed Codex client identity is required.

> **Unofficial extension by Lab 530. Not affiliated with OpenAI, GitHub, or Microsoft.** Subscription sharing is a Preview feature subject to account, workspace, region, model, and application eligibility. A ChatGPT subscription alone does not guarantee access. This extension does not bypass Copilot permissions or provide unlimited API usage.
>
> **Release status:** version **0.1.0** is [available on the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=lab530.chatgpt-subscription-for-copilot), published through official OIDC after 137 passing tests and artifact verification. The user has confirmed successful live text inference after the SSE compatibility fix; this was not independently replayed by the agent. Full Agent-tool and cross-platform acceptance remains pending.

## Requirements

- Desktop **VS Code 1.116 or later** with GitHub Copilot Chat available.
- Any GitHub sign-in or entitlement required by your Copilot setup.
- A ChatGPT account eligible for OpenAI's subscription-sharing Preview.
- Access to the official OpenAI authentication and inference services.

The extension's default interface, account dialogs, browser callback pages, diagnostics, and documentation are in **English**. Conversation content can be in any language supported by the selected model; multilingual text is not translated or discarded.

## Install and connect

1. Install [ChatGPT Subscription for Copilot from the Marketplace](https://marketplace.visualstudio.com/items?itemName=lab530.chatgpt-subscription-for-copilot), or use **Extensions → Install from VSIX…** with `lab530.chatgpt-subscription-for-copilot-0.1.1.vsix`.
2. Run **ChatGPT Subscription: Continue with ChatGPT**.
3. Complete authorization on the official OpenAI page in your browser. After the first successful sign-in with subscription access, a dismissible notice confirms ChatGPT plan usage and shared limits. Earlier notice acknowledgments are retained; failed or declined authorization does not mark it as shown.
4. In Copilot Chat, open the model picker → **Manage Models…** → **ChatGPT Subscription (Preview)** and enable an available model.
5. Select the model and start a chat. Copilot, not this extension, executes tools and controls approvals.

Silent model discovery never opens a browser. Authentication failures do not silently switch to API-key billing, another account, or a third-party provider.

### Updating a local build

For an existing installation of **the same extension ID, `lab530.chatgpt-subscription-for-copilot`**, run this from the project directory:

```bash
code --install-extension ./artifacts/lab530.chatgpt-subscription-for-copilot-0.1.1.vsix --force
```

Then run **Developer: Reload Window**. You can also reinstall through **Install from VSIX…**. Updating the same extension identity does not require signing in again solely because of an SSE parsing fix.

### Migrating from earlier builds

The earlier IDs `local-dev.chatgpt-for-copilot` and `lab530.chatgpt-for-copilot` differ from the current **`lab530.chatgpt-subscription-for-copilot`** identity. Installing the current extension does not overwrite either older ID or inherit its SecretStorage.

1. If appropriate, sign out in the old extension to attempt remote session revocation.
2. Disable or uninstall the old extension before enabling the new one. Running both can conflict over commands and the model provider vendor.
3. Install `lab530.chatgpt-subscription-for-copilot`, reload the window, and authorize the new extension.

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

## 0.1.1 patch notes

- Report actual successful-response token usage to Copilot's context indicator using the disclosed non-public compatibility convention; do not fabricate missing usage as zero.
- Enforce effective input budgets even without native context selections, including changed account limits and saved defaults.
- Classify standard streaming rate-limit errors correctly. Explain that subscription-sharing limits can be app-specific, and prevent repeated upstream calls during a fixed 60-second local retry pause. This does **not** resolve or reset an upstream quota, and the reported 50%/100% discrepancy remains unconfirmed.
- Reconnect the active or retained App registration instead of creating another by default. Only first sign-in or an explicit Add action creates a registration.
- Validate account changes before saving so count, size, or structural failures preserve the previous vault.

Validated with 168 offline tests, including the production CJS bundle. Live UI acceptance and the user's upstream quota state remain unverified; no automatic backend, credential, or billing migration is performed.

## Commands

All commands use the **ChatGPT Subscription** category.

| Command | Purpose |
| --- | --- |
| Continue with ChatGPT | Reconnect the active or sole saved registration; choose one if several are retained; create a registration only for a first login |
| Manage Accounts | Select a saved registration, reconnect, or grant subscription access |
| Sign Out of Active Account | Cancel requests, attempt session revocation, and clear the active account's local tokens |
| Advanced Model Defaults | Set saved defaults or override missing input-limit metadata; ordinary chat controls are in the native model submenu |
| Refresh Models | Clear the model catalog cache and local quota retry pause; does not reset upstream limits |
| Open ChatGPT Usage | Open shared usage information |
| Show Logs | Show operation status, token counts, sanitized errors, HTTP status, allowlisted response type, and request ID |

Registrations remain separate even when they use the same email address. **Continue with ChatGPT** reuses the active registration, or the sole retained registration after sign-out. If several registrations remain with no active selection, you choose which one to reconnect; cancelling does not create an App. To deliberately create another registration, choose **Manage Accounts → Add an account or workspace**. The very first login also creates a registration. Signing out retains the issued client ID and verified identity mapping for reconnecting. If remote revocation cannot be confirmed, the extension tells you to disconnect the application in ChatGPT Settings.

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

### Thinking effort and context window

In **Copilot Chat's model picker**, open the arrow/submenu beside a ChatGPT model. Choose **Thinking effort** and **Context window** there, without a command-palette detour or separate model variants. The native row shows the selected settings, for example **High · Max 1M** when the model's available input budget is 1M. Smaller budgets have their own native choices. No 1M capacity is fabricated when catalog metadata is missing.

The selected thinking level reaches OpenAI as `reasoning.effort`. The selected `contextSize` is a local Copilot input budget, never an unsupported Responses request field. Copilot uses its native context configuration for prompt budgeting; the provider also checks the current account catalog and saved input budget on every request, even when no native context selection is supplied, and rejects an estimated over-budget request without dropping history or tool results. Token counts remain estimates, not a guarantee against upstream context-limit errors.

**Compatibility boundary:** registration and streaming use the stable `LanguageModelChatProvider` API and no proposed APIs are enabled. The inline controls themselves use DeepSeek-style **non-public** `configurationSchema`, `modelConfiguration`, and `configuration` compatibility metadata. These fields are not a GA API contract and may change across VS Code/Copilot versions. Model information is refreshed once after Copilot becomes active, observed passively without activating it or polling. Live UI acceptance in the user's editor remains pending.

**Context usage display:** after a successful response, the extension forwards actual input/output token counts using a stable `LanguageModelDataPart` with Copilot's **non-public** `usage` MIME convention. Like the native picker metadata, this convention is not a GA contract and may change with VS Code/Copilot upgrades. Input usage includes cached input tokens and represents the latest request, not cumulative session billing. Missing or invalid usage is not fabricated as zero. Failed, incomplete, and cancelled responses do not publish successful usage. Live display acceptance in the user's editor remains pending.

Copilot owns the persistence/scope of its native model choices; request-carried values do not rewrite this extension's saved defaults. For advanced saved preferences, arbitrary input budgets, or manual overrides of missing catalog metadata, use **ChatGPT Subscription: Advanced Model Defaults** or the following user settings:

```json
{
  "chatgptSub.modelOverrides": {
    "your-visible-model-id": {
      "reasoningEffort": "high",
      "contextWindow": 128000
    }
  }
}
```

- For each field, explicit `modelOptions` takes precedence over native `modelConfiguration` and legacy `configuration` values. Native **Use saved setting** uses the per-model setting, then the global setting, then the server default. Per-model `default` means the server chooses, even when a global effort is set. Unsupported catalog-declared efforts fail before inference instead of silently changing levels.
- When the catalog reports supported efforts, only those levels are offered. If capability metadata is absent, the dialog warns that the service may reject an explicit effort.
- `contextWindow` is the **input token budget advertised to Copilot**, not a request parameter, an output-token cap, or a way to increase server capacity. Values must be integers from 1,024 to 2,000,000. A catalog-declared input limit is always respected, including after switching accounts.
- When input-limit metadata is missing, a manual override may replace the conservative 32K estimate. Use a verified limit for the model: an oversized budget can still be rejected by OpenAI. Leave the input blank to restore its default; output-limit metadata is unchanged.
- Native context presets stay within the advertised budget ceiling, including any saved advanced override. Stale or invalid native values are rejected before inference; selection alone never overwrites defaults for other callers.
- Unknown model IDs have no effect. Workspace settings cannot override these preferences, endpoints, or credentials.

## Authentication and privacy

This implementation follows Pi 1.5.0's newer **`openai` → Sign in with ChatGPT** flow: dynamic client registration, the `chatgpt.tokens.use.direct` scope, issued-client token exchange and refresh, and the public Responses endpoint. It is **not** the legacy `openai-codex` Beta backend. Sharing the OAuth protocol does not mean every request field or the entire client implementation is identical to Pi.

- Credential-bearing authentication requests use fixed `auth.openai.com` endpoints. Inference uses `https://api.openai.com/v1/responses`. HTTP redirects and non-official metadata URLs are rejected.
- Tokens, verified account identity, and a stable installation host ID are stored independently in VS Code SecretStorage. Pi/Codex account files are never imported.
- The loopback OAuth callback binds only to `127.0.0.1`, validates Host/path/state/client ID, and closes after authorization, cancellation, or a bounded sign-in deadline.
- Account writes are validated before replacing stored data; invalid or oversized changes preserve the previous vault. Up to 100 registrations can be retained, with a 1,048,576-character serialized-state ceiling. At capacity, reconnect an existing registration in Manage Accounts instead of adding another.
- Cross-window locks live in this extension's local `globalStorage` directory and contain no tokens. Do not manually delete locks during sign-in; crash leftovers can take about a minute to become stale.
- Conversation context supplied by Copilot—including code, images, and tool results—is sent to OpenAI. **`store: false` is not a promise of zero retention across the service chain.** Follow your organization's data policies.
- No extension-operated proxy, analytics collector, or telemetry service is included. See the [privacy notice](https://github.com/0x3st/chatgpt-subscription-for-copilot/blob/HEAD/PRIVACY.md).
- Restricted Mode, web extension hosts, and virtual workspaces are not supported. In SSH/container workspaces, the extension is configured to run as a local UI extension.

## Preview limitations

- The public Responses endpoint does **not** make subscription authorization generally available. See OpenAI's [subscription-sharing Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
- HTTP requests use `store: false`, `stream: true`, and the full required history. Unsupported fields such as `max_output_tokens`, `temperature`, and `previous_response_id` are omitted.
- Hosted tools—including image generation, hosted MCP, file search, Code Interpreter, and Responses tool search—are not called. Copilot's client-side function tools do not enable those hosted capabilities.
- Audio/video, the Files upload API, and transcription APIs are not supported. Unknown attachment/message types fail explicitly rather than silently losing context.
- Image support is enabled only when explicitly declared in the account model catalog.
- Missing token-limit metadata uses conservative **32K input / 4K output estimates**, labeled in model tooltips. Token counting is also an estimate; these values are not upstream output limits.
- Encrypted reasoning is eligible for replay for 30 minutes, with a cache limit of 256 entries / 8 MiB. Expired entries are removed on access; deactivation clears the cache. Reloading or cache expiry may require starting a new conversation.
- The extension does not automatically retry inference or switch billing routes. After an upstream quota/rate-limit error, subsequent requests for the same active registration are blocked locally for up to 60 seconds to avoid repeated upstream calls from Copilot retries; the pause is in-memory and does not extend when a cached error is returned. **This local pause is not an upstream quota reset estimate.** Explicitly running **Refresh Models** clears it; passive refresh does not. Requests already in flight and other extension-host windows are not covered by this local guard. Copilot may still show its own retry or 502 wrapper. Usage reset times are not guessed; check [ChatGPT Usage](https://chatgpt.com/settings/usage).
- Live text inference has been confirmed by the user. Full Agent tool execution, Windows/Linux, remote workspaces, and different Copilot versions still require end-to-end acceptance. Local tests do not guarantee upstream availability.

## Troubleshooting

### `command 'chatgptSub.signIn' not found`

An early development build incorrectly required a `file:` storage URI, rejecting desktop VS Code profiles using `vscode-userdata:`. Current builds support both local schemes while still rejecting web hosts, remote authorities, and relative paths. Reinstall the correct package and reload the window. Account data does not need to be deleted.

### Reconnecting creates another App in ChatGPT

Earlier builds treated the default **Continue with ChatGPT** command as an Add action. Version 0.1.1 reconnects an existing registration as described above; they keep the official SIWC Preview flow and do not switch to the legacy Codex Beta backend. A missing local registration (for example after clearing storage or changing extension IDs) cannot be reconstructed from an email address, and other extensions' credentials are never imported. Already-created duplicate Apps are not automatically deleted. An invalid or removed issued client does not silently fall back to creating another App.

### A usage-limit error despite remaining ChatGPT usage

`subscription_sharing_usage_limit_exceeded` is an upstream subscription-sharing error, not a local token-budget calculation. OpenAI's [official recovery guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) says an **app-specific limit can also apply**: this code does not establish that the entire ChatGPT plan is exhausted and does not identify a reset time. Check **Open ChatGPT Usage** and verify the active account/workspace; repeatedly signing in is not a quota reset. The extension cannot inspect your account's remaining limits or override an upstream rejection.

The extension now classifies both standard streaming rate-limit errors and subscription-sharing quota errors as blocked requests and applies the local retry pause described above. It still returns a failure, never a fabricated successful answer. After checking access, **Refresh Models** clears only the local pause, not upstream limits. If Copilot displays `retried 5 times` or `502`, those are client-side wrapping/retry details and do not alone establish the HTTP status returned by OpenAI. Error logs retain the actual upstream HTTP status (including HTTP 429 failures that precede SSE); they do not replace it with Copilot's 502. Share only the sanitized **Responses transport** and error log lines, including an available request ID; no account access or real inference was used to verify the current fix.

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

Packaging creates `artifacts/lab530.chatgpt-subscription-for-copilot-0.1.1.vsix` locally. It does **not** upload, publish, tag, or deploy anything. The `vscode:prepublish` hook only compiles the bundle before local packaging.

Version **0.1.0** was published as `lab530.chatgpt-subscription-for-copilot` through official OIDC Trusted Publishing and independently verified in the public Marketplace. The exact release commit, workflow run, and artifact hash are recorded in [PUBLISHING.md](PUBLISHING.md). The manual [publishing workflow](.github/workflows/publish2marketplace.yml) verifies the exact reviewed main commit, version, tests, archive contents, and package hash before using official OIDC Trusted Publishing. It never publishes on a push, PR, or tag. See [PUBLISHING.md](PUBLISHING.md) for the required publisher policy and approval steps. The project-level minimatch override pins vsce's dependency to 11.0.1 to address the reported globparts-amplification advisory; packaging has been tested with this override.

The VSIX allowlist includes only the runtime bundle, manifest, English README/privacy notice, selected PNG icon, and license notices. It excludes tests, audit evidence, reference repositories, other brand assets, credentials, and node_modules. Runtime dependencies are bundled.

You can also press **F5** to open an extension development host. Any sign-in there uses real account authorization and is **not** part of the mock test suite. Tests use synthetic OpenAI responses; OAuth listener tests use temporary local ports. They do not read your account or call real models.

## Support, references, and license

- [Source](https://github.com/0x3st/chatgpt-subscription-for-copilot)
- [Issues](https://github.com/0x3st/chatgpt-subscription-for-copilot/issues) — do not include secrets or sensitive code.
- [MIT license](https://github.com/0x3st/chatgpt-subscription-for-copilot/blob/HEAD/LICENSE). Bundled dependency notices are in `THIRD_PARTY_NOTICES.md`.
- Design references: [Pi](https://github.com/earendil-works/pi) and [DeepSeek V4 for Copilot](https://github.com/Vizards/deepseek-v4-for-copilot). This extension implements its own authentication and minimal protocol adapter.

Official protocol references:

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
