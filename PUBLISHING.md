# Marketplace Publishing Preparation — Not Published

## Configured locally

- Publisher: **`lab530`**, supplied by the user through `https://marketplace.visualstudio.com/manage/publishers/lab530`.
- Extension ID: **`lab530.chatgpt-for-copilot`**.
- Local version: `0.1.0`; no release, tag, or Marketplace publication has been performed. The user explicitly approved source upload to the configured GitHub repository after confirming that real text inference works.
- Local package: `artifacts/lab530.chatgpt-for-copilot-0.1.0.vsix`. The publisher prefix distinguishes it from previous `local-dev` packages.
- Repository: `https://github.com/0x3st/chatgpt-for-copilot`, as provided by the user. Homepage and issue URLs are configured. Before the approved source upload, read-only checks confirmed a public, empty repository and push permission. Source upload approval does not authorize Marketplace publication.
- Icon: the selected original conversation-bubble PNG, `assets/brand/icon.png` (256 × 256). The Lab 530 crest is **not** the product icon. Only the selected PNG is allowlisted for packaging.
- Primary language: **English**, including the README, privacy notice, extension dialogs, account-management choices, callback pages, reasoning-summary heading, and errors/diagnostics. Multilingual conversation data remains supported.
- Search keywords, Preview labeling, fixed official endpoints, independent SecretStorage, and no Beta/third-party/API-key billing fallback are preserved.
- The English privacy notice is packaged. The real repository metadata is configured, and local packaging no longer suppresses the missing-repository check.
- No PAT or publishing credentials have been requested, saved, read, or tested.

## Still required before publication

- [x] **Live text acceptance:** the user confirmed that real text inference now works after the SSE fix. The agent did not replay a real model request.
- [ ] **Remaining live acceptance:** tool execution/results/reasoning replay, cancellation, sign-out, and cross-platform behavior. Mock tests alone do not establish these.
- [ ] **Source availability verification:** after the approved source push, verify the remote commit and privacy/source URLs. Future pushes still require their own applicable authorization.
- [ ] **SIWC distribution and branding:** check the current OpenAI Preview eligibility, open-source/distribution conditions, and branding requirements. Packaging success does not grant upstream access or permission.
- [ ] **Store presentation:** finalize screenshots, description, support arrangements, and privacy disclosure. The README intentionally retains the current acceptance limitations and unofficial status.
- [ ] **Publisher authentication:** the user authenticates locally. Do not paste a PAT/token into chat, repository files, printed logs, or command-line arguments; do not automatically read existing credentials.
- [ ] **Specific publication approval:** after the problem is resolved and the exact target package is confirmed, obtain explicit permission for code upload and/or Marketplace publication. Creating a publisher or providing a repository URL is not such permission.

## Safe local checks

```bash
npm run check
npm test
npm run package
```

These commands perform type checking, mocked tests, and local packaging only. The `vscode:prepublish` hook compiles the bundle before packaging; it does not publish anything. The package whitelist must include the selected icon and privacy notice and exclude credentials, tests, audit evidence, reference repositories, unselected brand assets, and node_modules.

## Migration from the old development identity

Publisher is part of an extension's identity. `local-dev.chatgpt-for-copilot` and `lab530.chatgpt-for-copilot` are different extensions.

1. If appropriate, the user signs out in the old extension to attempt session revocation.
2. Disable or uninstall the old extension before enabling the new one, avoiding duplicate command/vendor registration.
3. Manually install the `lab530` VSIX, reload the window, and authorize the new extension.
4. Do not automatically read or copy the old SecretStorage. Renaming a publisher does not migrate stored accounts.

Source upload is authorized for the current GitHub step only. No installation, sign-out, credential migration, window reload, tag/release creation, or Marketplace publication is authorized by that approval.
