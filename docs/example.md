# A complete example: remember an export decision

[中文说明](example.zh-CN.md) · [Back to the README](../README.md)

This fictional order-export fixture demonstrates actual MCP calls. It is not a production export system or a recording of a model conversation.

## Run it

From a source checkout, after `npm ci`:

```bash
npm run demo
```

No API key, Codex login, global install or MCP configuration is needed for this example. The script starts the local MCP server, uses an isolated temporary project and database, closes the server and removes its temporary files on exit. It does not use your existing Cloonex data.

To save the selected results used by the README animation:

```bash
npm run build
node scripts/demo.mjs --output docs/assets/demo-transcript.json
```

The GIF and static poster are rendered from this transcript with `python scripts/render-demo.py` (optional Python dependency: Pillow). They are text-output replays, not screen recordings.

## What it does

| Step | Real calls | Checked result |
|---|---|---|
| Define the task | `project_init`, `project_add_convention`, `begin_task`, `get_context` | The task receives the instruction not to fetch unloaded pages. |
| Save the implementation and reason | `record_decision`, `finalize_task` | A two-row serializer is executed and checked; its file fingerprint is saved. |
| Reconnect | Close the first server, start a second, call `query_feature` | The new process retrieves “Current page only” and its recorded reason. |
| Edit the linked file | Append a comment, call `stale_check` | The number of statements needing review changes from 0 to 1. |
| Check the policy | Start a `bugfix` task, call `propose_preference` | The server rejects the preference write. |

The requirements in [examples/order-export](../examples/order-export) are a fictional source document. The demo records the reason as `external_doc`; it does not pretend that an actual user expressed it. The checked-in [transcript](assets/demo-transcript.json) contains selected results without machine paths or task IDs.

The source edit deliberately changes only a comment. Fingerprints detect file changes, not semantic differences. In 0.2.0, feature lookup automatically checks the linked evidence; `stale_check` additionally provides a project-wide report. Neither automatically updates the explanation or proves the code is wrong.

## Try the workflow in Codex

After completing the [installation](../README.md#quick-start), open your own project and give Codex a concrete task:

> Use the Cloonex workflow for a new feature. Add order export for the currently loaded page only. Do not fetch other pages or add a server-side export job. Read the project context first, record only supported reasons, and save verified statements with the files you actually checked. Do not confirm any long-term preference unless I ask.

In a later session:

> Use Cloonex to look up the order-export feature and run a stale check. Explain the recorded implementation, the documented reasons and anything that needs checking against the current source. Clearly separate historical decisions from current code.

The exact model response depends on your client and instructions. Cloonex supplies structured records; it does not automatically capture every conversation or guarantee that a model uses them correctly.

## What this establishes

The runnable example checks persistence across two MCP processes, decision provenance, linked-file change detection and the bugfix learning guard. It does not establish better model output, reduced token usage, cross-model compatibility or production correctness.
