# Cloonex companion skill / 配套技能

Free and open source under MIT. [Skill source](../skills/cloonex/SKILL.md) · [MCP setup](mcp-clients.md) · [中文说明](#中文说明)

## What is included

The skill teaches an agent when and how to use Cloonex: load task context before implementation, preserve scope, record supported decisions, review historical notes against linked source files, and save verified outcomes. It uses the user's language for responses and records.

The ZIP contains `cloonex/SKILL.md`, optional Codex UI metadata in `cloonex/agents/openai.yaml`, and the MIT license. The main instructions are self-contained, so clients that load only `SKILL.md` do not need supporting files. It contains no MCP runtime, credentials, project records, or databases.

Skill **0.2.0** works with MCP **0.2.0**. Skill releases use `skill-v*` tags independently of MCP runtime releases. The skill is free; there is no Cloonex account, subscription, or paid activation. An AI client's own pricing still applies.

## Install without cloning

1. [Download the skill ZIP](https://github.com/sywliushaocheng/cloonex/releases/download/skill-v0.2.0/cloonex-skill-0.2.0.zip). [Release and SHA-256 checksum](https://github.com/sywliushaocheng/cloonex/releases/tag/skill-v0.2.0).
2. Use your client's skill import feature, or extract and copy the `cloonex` directory into its supported skills directory. For Codex, use `$CODEX_HOME/skills` when configured, otherwise `~/.codex/skills`. If an existing `cloonex` skill has custom edits, compare or back it up before replacing it.
3. Install and connect the MCP server separately, following the [client setup guide](mcp-clients.md). Requires Node.js >=20.11 and npm:

   ```bash
   npm install --global "https://github.com/sywliushaocheng/cloonex/releases/download/v0.2.0/cloonex-0.2.0.tgz"
   cloonex init
   cloonex mcp-config --format json
   ```

   Use the generated local command, arguments, and environment in the client's own MCP configuration format. For Codex, `cloonex mcp-config --direct` prints TOML. Client configuration is not changed automatically.
4. Reload the client as needed to discover the skill and MCP tools. Ask it to call `data_info` to verify the connection, then try: **"Use the Cloonex workflow for this task. Read the project context first and save only findings you actually verify."** In Codex you can explicitly invoke `$cloonex`.

`cloonex install-skill` remains a shortcut to install the skill bundled with the installed MCP package. An existing v0.2.0 `.tgz` still contains its original skill; use the separate ZIP above for this updated companion skill. The existing runtime archive has not been replaced.

## Client support

Codex is the verified application. Other clients, including versions of Claude Code, Cursor, and Copilot with suitable local MCP and skill support, are candidates for configuration, not a validated compatibility list. Follow the installed client's skill discovery rules; copying a Markdown file does not guarantee it is loaded. Clients with only remote MCP URLs cannot connect directly to this local stdio server.

The skill does not automatically capture conversations or enforce model behavior. Cloonex stores records locally, while the connected AI client may send retrieved context to its model provider. Do not publish personal data, context exports, or history backups with the skill.

## 中文说明

这是 Cloonex MCP 的免费开源配套 Skill，MIT 授权，帮助 AI 在开发前读取项目上下文、保持任务范围、记录有依据的决定，并在任务结束后保存核对过的总结。英文技能正文支持按用户语言交流和记录。

**无需克隆项目**：下载上面的 ZIP，按所用客户端支持的方式导入或解压，将 `cloonex` 文件夹放入技能目录。Codex 默认目录为 `~/.codex/skills`，设置了 `CODEX_HOME` 时使用其下的 `skills`。已有自定义技能请先对比或备份。

**Skill 和 MCP 服务需要分别安装**：技能包只包含流程说明、可选 Codex 展示信息和许可证。按[客户端配置指南](mcp-clients.md#中文说明)安装 MCP 服务并配置本机启动路径；导入 Skill 不会自动配置服务。安装后按需重新加载客户端，调用 `data_info` 核对连通，再用示例任务确认 AI 实际调用了工作流。

当前实测应用为 Codex。其他软件需要分别验证其本地 stdio MCP 与技能加载能力，不能把平台支持的客户端数量当作本项目的实测兼容数量。

现有 `cloonex install-skill` 仍复制已安装 MCP 软件包中附带的技能；已发布的 MCP v0.2.0 安装包保持原样。获取本次更新的 Skill，请下载独立 `skill-v0.2.0` 发布包。MCP 程序版本仍为 0.2.0。

## Build the public ZIP

Maintainers need Python 3. Run from the repository root:

```bash
python scripts/package-skill.py
```

The script creates the ZIP and its `.sha256` file under ignored `work/skill-release/`. It packages an explicit public-file list and verifies the archive contents; it never bundles a working directory or personal knowledge library.
