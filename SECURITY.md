# Security Policy

Security fixes target the latest release and the current development branch.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub **Security → Advisories → Report a vulnerability**, if enabled, or a private channel with the maintainers. Include the affected version, impact, and minimal reproduction. Remove credentials, workbench access links, and private data.

If no private channel is available, open an issue asking for one without describing the vulnerability. Coordinate disclosure with the maintainers, and revoke any exposed credentials with their provider.

## Workbench access

Anyone with a workbench entry link can operate its Codex tasks. Keep links private and use a trusted network or SSH forwarding. Installation preserves Codex permissions; browser tasks default to the `workspace-write` sandbox. Explicitly enabling full access removes that sandbox and per-command approval. See [installation](README.md#install).
