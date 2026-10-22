# Minimal PDF

A fast, keyboard-first PDF reader for Windows where **the page is the whole interface**. There's no
toolbar: everything appears only when you ask for it and disappears with `Esc`.

Built with [Tauri 2](https://tauri.app) and [PDF.js](https://mozilla.github.io/pdf.js/).
The installer is about 2 MB, and the installed app about 5.5 MB (it uses the WebView2 that ships with Windows).

## Features

- **Opens instantly, stays fast.** Only the pages on screen are drawn, so a 500-page PDF scrolls
  as smoothly as a 5-page one.
- **Keyboard first.** Read a whole document without touching the mouse (press `?` in the app for
  every shortcut).
- **Zoom that keeps your place.** Ctrl + mouse wheel, trackpad pinch, or `+` / `−`; fit width and
  fit page with `w`.
- **Search** (`/`): case-insensitive, finds phrases across line breaks, highlights every match.
- **Table of contents** (`t`): a slide-in sidebar from the PDF's bookmarks.
- **Light, dark and sepia themes** (`d`).
- **Remembers where you were.** Every PDF reopens on the same page and zoom; recent files are
  on the start screen (press `1`–`9`).
- **Annotations without a toolbar.** Right-click anywhere on a page for a radial menu around your
  cursor with pen, pencil, highlighter, eraser, rectangle, circle and text comments.
- **Never modifies your PDFs.** Annotations and settings are stored separately (see
  [Where your data lives](#where-your-data-lives)).
- Opens PDFs by double-click once installed, and reuses the open window.

## Annotations: the right-click menu

Right-click on a page (or press `a`) and a ring of tools appears around the cursor:

- **Inner ring:** pointer (back to reading and selecting text), pen, pencil, highlighter, eraser,
  rectangle, circle, text comment.
- **Outer ring:** colours and three sizes for the tool under your cursor, plus a rainbow button for
  **any colour you like**. The highlighter comes with light, see-through colours (yellow, green,
  blue, pink, orange, lavender) so the text underneath stays readable.

While a tool is active:

| Action | How |
|---|---|
| Draw / highlight | Drag on the page |
| Straight line, square, perfect circle | Hold `Shift` while dragging |
| Erase | Eraser tool: drag over a mark to remove it |
| Add a comment | Text tool: click where it should go, then type |
| Change a comment's font, size or colour | Use the small bar above the comment while typing |
| Edit an existing comment | Double-click it (with no tool active) |
| Finish a comment | `Esc`, `Ctrl+Enter`, or click elsewhere |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Put the tool down | `Esc` |

Inside the open menu, `1`–`8` pick a tool and `Esc` closes it.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+O` | Open a file |
| `j` / `k`, `↓` / `↑` | Scroll a little |
| `Space` / `Shift+Space` | Next / previous screen |
| `n` / `p`, `→` / `←` | Next / previous page |
| `g g` / `G` | First / last page |
| `Ctrl+G` | Go to a page number |
| `+` / `−` / `0` | Zoom in / out / 100% |
| `w` | Fit width ↔ fit page |
| `f` or `F11` | Fullscreen |
| `d` | Light → dark → sepia |
| `/` or `Ctrl+F` | Search (`Enter` / `Shift+Enter`, or `n` / `N`, for next / previous match) |
| `t` | Table of contents |
| `a` or right-click | Annotation tools |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo annotations |
| `1`–`9` | Open a recent file (start screen) |
| `?` | Show all shortcuts |
| `Esc` | Close whatever is open / put the tool down / leave fullscreen |

## Install

Build the installers (see [Development](#development)) and run either one from
`src-tauri/target/release/bundle/`:

- `nsis/Minimal PDF_0.1.0_x64-setup.exe` (about 2 MB), or
- `msi/Minimal PDF_0.1.0_x64_en-US.msi`

When a release is published on the [Releases](https://github.com/mishbahul-hub/minimal-pdf/releases)
page, you can download the installer from there instead. Windows 10 and 11 already include
WebView2, which the app uses to draw its window. After installing, PDFs get an
"Open with Minimal PDF" option.

## Where your data lives

Everything the app saves is in `%APPDATA%\com.islam.minimalpdf\`:

- `settings.json`: theme, recent files, the last position in each file, annotation tool styles
- `notes-<id>.json`: the annotations for one PDF (the file's path is stored inside it)

Your PDF files are only ever read, never written.

## Development

**Prerequisites:** [Rust](https://rustup.rs), [Node.js](https://nodejs.org) LTS, and on Windows the
Microsoft C++ Build Tools ("Desktop development with C++").

```bash
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # build the installers
npx tsc --noEmit       # type-check
```

### Project structure

```
src/
  main.ts        start-up wiring (keys, settings, launch file)
  viewer.ts      loading, lazy page rendering, text layer, zoom, navigation
  keys.ts        the single keymap (the ? help is generated from it)
  overlays.ts    go-to-page box, help overlay, Esc handling
  settings.ts    theme, saved positions, recent files
  search.ts      text search and highlights
  outline.ts     table of contents sidebar
  annotate.ts    annotation tools, drawing, undo/redo, storage
  radial.ts      the right-click radial menu
  styles.css     all styles and themes
src-tauri/
  src/lib.rs     window sizing, launch file, single instance, recent-file access
  tauri.conf.json, capabilities/default.json
```

`CLAUDE.md` holds the detailed design notes and conventions.

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
