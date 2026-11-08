# Manual Marketplace Publishing

This document describes the release workflow. Its presence, a source push, or a locally built VSIX is **not** evidence of a successful Marketplace publication.

- Publisher: **`lab530`**.
- Extension: **`lab530.chatgpt-subscription-for-copilot`**.
- Initial version: **`0.1.0`**.
- Current released patch: **`0.1.1`**, published following the owner's explicit authorization for source upload and Marketplace publication after verification.
- Source: <https://github.com/0x3st/chatgpt-subscription-for-copilot>.
- Workflow: **`.github/workflows/publish2marketplace.yml`**.
- Publication status: **`0.1.1` published through official OIDC on 2026-11-08 and independently verified in the public Marketplace version metadata and version-specific VSIX download**.
- Listing: <https://marketplace.visualstudio.com/items?itemName=lab530.chatgpt-subscription-for-copilot>.
- Release source: `dfadd3076e48fd41361ee814effb6f9588431634` (GitHub-verified SSH signature; noreply author and committer).
- Successful release run: <https://github.com/0x3st/chatgpt-subscription-for-copilot/actions/runs/42480184302>.
- Published workflow artifact SHA-256: `e1e46dbbe3748778851be030ffcd57875052e1f161331e83fa6bc1d55ed1c2f8`. The independently downloaded public VSIX and public version metadata have the same hash.
- OIDC-only preflight: <https://github.com/0x3st/chatgpt-subscription-for-copilot/actions/runs/42479899625>; its publication step was skipped. Both runs passed 168 tests, dependency audit, and exact archive/runtime checks. The `marketplace` environment requires owner review and permits only `main`; each run's artifact was inspected before approval. This completed authorization does not authorize another release or version bump.
- Initial `0.1.0` historical record: source `15546b9aacfd20c78754343bcb1b2d27f354bb2f`, run `42448373673`, artifact SHA-256 `8a1467f44f31dca39e76afb1197cbe64d55d3a46da964a61d3873a0435fea9bf`; do not republish either released version.

## Configure Trusted Publishing once

