---
name: install
description: Install, update, or diagnose this Live Delivery Codex plugin from a local package. Use when the user asks to set up this plugin or repair its installation; not for installing unrelated skills or starting delivery tasks.
---

Use the bundled installer; do not reconstruct marketplace, MCP, or hook configuration by hand. This skill can be read directly from the package before installation. Once installed it is available as `$ld:install`.

## Locate and install

1. Resolve the plugin root as two directories above the directory containing this `SKILL.md`. It contains `.codex-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, and `dist/setup.mjs`. In a checkout or unpacked release, this is the `live-delivery/` subdirectory. Do not assume the current directory is the plugin root. If the runtime is absent in a source checkout, follow `../docs/development.md` relative to the plugin root to build it; an unpacked release needs no npm dependencies.
2. Use the user's intended `CODEX_HOME` and Codex executable (`CODEX_BIN`, or `codex` on `PATH`). Check `node --version` and `codex --version` (or the selected executable). Node 22+ and native Codex plugin/hooks support are required; this package is verified with Codex 0.166.0 and 0.167.1. Preserve the existing model, provider, authentication and unrelated plugins. The installer discovers provider environment variable names from Codex configuration and forwards them through the private installed MCP manifest. Values stay in the user’s environment. Do not add provider-specific names or credentials to the distributed package. After a provider configuration change, rerun the installer and open a new Codex session.
3. Select the user's project as the workspace. Keep it outside this repository and Codex configuration directories. If no project was specified and the current directory is the repository or plugin root, use `~/live-delivery-workspaces/first-task`. Do not start a delivery task as part of installation. For an upgrade, keep active tasks on their existing runtime and arrange the new installation after those sessions finish; do not stop them to make the installer succeed.
4. When the user has requested installation or an update, run the following commands, substituting the actual absolute paths. That request authorizes the installer's plugin/hook configuration; `--yes` supplies its consent prompt without launching a nested interactive Codex session. Reading this skill alone is not an installation request.

   ```bash
   node "/absolute/plugin-root/dist/setup.mjs" --yes --install-only --workspace "/absolute/project"
   node "/absolute/plugin-root/dist/setup.mjs" --doctor --workspace "/absolute/project"
   ```

   A diagnosis-only request uses only the second command. This entry also works from Codex's installed plugin cache, where the root shell wrapper may not exist.

## Sandbox and permissions

Before installing, tell the user: **installation preserves existing Codex sandbox and approval settings; browser-created tasks default to `workspace-write`.** CLI tasks keep the permissions of their existing Codex session. Installing hooks does not enable full access.

- `QWEN_LD_TASK_SANDBOX=danger-full-access` (or the standalone workbench's `--sandbox danger-full-access`) disables the execution sandbox for new browser tasks. Those tasks run with `approval_policy=never`: commands will not ask for individual approval and can access files outside the workspace with the OS account's permissions. Warn about this explicitly if it is configured or proposed. A workspace directory alone is not isolation.
- Installation authorization, including `--yes`, does not authorize changing sandbox or approval policy. Preserve any explicit permission decision already made by the user. Otherwise explain the consequences and obtain their choice before disabling the sandbox; never make it an automatic fallback for an error. Prefer a compatible host or an environment whose outer isolation the user has approved.
- On Linux, the installer reports a known blocker when `/proc/sys/user/max_user_namespaces` is `0`. A bubblewrap namespace error containing `ENOSPC` can be a namespace limit rather than a full disk. Report the execution blocker separately from successful hook installation. Do not change kernel/container settings as part of plugin installation. Absence of a warning is not proof that sandbox execution works; `--doctor` does not run a model task.
- Changing the workbench's sandbox configuration requires restarting its host and applies to new tasks only. Existing Codex processes keep their original permissions; do not stop or restart them merely to install or verify the plugin.

## Verify and hand off

Both commands must exit successfully and report six enabled, content-verified hooks. Installation alone is not proof that model authentication works. Report prerequisite or managed-policy failures accurately; do not keep reinstalling blindly, disable policy, or bypass hook trust. Use the installer's diagnostic output to explain a concrete failure and the next step; do not copy private logs into the conversation.

Tell the user which version, Codex home and workspace were used, then give these next steps:

- Open a **new** Codex session in the workspace, using the same Codex home. The already-running installer agent does not gain newly installed skills and tools automatically.
- Enter `$ld:go` followed by the desired outcome. The model proposes the first usable version and starts production by default, then plans one version at a time. The user adjusts future deliveries in chat. Production starts immediately after the first proposal; there is no plan approval step. Total time is controlled by the single budget control in the workbench.
- Open the real dashboard link printed when the plugin starts. The default bind address is `0.0.0.0`; use its printed server-IP URL from another computer. Do not invent a port or claim a page is online before a host is running. No dashboard is started by `--install-only` or `--doctor`.

Keep the completion reply short: installed version, verification result and any sandbox warning, new-session command and `$ld:go` usage. Do not consume model quota merely to prove installation.
