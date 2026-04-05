<div align="center">

```
  ██████╗  ██╗
 ██╔═══╝ ███╗     MarsBook
 ██║  ╔═╗╚██╗     JavaScript Notebook
 ██║  ╚═╝ ╚██╗
 ╚██████╗  ╚██╗
  ╚═════╝   ╚═╝
```

**A local JavaScript & TypeScript notebook — write code in the dark.**

[![npm](https://img.shields.io/npm/v/mars-notebook?color=orange&label=mars-notebook)](https://www.npmjs.com/package/mars-notebook)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

MarsBook is a **self-hosted, browser-based notebook** for `.ijsnb` files. Monaco editor, persistent Node.js sessions, AI assistance, a built-in terminal, and full filesystem access — all running **locally**, with zero cloud dependency.

> No Python. No Jupyter. Just Node.

---

## 🚀 Quick Start

```bash
npm install -g mars-notebook
marsbook
```

Open **http://127.0.0.1:3113** in your browser and start coding.

---

## 📦 Installation

### Global (recommended)
```bash
npm install -g mars-notebook
marsbook
```

### Local project
```bash
npm install mars-notebook
npx marsbook
```

### From source
```bash
git clone https://github.com/your-username/mars-notebook.git
cd mars-notebook
npm install
npm start
```

---

## 🖥️ Usage

```bash
marsbook                                   # Start in current directory
marsbook /path/to/my/notebooks             # Start with a specific workspace
marsbook --port 4000                       # Custom port
marsbook --workspace ~/notebooks -p 3200   # Workspace + port
marsbook --no-open                         # Skip auto-opening browser
marsbook --help                            # Show help
```

---

# ✨ Features

### 🎨 Editor

**Monaco Editor** — the same engine that powers VS Code. Full syntax highlighting, IntelliSense, multi-cursor editing, and semantic token coloring in every cell.

**TypeScript & JavaScript** — TypeScript is transpiled on the fly using the TypeScript compiler. Interfaces, enums, generics, and type assertions all work out of the box. Switch language per cell independently.

**Markdown cells** — write documentation and rich text right alongside your code, with live rendered preview.

**Auto-formatter** — Prettier runs automatically on save, keeping your code clean without moving the cursor.

**Fonts & themes** — choose from multiple fonts (Chivo Mono, JetBrains Mono, Chivo, or system default) and adjust font size (10–20px). Six hand-crafted themes included:

| Light Themes | Dark Themes |
|:---:|:---:|
| 🌤 Champa | 🌑 Obsidian |
| 🌊 Varuna | 🌌 Antariksha |
| 🌿 Haritha | 🌲 Vriksha |

---

### ⚡ Execution

**Persistent sessions** — each notebook runs in its own long-lived Node.js VM. Variables, imports, and state all carry across cells throughout the session.

**Shared cell state** — define something in one cell and use it in any cell below. No re-imports needed.

**ES Module imports** — use the standard `import` syntax directly in cells:

```js
import { readFile } from "node:fs/promises";
import chalk from "chalk";
```

**TypeScript, all the way down:**

```ts
interface User { name: string; age: number; }
const greet = (user: User): string => `Hello, ${user.name}!`;
greet({ name: "Prateek", age: 25 });
```

**Const protection** — `const` declarations are enforced across cells. Bare reassignments throw a `TypeError`, just like you'd expect.

**Execution count** — each cell tracks how many times it's been run.

**Cancel execution** — stop any running cell mid-execution instantly.

**`setTimeout` / `setInterval` auto-cleanup** — pending timers are auto-cancelled after 10 seconds if a cell finishes without clearing them, with a visible warning in the output.

---

### 💬 Inline User Input

`prompt()` and `input()` pause execution and show a Jupyter-style inline input widget — no blocking browser modal:

```js
const name = await prompt("What's your name? ");
console.log(`Hello, ${name}!`);

// Works without explicit await too (auto-injected):
const city = prompt("Your city: ");
```

---

### 🖨️ Rich Output

The `display` API renders structured output directly inside cells:

```js
display.text("Hello, world!");
display.markdown("## Hello *markdown*");
display.html("<b>Bold</b> <i>HTML</i>");
display.image("https://example.com/photo.png");
display.table([
  { name: "Alice", score: 95 },
  { name: "Bob",   score: 88 },
]);

// Object-style works too:
display({ type: "html", html: "<b>Bold HTML</b>" });
```

`console.log`, `console.warn`, `console.error`, `console.info`, and `console.table` are all captured and rendered inline with color-coded labels.


### 🤖 AI Features

MarsBook has AI built in — no external plugin needed.

**AI Assistant chat** — a sliding chat panel powered by [Groq](https://console.groq.com), context-aware of your current cell.

**AI Prompt cells** — a special cell type that sends a prompt to an LLM and streams the response inline. Each prompt cell has its own model, system prompt, and temperature.

**AI inline completions** — get code suggestions as you type in any code cell.

**Live model list** — fetches available LLaMA and OpenAI-compatible models from Groq at runtime. Falls back to a curated default list if offline.

To enable AI, set `GROQ_API_KEY` before starting:

```bash
export GROQ_API_KEY=your_key_here
marsbook
```

Get a free key at [console.groq.com](https://console.groq.com).

---

### 🖥️ Built-in Terminal

A persistent shell panel is built into the UI. Run any command — `ls`, `git`, `node`, `npm` — directly from the notebook interface.

- Tracks your working directory across `cd` commands
- Always starts at your **workspace root** (never jumps into a notebook's subfolder)
- Auto-refreshes package IntelliSense after `npm install` / `npm uninstall`

---

### 📁 File & Package Management

**File explorer** — browse your workspace with VS Code-style chevrons. Supports opening notebooks, viewing images, editing JS/TS files, and previewing PDFs — all without leaving the app.

**Workspace file editor** — open any `.js` or `.ts` file in a Monaco editor tab, edit and save it, then run it in the terminal without switching windows.

**`npm install` from the UI** — install packages from within a cell. Newly installed packages are importable immediately.

**Workspace statistics** — see notebook counts, total file sizes, cell execution counts, Total Number of Cells.

---

### 📓 Notebook Management

- **Multiple notebooks** — open and switch between `.ijsnb` files in the sidebar
- **Cell operations** — add, delete, duplicate, and reorder cells
- **Auto-save on reorder** — silently saves when cells are dragged
- **`Ctrl+S` save** — preserves cursor position and selection across saves

---

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Shift + Enter` | Run cell and move to next |
| `Ctrl / Cmd + S` | Save notebook |
| `Ctrl / Cmd + Shift + K` | Delete current cell |


---

### Cell Types

| Type | Description |
|---|---|
| `code` | JavaScript or TypeScript (`language: "javascript"` or `"typescript"`) |
| `markdown` | Markdown source with live rendered preview |
| `prompt` | AI prompt cell — streams LLM response inline, with per-cell model, system prompt, and temperature |

---

## 🌍 Environment Variables

| Variable | Description |
|---|---|
| `GROQ_API_KEY` | Enables AI assistant, AI prompt cells, and inline completions |
| `PORT` | Override the default port (`3113`) |
| `HOST` | Override the default host (`127.0.0.1`) |

You can also set **per-notebook environment variables** in the notebook's Env settings panel — saved inside the `.ijsnb` file and injected into the kernel at runtime.

---

## 🔧 Requirements

- **Node.js** ≥ 20
- A modern browser (Chrome, Edge, Firefox, Safari)
- *(Optional)* A **Groq API key** for AI features — free at [console.groq.com](https://console.groq.com)

---

## 📜 License

MIT — use it, fork it, ship it.
