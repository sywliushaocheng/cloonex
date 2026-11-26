# Agensi listing copy — free companion skill

Prepared listing content; this file does **not** indicate platform submission or approval.

## Listing fields

- **Title:** Cloonex — Project Memory for AI Coding
- **Skill name:** `cloonex`
- **Price:** Free / $0
- **License:** MIT
- **Version:** 0.2.0
- **Category:** Developer tools / Coding (choose the closest category available)
- **Tags:** mcp, project-memory, coding, decisions, developer-tools
- **Source:** https://github.com/sywliushaocheng/cloonex/tree/master/skills/cloonex
- **Setup guide:** https://github.com/sywliushaocheng/cloonex/blob/master/docs/skill.md
- **Download:** https://github.com/sywliushaocheng/cloonex/releases/download/skill-v0.2.0/cloonex-skill-0.2.0.zip

## Short description

Carry project context and development decisions between AI coding sessions with the free, open-source Cloonex MCP companion skill.

## Full description

An AI can read your code, but it may not know why the project works that way. Cloonex stores task intent, project conventions, decisions, and feature notes in a local SQLite library and exposes them through MCP.

This companion skill guides an agent through a practical workflow:

- Read project context before implementation and preserve the agreed scope.
- Record important decisions with honest reason provenance and supporting file references.
- Query historical feature notes and check whether linked source files have changed.
- Finish with findings and validation that were actually checked.
- Keep bug-fix tasks from creating unsupported preferences or feature records.

The skill and Cloonex MCP server are free and open source under MIT. There is no Cloonex subscription or paid activation. Your AI client's own charges may apply.

**Requirements:** install Cloonex MCP 0.2.0 separately (Node.js >=20.11 and npm), configure its local stdio connection, and import the skill using your client's supported mechanism. The skill ZIP does not install the server or configure MCP automatically. No source clone is needed; the setup guide links to prebuilt packages.

**Compatibility:** Codex is the verified application. Other agents require their own local stdio MCP and skill support and have not been individually validated by this project. There is no hosted HTTP/SSE endpoint.

**Data boundaries:** Cloonex records live in your local library; the connected AI client may send retrieved context to its model provider. It does not automatically capture all conversations. File fingerprints identify changed content; they do not prove whether a statement is semantically correct.

Public source, installation instructions, and issue tracking are available on GitHub. The downloadable skill contains instructions, optional Codex metadata, and the MIT license only.
