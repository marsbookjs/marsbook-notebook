# MarsBook

> **A local JavaScript & TypeScript notebook — write code in the dark.**

MarsBook is a self-hosted, browser-based notebook environment for `.ijsnb` files. It gives you a Monaco-powered code editor, persistent Node.js execution sessions, AI assistance, rich output rendering, a built-in terminal, and full filesystem access — all running locally with zero cloud dependency.

No Python. No Jupyter. Just Node.

---

## Installation

### As a global CLI tool (recommended)

```bash
npm install -g marsbook
marsbook
```

## Usage

```bash
# Start in the current directory
marsbook

# Start with a specific workspace folder
marsbook /path/to/my/notebooks

# Custom port
marsbook --port 4000

# Workspace flag
marsbook --workspace /path/to/notebooks --port 3200

# Skip auto-opening the browser
marsbook --no-open

# Show help
marsbook --help
```

Then open **[http://127.0.0.1:3113](http://127.0.0.1:3113)** in your browser.

---

## Features

### Editor

**Monaco Editor** powers every cell — the same editor that runs VS Code, with full syntax highlighting, IntelliSense, multi-cursor support, and semantic token coloring.

**TypeScript & JavaScript** are both fully supported. TypeScript is transpiled on the fly using the TypeScript compiler; interfaces, enums, generics, and type assertions all work out of the box. You can switch the language per cell.

**Markdown cells** let you write documentation alongside your code with live rendered preview.

**Auto-formatter** — Prettier runs automatically on save, keeping your code clean without moving the cursor.

**Font & theme customization** — choose your coding font (Chivo Mono, JetBrains Mono, Chivo, or the system default) and adjust font size (10–20px). Six custom themes are available: three light (Champa, Varuna, Haritha) and three dark (Obsidian, Antariksha, Vriksha).

### Execution

**Persistent sessions** — each notebook gets its own long-lived Node.js VM runtime. Variables, imports, and state all carry across cells for the entire session.

**Shared cell state** — values defined in one cell are immediately available in all subsequent cells.

**Const protection** — `const` declarations are guarded across cells; bare reassignments throw a `TypeError`, just like you'd expect.

**TypeScript support** — interfaces, enums, generics, and type assertions all work out of the box.

**ES Module imports** — use the standard `import` syntax directly in cells:

```js
import { readFile } from "node:fs/promises";
import chalk from "chalk";
```

**Execution count** — each cell tracks how many times it has been run.

**Cancel execution** — stop a running cell mid-execution at any time.

**`setTimeout` / `setInterval` auto-cleanup** — pending timers are auto-cancelled after 10 seconds if a cell finishes without clearing them, with a visible warning.

### Inline User Input

`prompt()` and `input()` are available in cells. They pause execution and render a Jupyter-style inline input widget directly in the cell output — no blocking browser modal:

```js
const name = await prompt("What's your name? ");
console.log(`Hello, ${name}!`);

// or without explicit await (auto-injected):
const age = prompt("Your age: ");
```

### Rich Output

The `display` API renders structured output directly in notebook cells:

```js
// Method style
display.text("Hello, world!");
display.markdown("## Hello *markdown*");
display.html("<b>Bold HTML</b>");
display.image("https://example.com/chart.png");
display.table([{ name: "Alice", score: 95 }, { name: "Bob", score: 88 }]);
display.chart({ type: "bar", data: { labels: ["A","B"], datasets: [{ data: [10,20] }] } });

// Object style (equivalent)
display({ type: "html", html: "<b>Bold HTML</b>" });
```

`console.log`, `console.warn`, `console.error`, `console.info`, and `console.table` are all captured and rendered inline.

### AI Features

**AI Assistant chat** — a built-in chat panel powered by Groq (LLaMA & OpenAI models); aware of your current cell as context.

**AI Prompt cells** — a special cell type that sends a prompt to an LLM and streams the response inline; supports custom system prompts, model selection, and temperature per cell.

**AI code suggestions** — inline completions and hints while editing in any code cell.

**Live model list** — fetches available models from Groq at runtime; falls back to a curated default list when offline.

To enable AI features, set your `GROQ_API_KEY` environment variable before starting MarsBook.

### Built-in Terminal

A persistent shell terminal is built into the UI. Run any shell command — `ls`, `git`, `node`, `npm` — directly from the notebook interface. The terminal tracks your working directory across `cd` commands and automatically refreshes IntelliSense after `npm install` or `npm uninstall`.

### File & Package Management

**File explorer** — browse your workspace with VS Code-style folder chevrons (▶ / ▼). Supports opening notebooks, viewing images, editing text/JS/TS files, and previewing PDFs.

**Workspace file editor** — open any `.js` or `.ts` file in the workspace directly in a Monaco editor tab, edit it, and run it in the terminal without leaving MarsBook.


**`npm install` from the UI** — install packages directly from within the notebook; newly installed packages are importable immediately without a server restart.

**Workspace statistics** — see notebook counts, total file sizes, cell execution counts, AI token usage, and more at a glance. Counters can be reset from the stats panel.

### Notebook Management

**Multiple notebooks** — open and switch between `.ijsnb` files in your workspace from the sidebar.

**Cell operations** — add, delete, duplicate, and reorder cells with drag-and-drop.


**Auto-save on reorder** — silently saves when you drag cells up or down.

**Ctrl+S save** — preserves cursor position and selections across saves.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Shift + Enter` | Run cell and move to next |
| `Ctrl/Cmd + Enter` | Run current cell |
| `Ctrl/Cmd + S` | Save notebook |
| `Ctrl/Cmd + Shift + K` | Delete current cell |
| `?` | Toggle keyboard shortcuts overlay |

---

## The `.ijsnb` Format

Notebooks are stored as plain JSON files with the `.ijsnb` extension, making them easy to version-control and diff.

```json
{
  "format": "ijsnb",
  "version": 1,
  "metadata": {
    "title": "My Notebook",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-02T12:00:00.000Z",
    "env": {}
  },
  "cells": [
    {
      "id": "uuid-here",
      "type": "markdown",
      "source": "## Welcome\nThis is a markdown cell."
    },
    {
      "id": "uuid-here",
      "type": "code",
      "language": "typescript",
      "source": "const greeting: string = 'Hello!';\ngreeting;",
      "executionCount": 1,
      "outputs": []
    }
  ]
}
```

### Cell types

`code` — JavaScript or TypeScript (set `language: "javascript"` or `"typescript"`).

`markdown` — Markdown source with live rendered preview.

`prompt` — AI prompt cell; sends content to a configured LLM and streams the response inline. Supports per-cell model, system prompt, and temperature settings.

---

## Environment Variables

| Variable | Description |
|---|---|
| `GROQ_API_KEY` | Enables AI assistant, AI prompt cells, and inline completions |
| `PORT` | Override the default port (3113) |
| `HOST` | Override the default host (127.0.0.1) |

You can also set per-notebook environment variables in the notebook's **Env** settings panel — these are saved inside the `.ijsnb` file and injected into the kernel at runtime.
---
## Requirements

- **Node.js** >= 20
- A modern browser (Chrome, Edge, Firefox, Safari)
- (Optional) A **Groq API key** for AI features — get one free at [console.groq.com](https://console.groq.com)

---

## License

MIT
