# Cloonex companion skill 0.2.0

Free, MIT-licensed instructions for using the Cloonex MCP server in AI-assisted development.

## Included

- A self-contained `cloonex/SKILL.md` covering task context, scope, supported decisions, historical evidence checks, and honest task finalization.
- Optional Codex display metadata and the MIT license.
- No MCP runtime, executable installer, credentials, personal project records, or databases.

Download `cloonex-skill-0.2.0.zip` and use the companion `.sha256` file to check its SHA-256 hash. Extract the `cloonex` directory into your client's supported skills directory, or use its skill import feature.

Install and configure **Cloonex MCP 0.2.0 separately**. The existing `v0.2.0` runtime download and version remain unchanged. This skill release has its own source tag, `skill-v0.2.0`. Existing runtime packages retain their original bundled skill.

[Installation guide / 中文安装说明](https://github.com/sywliushaocheng/cloonex/blob/skill-v0.2.0/docs/skill.md) · [MCP connection guide](https://github.com/sywliushaocheng/cloonex/blob/skill-v0.2.0/docs/mcp-clients.md)

Codex is the verified application. Other clients need local stdio MCP support and a compatible skill-loading mechanism and have not been individually tested. The skill guides model behavior; it does not guarantee compliance or automatically capture conversations.

The skill and MCP server require no Cloonex subscription or paid activation. Your AI client's own charges may apply. Context retrieved by the client may be sent to its model provider even though the Cloonex library is local.

## Validation

- Skill frontmatter and structure validated with the skill-creator validator.
- Public ZIP file list, content, checksums, and repeatable packaging checked.
- Existing isolated MCP demo passed: task context, decision retrieval after reconnect, file-change detection, and rejection of preference learning in a bug-fix task.
- This is not a new compatibility test of other AI clients.
