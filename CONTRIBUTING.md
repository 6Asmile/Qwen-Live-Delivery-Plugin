# Contributing

Keep changes focused on a concrete problem. For a new feature, a delivery-protocol change, or a new runtime dependency, open an issue first to discuss scope and compatibility.

## Development setup

Use Node.js 22+ on Linux or macOS. From a source checkout:

```bash
cd live-delivery
npm ci
npm run build
```

See [Development](docs/development.md) for the source layout, local installation, and native Codex and browser tests.

## Making changes

- Keep implementation files under `live-delivery/`: runtime code in `src/`, browser code in `ui/`, and Skill instructions in `skills/`. MCP tool descriptions belong in `src/prompts/tool-descriptions.json`. Public documentation stays in the repository root and `docs/`.
- Preserve tool names, inputs, and outputs where possible. Explain interface changes and their effect on existing task records.
- Preserve published snapshots, chat-driven plan revisions, feedback receipts, and stop requests. Do not silently weaken sandbox or access controls.
- Add focused regression coverage for bugs. Update both languages of the relevant user guides when behavior changes.
- Rebuild and include generated runtime changes with their source. Do not edit `dist/` or generated assets by hand.
- Do not commit credentials, workspaces, `.live-delivery` records, execution logs, private artifacts, or machine-specific configuration. Keep design notes and evaluation material outside the plugin.

## Verification

Run targeted checks while developing. Before opening a PR, run from `live-delivery/`:

```bash
npm run verify
npm run format:check
```

Run the native Codex tests for Skill, manifest, tool, hook, or task-lifecycle changes. Run the browser checks for UI and control changes. Commands are in [Development](docs/development.md).

If a platform or live model test was not run, say so in the PR. Local fixture tests do not establish real model quality.

## Pull requests

Describe the problem, the resulting behavior, and the verification performed. Link related issues and keep unrelated changes in separate PRs.

For bug reports, include the plugin, Codex, Node.js, and OS versions, minimal reproduction steps, and expected and actual results. Remove private information from screenshots and sample files; do not attach full runtime directories or logs.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md). Contributions use the project's [Apache-2.0 license](LICENSE); retain third-party notices. Maintainers should follow the [release instructions](docs/development.md#release) when preparing a release.

## Review and maintenance

Maintainers review contributions and decide when to merge and release them. Record
decisions that affect compatibility or saved user data in the issue or PR, with
the reason and migration plan. Contributors can propose alternatives in the same
discussion.

Before merging, check the relevant test results and documentation. Before releasing,
verify the actual archive and the supported platforms. Published tags and archives
are immutable. Report security problems privately and coordinate disclosure through
the security process above.

Submit only code and assets you have the right to contribute, and retain their
copyright and license notices. Keep discussions respectful and focused on the work;
do not publish another person's private information.
