# Cloonex

在借助 AI 开发的同时，持续保存**开发意图、项目约定、关键决定和功能逻辑**，让项目知识独立于具体模型存在，并在长期迭代后仍然可以追溯。

首版接入对象是 **Codex**，通过 MCP 以 stdio 方式按需启动，不常驻后台、不需要账号、不上传个人数据。

## 它解决什么

| 问题 | Cloonex 的做法 |
|---|---|
| AI 开发偏离原意 | 任务开始先明确目标、范围与完成条件，结束后逐项核对 |
| 换模型后风格不一致 | 项目约定与决定保存在本地，任何模型都能读取 |
| 产出“AI 味”重 | 记录认可与不认可的实例，按场景限定偏好适用范围 |
| 迭代一两年后忘了功能逻辑 | 功能档案区分当前说明与历史决定，代码变化后提示复核 |
| 经验散落在对话里 | 关键决定与理由结构化保存，可检索、可导出 |

## 快速开始

```bash
# 1. 安装依赖并构建
npm install
npm run build

# 2. 初始化个人数据目录（可以放在 D 盘等位置）
node dist/src/cli.js init --data-dir D:\CloonexData

# 3. 输出 Codex 接入配置，按提示加入 config.toml
node dist/src/cli.js mcp-config

# 4. 安装开发流程技能
node dist/src/cli.js install-skill
```

配置写入 Codex 后，需要在 Codex 中审阅并信任该 MCP 服务。之后在项目里说“开始一个新功能任务”即可走完整流程。

## 接入配置示例

```toml
[mcp_servers.cloonex]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:/path/to/cloonex/dist/src/mcp/server.js']

[mcp_servers.cloonex.env]
CLOONEX_DATA_DIR = 'D:/CloonexData'
```

`CLOONEX_DATA_DIR` 是**个人数据目录**，与程序安装位置完全独立。程序升级或重装不会清除数据。

## 使用流程

```
begin_task → get_context → (开发) → record_decision / save_checkpoint → finalize_task → propose_preference
```

- **begin_task**：确定任务类型。类型决定学习边界，由服务端强制执行。
- **get_context**：读取项目约定、适用偏好、关联功能与关键决定。
- **record_decision**：记录方案与理由。`reasonSource` 必须真实，模型不得编造用户动机。
- **finalize_task**：写入已核对的功能说明，并记录代码指纹用于过时检测。
- **propose_preference**：默认写入候选偏好，只有用户明确要求长期采用才确认。

## 学习边界（硬性）

| 任务类型 | 读取已有约定 | 写入功能/决定 | 学习偏好 |
|---|---|---|---|
| 新功能开发 | 是 | 是 | 是 |
| 功能重构 | 是 | 是 | 是 |
| Bug 修复 | 是 | **否** | **否** |
| 查询与梳理 | 是 | 仅可保存核对过的说明 | 否 |
| 类型不明确 | 是 | 否 | 否 |

这些规则在 `src/domain/policy.ts` 中定义，并在写入前由 `assertCan*` 守卫执行。**不依赖提示词自觉遵守**：Bug 修复任务即使调用写入工具也会被拒绝。

## 关键设计

**事实、理由、推测分开保存。** 代码能证明行为，记录能证明当时的决定；没有证据的原因标为 `unknown`，系统不会事后补写动机。

**当前说明与历史决定分开。** 修改功能说明时旧版本标记为历史并保留关联，因此可以回答“现在怎么实现”和“当初为什么这样做”。

**按需核对，不后台扫描。** 功能说明关联文件指纹，查询或开发时按需比对，代码变化后提示复核。

**候选偏好不等于约束。** 候选规则可被检索，但不会注入任务上下文；只有已确认的规则才作为约束。

## CLI

```bash
node dist/src/cli.js info --detail          # 数据位置与记录数量
node dist/src/cli.js projects               # 已注册项目
node dist/src/cli.js project <路径>         # 项目约定与功能档案
node dist/src/cli.js tasks <路径>           # 任务历史
node dist/src/cli.js show <任务ID>          # 任务上下文
node dist/src/cli.js export <任务ID>        # 导出交接 Markdown
node dist/src/cli.js stale <路径>           # 检查记录与代码是否不一致
node dist/src/cli.js preferences            # 偏好列表
node dist/src/cli.js preference-revoke <ID> # 撤销偏好
node dist/src/cli.js mcp-config             # 输出接入配置
node dist/src/cli.js install-skill          # 安装开发流程技能
```

## 技术选型说明

- **TypeScript / Node.js（≥ 20.11）**，通过 npm 分发。
- **SQLite 使用 `node-sqlite3-wasm`**：纯 WebAssembly，无需本地编译，Windows 与 macOS 安装时不需要工具链。
  - 开发中实测 `better-sqlite3` 的原生预编译二进制在本机会导致解释器崩溃（0xC0000005），因此改用 WASM 版本。
  - 该构建的 SQLite 为 3.53，`journal_mode` 为 `delete`（不支持 WAL）。MCP 服务每个进程使用单一连接，写入已串行化。
- **不收集数据**：无账号、无云端服务、无默认遥测。使用云端模型时，被选中的约定与代码材料会进入模型上下文——这与“数据保存在本地”是两件事，不混淆表述。

## 开发

```bash
npm run typecheck   # 类型检查
npm test            # 构建并运行测试
npm run build       # 编译到 dist/
```

测试覆盖两层：

- `test/core.test.ts`：领域逻辑，含学习边界、偏好生命周期、过时检测、历史保留。
- `test/mcp.test.ts`：通过真实 stdio 传输启动 MCP 服务，按 Codex 的调用方式验证完整闭环。

## 当前状态

已完成**接入原型**阶段：Codex 能够读取约定、写入决定与功能说明、查询旧功能，失败可见；Bug 修复任务不产生学习记录；代码变化后过时检测生效。

尚未实现：图形界面、跨模型适配、后台事件钩子、设计图解析、团队协作。详见 `docs/验收状态.md`。
