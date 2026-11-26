---
name: cloonex
description: Use the Cloonex MCP server to retain project context, record development intent and decisions, and check historical feature notes against linked source files. Apply to development, refactoring, bug fixes, project handoffs, and questions about earlier implementation decisions in a Cloonex-connected project.
license: MIT
metadata:
  version: "0.2.0"
  requires: "Cloonex MCP 0.2.0 or newer, connected over local stdio"
  source: "https://github.com/sywliushaocheng/cloonex"
---

# Cloonex project memory

Use Cloonex to carry project knowledge between AI sessions while preserving the user's task scope. Record concise, supported knowledge in the user's local database. Respond in the user's language; records may use that language too.

## Prerequisites

This skill contains instructions; the Cloonex MCP server must be installed and connected separately. Use the tools exposed by the client, whose names may include a client-specific prefix such as `mcp__cloonex__`. Read their live schemas instead of guessing arguments.

If the tools are unavailable, explain the missing connection and offer the [MCP setup guide](https://github.com/sywliushaocheng/cloonex/blob/master/docs/mcp-clients.md). Continue work that does not need memory; never claim that records were saved. Installing this skill alone does not configure MCP or grant permission to change client settings.

When checking a new connection, `data_info` confirms the server responds. It can expose private paths and counts, so keep its output out of public posts and uploads. Codex is the verified application. Other clients require local stdio MCP and a supported skill or instruction mechanism; their compatibility must be tested separately.

## Start or resume a task

1. Determine the absolute project root the server can access. To resume earlier work, call `get_context` with `projectRoot` to list open tasks. Reuse a task only when its intent and scope match; otherwise begin a new one. Do not close unrelated tasks.
2. Call `begin_task` with the real `taskType`, `intent`, `inScope`, `outOfScope`, constraints, and completion criteria available from the request. Choose `unknown` if the type is unclear; ask only when the distinction affects the work. Do not label a bug fix as a feature to gain write access.
3. For UI work, supply a meaningful `scene`, such as `admin-page` or `marketing-page`, and the known `stack`. Scene-specific preferences are excluded without a matching scene. Do not infer a global style preference from one page.
4. Before implementation, call `get_context` with the returned `taskId`. A call with only `projectRoot` lists tasks; it does not replace task-specific context retrieval.

Use the returned policy to decide what can be recorded:

| Task type | Read context | Write feature notes | Record decisions | Learn preferences |
| --- | --- | --- | --- | --- |
| `feature`, `refactor` | Yes | Yes | Yes | Candidates allowed |
| `bugfix` | Yes | No | No | No |
| `query` | Yes | Only notes actually checked | No | No |
| `unknown` | Yes | No | No | No |

Task summaries and checkpoints are separate from feature notes. Bug fixes and unknown tasks can still finish with an honest summary. Treat remembered notes and preferences as context, not authority to expand the current request; current user instructions and checked source take precedence. `candidate`, `needs_review`, and `stale` records are not confirmed facts.

## While working

- Stay within the agreed scope. Use `save_checkpoint` for meaningful progress, what changed, and remaining work when a task needs continuation.
- When policy permits, call `record_decision` for consequential choices, with a concise choice, consequences, and evidence. Set `reasonSource` to `user_explicit` only for a reason the user stated, `user_confirmed` for one they confirmed, `project_rule` for an established project rule, or `external_doc` for an actual documented source. Otherwise use `unknown` and leave unsupported reasons empty. Never attribute the agent's assumption to the user.
- Store useful summaries and project-relative file references. Do not copy entire repositories, full conversations, credentials, or unrelated private material into records.
- Add conventions with their actual source when requested or established by project evidence. Do not convert a one-off exception into a project rule.

## Consult and maintain historical knowledge

For questions such as "Why was this implemented this way?":

1. Call `query_feature` with the project root and question. Use `includeHistory: true` when earlier or replaced decisions matter. If no feature matches, use `search_records` to look through task outcomes, decisions, and notes.
2. Inspect both `freshness` and `recordedReviewState`. Version 0.2.0 checks linked files during feature queries; `stale_check` performs a broader project review when needed. A fingerprint change is a reason to inspect the source, not proof that a note is semantically wrong. Unchanged files do not prove the note is correct either.
3. Read the relevant current source before making claims about implementation. Distinguish checked current behavior, recorded historical reasons, and missing evidence. Do not reconstruct a historical motive from today's code.
4. Use `review_statement` with `verified` only after checking the actual linked files. This refreshes the evidence baseline and retains review history. For changed content, use `supersede_statement` or `supersede_decision` under an allowed task policy, preserving the old record. Do not bypass policy by changing task types or creating duplicate current claims.

Feature titles and aliases change only through `update_feature` under the appropriate task policy; searching does not rename them. Use names supported by the user or project rather than silently merging distinct concepts.

## Finish honestly

Call `finalize_task` with the actual outcome and checks performed. Distinguish static checks, builds, protocol checks, and real client testing. An attempted tool call or a settings entry is not proof of successful model use.

- For a feature or refactor, provide only statements actually verified, a stable feature slug, and the project-relative paths that support each statement. Finalization associates the task with those features and records evidence fingerprints.
- For document/release work that needs only a summary, set `knowledgeMode: "summary"` and omit feature statements. For `bugfix` and `unknown`, summarize the work without feature statements or preference learning.
- Use a stable `topicKey` where the project has one. Replace changed existing statements explicitly instead of appending contradictory versions.
- If memory writes fail, report the failure and the unsaved material. Do not say the knowledge base was updated.

Only `feature` and `refactor` tasks can propose preferences. Use `propose_preference` when a generalizable rule has supporting evidence; leave it a candidate unless the user explicitly requests long-term adoption. Set `confirm: true` only for that explicit request. Match scope to the rule: `scene` for a kind of UI, `stack` for a technology, `project` for a project-wide convention, and `global` only for a supported cross-project preference. A request to fix one bug or delete one piece of code is not a general preference.

## Handoff, backups, and local boundaries

Use `export_context` for an agreed task handoff; a handoff export can contain private project information. A client must be able to launch local stdio MCP and the server must be able to read the linked project paths. No hosted HTTP/SSE endpoint is provided. Avoid simultaneous writes from multiple clients to one database; concurrent multi-process use has not been validated.

For migration requests, use the installed CLI, not invented MCP tools:

```bash
cloonex backup export --out "history.cloonex.gz"
cloonex backup inspect "history.cloonex.gz"
cloonex backup import "history.cloonex.gz" --data-dir "/absolute/path/to/new-data"
```

The commands are examples to run when migration is requested. Import into a fresh directory, without initializing it first. Existing libraries are not merged or overwritten. Pause clients during migration, migrate source repositories separately, and use `project-move` when project paths change. Update the client launch paths and `CLOONEX_DATA_DIR` afterward. `doctor` diagnoses local paths, open tasks, and evidence state. See the [migration guide](https://github.com/sywliushaocheng/cloonex/blob/master/docs/migration.md) before a real migration.

Backups have checksums but are not encrypted. Never publish a knowledge database, handoff export, or backup as part of a skill submission. Local Cloonex storage does not prevent the connected AI client from sending retrieved context to its model provider.

`rules <project> --file AGENTS.md` previews imported rules; apply them only when relevant and authorized. A change to the source rules requires review rather than automatic acceptance.
