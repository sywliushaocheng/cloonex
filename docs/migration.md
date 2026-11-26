# Back up and move your history / 备份与换电脑迁移

[English README](../README.md) · [中文首页](../README.zh-CN.md)

## 中文：旧电脑打包，新电脑导入

需要两台电脑均安装 Cloonex **0.2.0 或更新版本**。停止使用该数据目录的 AI 客户端后操作，导出时数据库使用 SQLite 一致性快照；导出文档在打包期间也应保持不变。

旧电脑运行（可将输出路径换成 U 盘、移动硬盘或其他本地目录）：

```bash
cloonex backup export --out "cloonex-history.cloonex.gz"
cloonex backup inspect "cloonex-history.cloonex.gz"
```

如平时使用独立目录，显式指定：

```bash
cloonex backup export --data-dir "D:/CloonexData" --out "cloonex-history.cloonex.gz"
```

把迁移包复制到新电脑，安装程序后，**直接导入，不需要先执行 `init`**：

```bash
cloonex backup inspect "cloonex-history.cloonex.gz"
cloonex backup import "cloonex-history.cloonex.gz" --data-dir "D:/CloonexData"
cloonex doctor --data-dir "D:/CloonexData"
cloonex mcp-config --format json --data-dir "D:/CloonexData"
```

macOS/Linux 可把目标换成自己的绝对路径，例如 `/Users/yourname/CloonexData` 或 `/home/yourname/CloonexData`。JSON 配置外层结构仍需符合所用客户端；Codex 可用默认 TOML 格式，或执行 `cloonex mcp-config --direct`。

成功导入后，本机配置会记录新目录，但**客户端里原来设置的 `CLOONEX_DATA_DIR` 环境变量优先级更高**，需要重新生成并更新客户端配置。若使用 Codex 技能，再运行 `cloonex install-skill`。新机器的 Node 和程序路径也要使用新机器的真实路径。

### 包含哪些历史

- 项目、项目规则、任务目标与总结、检查点。
- 功能、当前与历史说明、决定、候选/确认偏好。
- 原始证据、指纹基线、复核历史、功能关联、别名和项目组。
- 数据目录 `exports/` 下已导出的交接文档。

迁移保留原有 ID 和关系。**不包含项目源码、Node/npm、Codex 或其他客户端配置、账号凭据和目录里其他任意文件**。项目代码需通过自己的仓库、磁盘或其他方式迁移。

迁移包是带逐文件 SHA-256 校验的 gzip 文件，扩展名建议 `.cloonex.gz`。它没有加密；请像保管个人知识库一样保管，不要上传到公开仓库。校验用于发现文件损坏，不是来源签名。

### 新电脑项目路径变化

先用 `cloonex projects` 或 `cloonex doctor` 查看项目 ID，再调整原有项目位置：

```bash
cloonex project-move prj_example "D:/NewProjects/my-app"
cloonex doctor --check-files
```

替换示例 ID 和目录。这个命令保留原来的项目 ID，不移动源码，不创建第二份历史。新目录必须存在，且不能已经属于另一个项目。源代码没有拷贝或路径未迁移时，历史仍能查询，但文件核对会报告缺失；不要据此直接删除历史记录。

### 目标已有历史或导入失败

当前是**整库迁移到新目录**，不会自动合并两个知识库。目标已有 `cloonex.sqlite` 或 `exports/` 会被拒绝，不提供强制覆盖参数。即便已经初始化，也请另选新目录导入，核对后再让客户端切换过去。

导入检查格式、压缩大小、各文件校验、路径、SQLite 完整性与关联、schema 版本和记录数，再在临时库中升级旧结构。失败不会覆盖已有数据库；配置仅在成功后更新。支持旧知识库备份升级，不支持降级到较旧程序。

## English

Install Cloonex 0.2.0 or newer on both machines. Pause clients and keep exported documents unchanged during the operation.

On the old machine:

```bash
cloonex backup export --out "history.cloonex.gz"
cloonex backup inspect "history.cloonex.gz"
```

Transfer that file yourself. On the new machine, import directly into a **fresh** data directory; do not initialize it first:

```bash
cloonex backup import "history.cloonex.gz" --data-dir "/absolute/path/to/CloonexData"
cloonex doctor --data-dir "/absolute/path/to/CloonexData"
cloonex mcp-config --format json --data-dir "/absolute/path/to/CloonexData"
```

The archive preserves the database's IDs, relationships, preferences, evidence, review history and `exports/` documents. It does not include source repositories, application credentials or client configuration. It is compressed and checksummed, **not encrypted or signed**.

An existing database or exports directory is never overwritten. This release restores a whole knowledge base into a fresh location; it does not merge independent databases. Successful import records the local data directory in configuration; update any client `CLOONEX_DATA_DIR` environment setting and regenerate executable paths for the new machine.

Move source repositories separately. Use `cloonex projects` to identify existing projects and `cloonex project-move <project-id> <new-source-path>` to relink them without losing history. Run `cloonex doctor --check-files` afterwards. A missing file means evidence cannot currently be checked, not that its explanation is necessarily wrong.

Archive limits are 256 MB compressed, 512 MB decoded and 10,000 exported files. SQLite snapshots are consistent; concurrent modification of exported documents and concurrent client writes during restoration are unsupported. Keep original data and the archive until you have checked the result.
