# PDF Reader Project

> A PDF reader application. *(Work in progress. Update this section as the project takes shape.)*

## Overview

Describe what the PDF reader does and who it's for. For example:

- Open and view PDF files
- Search text inside documents
- Extract text or images
- Bookmarks / annotations

## Tech Stack

*To be decided* (e.g. Python + PyMuPDF, Electron + PDF.js, React + pdf.js, etc.)

## Getting Started

```bash
# 1. Clone / open the project
cd "pdf reader project"

# 2. Install dependencies
#    (add the command once a stack is chosen, e.g. `pip install -r requirements.txt` or `npm install`)

# 3. Run the app
#    (add the run command here)
```

## Project Structure

```
pdf reader project/
├── README.md        # This file
└── ...              # Source files go here
```

---

# Using Claude Code Effectively

This section is a practical guide to getting the most out of Claude Code while building this project.

## 1. Set up the project memory (`CLAUDE.md`)

Claude Code reads a `CLAUDE.md` file at the start of every session. It's the best place to record
project rules you'd otherwise repeat in every chat.

- Run **`/init`** once there is some code, and Claude will generate a `CLAUDE.md` from the codebase.
- Add things like:
  - How to install, run, build and test the project
  - Coding style and conventions (naming, formatting, folder layout)
  - Things to avoid ("don't add new dependencies without asking")
- Keep it short and up to date. Treat it like onboarding notes for a new teammate.

## 2. Start with a clear, specific request

Good prompts state the **goal**, the **context**, and **what "done" looks like**.

| Weak | Strong |
|------|--------|
| "Make a PDF reader" | "Create a Python desktop app using PyMuPDF and Tkinter that opens a PDF, shows one page at a time, and has Next/Previous buttons." |
| "Fix the bug" | "Opening a password-protected PDF crashes in `viewer.py`. Show a password prompt instead and add a test for it." |

Tips:
- Mention files with **`@`** (e.g. `@src/viewer.py`) so Claude reads exactly what you mean.
- Paste error messages and stack traces in full.
- Drag in screenshots when describing UI problems.

## 3. Plan before you build

For anything bigger than a small fix:

1. Switch to **Plan Mode** (press **Shift+Tab** to cycle modes in the CLI, or pick it from the mode menu in VS Code).
2. Ask Claude to explore the code and propose a plan.
3. Review and adjust the plan, then let it implement.

This catches misunderstandings before any files change.

## 4. Work in small, verifiable steps

- Build one feature at a time (e.g. "open a file", then "render a page", then "search").
- Ask Claude to **run the app or tests** after each change to confirm it works.
- Have Claude write tests early. They give it a way to check its own work.

## 5. Use version control

- Initialize git now: ask Claude to "initialize a git repo and add a `.gitignore` for this stack."
- Commit after each working step ("commit this with a descriptive message").
- If something goes wrong, you can always roll back. You can also press **Esc twice** in the CLI
  to rewind the conversation and code to an earlier point.

## 6. Stay in control

- Press **Esc** to interrupt Claude at any time and redirect it.
- Review the diffs Claude shows before accepting edits.
- Use **permission settings** (`/permissions`) to allow commands you trust (like running tests)
  so you're not prompted every time, while still approving risky actions.

## 7. Manage the conversation

- **`/clear`**: start fresh when switching to an unrelated task. Old context can confuse new work.
- **`/compact`**: summarize a long conversation to free up room while keeping the key points.
- **`/model`**: switch models (more powerful for hard problems, faster for simple ones).
- **`/help`**: list all available commands.

## 8. Automate repeated work

- **Custom slash commands / skills**: save prompts you use often (e.g. "review my changes")
  in `.claude/commands/` or `.claude/skills/` so you can run them with `/name`.
- **Hooks**: make things happen automatically, e.g. run a formatter after every edit.
  Ask Claude: "add a hook that runs the formatter after each file edit."
- **MCP servers**: connect Claude to external tools and data sources (databases, browsers, docs).

## 9. Ask Claude to explain

Claude Code isn't only for writing code. Use it to learn:

- "Explain how this file works."
- "What are the trade-offs between PDF.js and PyMuPDF for this project?"
- "Review my code for bugs" (or use **`/code-review`**).

## Quick Reference

| Action | How |
|--------|-----|
| Generate `CLAUDE.md` | `/init` |
| Plan before coding | Shift+Tab → Plan Mode |
| Reference a file | `@path/to/file` |
| Interrupt Claude | `Esc` |
| Rewind | `Esc` `Esc` |
| Fresh context | `/clear` |
| Shrink long chat | `/compact` |
| Change model | `/model` |
| Review code | `/code-review` |
| All commands | `/help` |

---

## License

*Add a license here (e.g. MIT).*
