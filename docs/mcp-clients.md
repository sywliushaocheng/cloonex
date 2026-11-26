# Connect an MCP client

[中文说明](#中文说明) · [README](../README.md)

Cloonex uses the standard MCP SDK and local stdio transport. It does not restrict the client name to Codex. A client needs to launch a local command and support MCP tool calls. A remote-URL-only client cannot connect directly: Cloonex does not currently provide HTTP or SSE transport.

## Connection settings

Install the prebuilt package directly (Node.js ≥ 20.11 and npm required; no Git or source clone):

```bash
npm install --global "https://github.com/sywliushaocheng/cloonex/releases/download/v0.2.0/cloonex-0.2.0.tgz"
cloonex init
cloonex mcp-config --direct
```

npm installs the precompiled tool and its runtime dependencies. `mcp-config --direct` prints Codex TOML; reuse its executable, argument and environment values in the format your client expects. Use the following values in your client's local MCP server configuration:

| Field | Value |
|---|---|
| Transport | Local stdio |
| Command | Absolute path to Node.js, or `cloonex` if your client resolves its launcher |
| Arguments for Node | Absolute path to `dist/src/cli.js`, followed by `mcp` |
| Arguments for `cloonex` | `mcp` |
| Environment | `CLOONEX_DATA_DIR` set to an absolute local data directory |

Prefer absolute Node and CLI paths for desktop clients, whose PATH may differ from a terminal. On Windows, a global `cloonex` launcher may be a `.cmd` file; launching Node directly avoids depending on the client handling shell wrappers.

In 0.2.0, `cloonex mcp-config --format json` generates the JSON envelope below with actual local paths. `--format connection` returns only the transport, command, arguments and environment. The default (and legacy `--direct`) prints **Codex TOML**. No database initialization is needed to generate these values. The configuration envelope and file location still depend on the client.

For a client that uses a `mcpServers` JSON object, the structure is:

```json
{
  "mcpServers": {
    "cloonex": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/cloonex/dist/src/cli.js", "mcp"],
      "env": {
        "CLOONEX_DATA_DIR": "/absolute/path/to/cloonex-data"
      }
    }
  }
}
```

Replace all placeholder paths. On Windows, forward-slash paths such as `C:/Tools/nodejs/node.exe` are valid in JSON; backslashes must be escaped. Some clients use a different top-level object or require an explicit `type: stdio`. Follow that client's configuration schema rather than pasting this envelope unchanged.

Clients such as Claude Desktop or Cursor are possible targets when their installed version supports local stdio MCP servers. These are **configuration candidates, not a tested compatibility list**. Codex is the currently validated application. The separate `npm run demo` uses a generic MCP SDK client and verifies protocol behavior across two server processes.

## Make the model use the workflow

The server advertises workflow instructions and tool descriptions during MCP initialization. The Codex skill is an additional guide, not a requirement of the MCP protocol.

`cloonex install-skill` defaults to Codex's skills directory. For another client, adapt [the workflow text](../skills/cloonex/SKILL.md) to its project-rules or instruction mechanism. Passing `--target` merely copies the file; it does not guarantee that another application recognizes the skill format.

A starting instruction is:

> Use Cloonex for this project. Begin with the correct task type, then read project context. Preserve the agreed scope. Record decisions only when policy permits, with honest reason provenance. Finish with statements and checks you actually verified. Before relying on old feature notes, call both query_feature and stale_check. Bugfix tasks must not learn preferences; only confirm long-term preferences when I explicitly ask.

To verify a connection, ask the client to call `data_info`, then register a disposable sample project with `project_init`. Verify that `begin_task`, `get_context`, `finalize_task` and `query_feature` return records. A visible server in a settings screen alone does not verify model use of its tools.

## Local files and shared data

The server process must be able to read the project paths supplied to it. A sandboxed or remote client may require local execution support or explicit file access. Configuration alone cannot make files on another computer available.

The same data directory makes existing records available to clients on the same machine. Concurrent writes from multiple processes have not been validated; avoid running multiple clients against the same database at once. Separate directories isolate records instead of sharing them. Different models may interpret the same context differently; no cross-model consistency guarantee has been established.

## 中文说明

Cloonex 是标准 **MCP stdio 服务**，服务端没有 Codex 限制。支持启动本地进程并调用 MCP 工具的 AI 软件可以配置接入；仅支持远程 MCP URL 的客户端暂时无法直接连接，因为当前没有 HTTP/SSE 服务。

无需 Git 或克隆，准备 Node.js ≥ 20.11 和 npm 后直接安装已编译软件包：

```bash
npm install --global "https://github.com/sywliushaocheng/cloonex/releases/download/v0.2.0/cloonex-0.2.0.tgz"
cloonex init
cloonex mcp-config --direct
```

npm 安装已编译程序及其运行依赖，无需本机 TypeScript 编译；最后一个命令输出 Codex TOML，其他客户端复用其中的路径和参数并转换成各自格式。启动参数为：

- 程序：Node.js 的绝对路径。
- 参数：Cloonex 的 `dist/src/cli.js` 绝对路径，以及 `mcp`。
- 环境变量：`CLOONEX_DATA_DIR`，指定个人知识库的绝对路径。

执行 `cloonex mcp-config --format json` 可以直接生成含本机真实路径的 JSON；`--format connection` 输出原始连接参数。默认格式（含兼容的 `--direct`）仍是 **Codex TOML**。无需初始化数据库即可生成配置；不是所有客户端都使用 `mcpServers` 外层结构，仍需按客户端格式调整。

Claude Desktop、Cursor 等支持本地 stdio MCP 的客户端可作为接入目标，但本项目目前没有逐一实测。应区分“协议与启动参数通用”和“具体客户端已完成兼容验收”。当前已实测应用是 Codex，独立演示还使用了通用 MCP SDK 客户端验证协议流程。

`install-skill` 默认安装到 Codex 技能目录。其他客户端可以把[技能文件中的流程](../skills/cloonex/SKILL.md)适配到自己的项目规则或提示词中；不安装 Codex 技能也能使用 MCP 工具。服务自身也会提供工具描述和流程说明，但模型是否按流程调用仍取决于客户端与实际指令。

可先让客户端调用 `data_info` 检查连接，再用临时示例项目核对注册、开始任务、读取上下文、结束任务、查询功能的完整流程。读取和指纹检查要求服务进程能访问所传入的项目路径。

同一台机器上的不同客户端可以使用同一数据目录读取已有记录，但多进程并发写入尚未验证，请避免同时对同一数据库操作。使用不同目录则相互隔离。不同模型读取同样材料，也不代表输出完全一致。