In the [Marketplace publisher management page](https://marketplace.visualstudio.com/manage/publishers/lab530), open **Trusted Publishing → Create** and use:

| Field | Exact value |
| --- | --- |
| Repository owner | `0x3st` |
| Repository | `chatgpt-subscription-for-copilot` |
| Workflow | `publish2marketplace.yml` |
| Environment | `marketplace` |

If a policy was created for the former repository name `chatgpt-for-copilot`, update or recreate it for `chatgpt-subscription-for-copilot` before publication; GitHub URL redirects do not establish a matching OIDC policy. The current extension ID is `lab530.chatgpt-subscription-for-copilot`; the earlier `lab530.chatgpt-for-copilot` identity must not be published by this workflow.

The workflow filename is entered without `.github/workflows/`. The environment must match exactly; do not leave it empty for this workflow. Publisher access and the policy must be configured by an authorized publisher administrator.

In the repository's **Settings → Environments**, configure `marketplace` with appropriate required reviewers and restrict deployment branches to `main`. Repository administrators control these protections; naming an environment in YAML alone does not establish a reviewer requirement.

No PAT repository secret is needed. Do not paste tokens into chat, source, printed logs, or command arguments, and do not import existing Pi/Codex/VSCE credentials. The build job has no OIDC permission. Only the publishing job receives `id-token: write` and exchanges its GitHub-issued identity through official `vsce --oidc`.

**API version note:** the locked official `@vscode/vsce` 4.1.0 uses Marketplace `api-version=7.2-preview.1` for OIDC token exchange and its Gallery publishing client. This is a Preview-versioned interface, not GA. Its use is explicitly accepted for this project's Marketplace publishing only; it does not authorize unrelated Preview/Beta services or a PAT/billing fallback. Failure to authenticate, exchange identity, verify, or upload stops publication.

## Review and approve each release

1. Confirm the intended changes and run the local checks below. Local mocked tests do not replace live acceptance.
2. Obtain the owner's approval for the current source upload and exact public release. Initial source-upload approval is not blanket permission for later changes or releases.
3. Commit using the correct GitHub noreply author **and committer** identities and a valid configured signature. Verify the uploaded commit and GitHub's signature verification. Never silently rewrite published history.
4. Confirm the full **40-character SHA on `main`** and the exact `package.json` version. The workflow neither bumps versions nor creates tags or GitHub releases.
5. Verify that the Trusted Publishing policy and repository environment protections are configured. Use the same workflow with `auth_only=true` first: its only publishing command is explicitly skipped, while the locked official vsce OIDC helper verifies trust without exposing or persisting credentials. Do not trigger a speculative actual release to test credentials. A failed preflight blocks publication; do not use a PAT fallback.
6. Open **Actions → Publish to Visual Studio Marketplace → Run workflow**, select `main`, enter the exact version and reviewed commit, and explicitly check the public-publication confirmation.
7. If environment approval is configured, review the verification job and its package hash before approving the publishing job.
8. After success, independently verify the Marketplace extension ID/version/listing and retain the workflow run and VSIX hash. Update publication status only after verification.

An authorized release operator may instead dispatch the same workflow locally, after the preceding checks and explicit release approval:

```bash
gh workflow run publish2marketplace.yml --ref main \
  -f version=0.1.1 \
  -f commit=REVIEWED_FULL_40_CHARACTER_MAIN_COMMIT_SHA \
  -f confirm_publish=true \
  -f auth_only=false
```

For an authorization-only preflight, use the same reviewed commit and change the final input to `-f auth_only=true`. It cannot upload an extension. Once trust is verified, an explicitly approved release can use `auth_only=false`.

The placeholder is intentionally invalid until replaced with the reviewed SHA. No workflow is triggered by a push, pull request, tag, or ordinary local packaging.

## Workflow verification and safety gates

- Exact repository, `main` branch, explicit confirmation, full commit SHA, publisher/name/repository URL, and manifest version are checked before dependency installation.
- Dependencies use `npm ci --ignore-scripts`. Type checking, offline tests, dependency auditing, and packaging must all succeed.
- The VSIX must contain exactly nine expected entries, including the selected conversation icon and privacy/license notices, with no source, credentials, reference clones, dependencies, or audit evidence.
- The archived runtime must match both the production bundle and the CJS bundle exercised by integration tests.
- The build records the VSIX SHA-256. The publishing job downloads the immutable artifact from the same workflow run and checks the hash again before uploading that exact VSIX.
- Official GitHub Actions are pinned to full commit SHAs. Checkout does not persist credentials. Each job has a 15-minute hard timeout; concurrent releases are serialized without canceling an in-progress upload.
- No `--skip-duplicate`, `--no-verify`, automatic billing/provider fallback, or automatic version bump is used. Retrying after an ambiguous upload requires checking the actual Marketplace state first.

## Local checks

```bash
npm ci --ignore-scripts
npm run check
npm test
npm audit --audit-level=low
npm run package
```

Packaging creates `artifacts/lab530.chatgpt-subscription-for-copilot-0.1.1.vsix` locally. `vscode:prepublish` compiles only; it does not publish. Review the exact archive and hash before approving publication.

## Acceptance boundaries

- The user confirmed real text inference after the SSE compatibility fix. The agent did not replay a real model request.
- Full live tool execution/results/reasoning replay, account lifecycle, cancellation, and Windows/Linux/remote behavior remain to be accepted. Offline tests do not establish upstream availability.
- OpenAI SIWC remains Preview and subject to eligibility, distribution, branding, usage, and service limitations. Packaging or Marketplace publication does not grant upstream access.
- The one-time plan-use notice follows successful enabled sign-in. Failed/canceled or non-enabled sign-in does not mark it shown; earlier acknowledgments are honored without a duplicate popup.
- Version 0.1.1 forwards actual successful token counts using the explicitly approved non-public Copilot `usage` MIME convention over stable `LanguageModelDataPart`. It also enforces default input budgets, validates vault writes, reuses retained App registrations for reconnect, and locally pauses repeated quota requests for 60 seconds. The local pause is not a quota reset estimate; the user's upstream 50%/100% discrepancy remains unresolved.
- Native thinking/context submenus use DeepSeek-style non-public compatibility metadata while retaining stable provider registration/streaming and no proposed-API opt-in. Mock/CJS tests are not live UI acceptance; verify controls and context budgeting in the target VS Code/Copilot build before claiming compatibility. Catalog limits or explicit metadata overrides determine available budgets; the UI does not manufacture a 1M context window.
- Final store presentation, screenshots, support readiness, and upstream distribution requirements should be reviewed before publication.

## Migration from earlier development identities

The earlier `local-dev.chatgpt-for-copilot` and `lab530.chatgpt-for-copilot` identities differ from the current `lab530.chatgpt-subscription-for-copilot` identity. Each has independent SecretStorage ownership.

1. If appropriate, the user signs out in the old extension to attempt session revocation.
2. Disable or uninstall the old extension before enabling the new one to avoid duplicate commands/provider registration.
3. Install the `lab530.chatgpt-subscription-for-copilot` VSIX, reload the window, and authorize it independently.
4. Never automatically read or copy the old SecretStorage. A publisher rename does not migrate credentials.

A release request does not authorize automatic login, credential migration, sign-out, or window reload in a user's editor.
