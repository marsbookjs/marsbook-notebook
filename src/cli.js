#!/usr/bin/env node

import path from "node:path";
import { exec } from "node:child_process";

import { startServer } from "./server.js";

/**
 * Opens the given URL in the default system browser.
 * Works on macOS, Windows, and Linux.
 */
function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === "darwin") {
    command = `open "${url}"`;
  } else if (platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      // Non-fatal: just print a hint so the user can open manually
      process.stdout.write(`  Tip: Open your browser at: ${url}\n`);
    }
  });
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    port: Number(process.env.PORT || 3113),
    openBrowser: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    // "start" is the primary subcommand — it is the default action, so just skip it
    if (arg === "start") {
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error("Missing value for --port");
      }
      options.port = Number(nextValue);
      index += 1;
      continue;
    }

    if (arg === "--workspace" || arg === "-w") {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error("Missing value for --workspace");
      }
      options.workspaceRoot = path.resolve(nextValue);
      index += 1;
      continue;
    }

    if (arg === "--no-open") {
      options.openBrowser = false;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      // Positional argument treated as workspace path
      options.workspaceRoot = path.resolve(arg);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("Port must be a positive number");
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "marsbook — local JavaScript/TypeScript notebook server",
      "",
      "Usage: marsbook start [options]",
      "",
      "Commands:",
      "  start             Start the notebook server and open the browser (default)",
      "",
      "Options:",
      "  -p, --port        Port to bind the server on (default: 3113)",
      "  -w, --workspace   Workspace directory — where your .ijsnb files live",
      "                    (default: current working directory)",
      "      --no-open     Skip opening the browser automatically",
      "  -h, --help        Show this help message",
      "",
      "Examples:",
      "  marsbook start",
      "  marsbook start --port 4000",
      "  marsbook start --workspace ~/my-notebooks",
      "  marsbook start --no-open"
    ].join("\n") + "\n"
  );
}


function printBanner(serverUrl, workspaceRoot) {
  // Colors
  const O  = "\x1b[38;5;208m";  // mars orange
  const OR = "\x1b[38;5;202m";  // dark orange / red-orange
  const R  = "\x1b[38;5;196m";  // red
  const W  = "\x1b[97m";        // bright white
  const G  = "\x1b[38;5;82m";   // green (for URL)
  const C  = "\x1b[38;5;117m";  // cyan (for workspace)
  const D  = "\x1b[2m";         // dim
  const B  = "\x1b[1m";         // bold
  const X  = "\x1b[0m";         // reset

  process.stdout.write("\n");

  // Mars planet ASCII art + title side by side
  process.stdout.write(`${OR}        .  .  .        ${X}   ${B}${O}███╗   ███╗ █████╗ ██████╗ ███████╗${X}\n`);
  process.stdout.write(`${OR}     . ${O}╭──────────╮${OR} .   ${X}   ${B}${O}████╗ ████║██╔══██╗██╔══██╗██╔════╝${X}\n`);
  process.stdout.write(`${OR}   .  ${O}│ ${R}●   ╭──╮${O}  │${OR}  .  ${X}   ${B}${O}██╔████╔██║███████║██████╔╝███████╗${X}\n`);
  process.stdout.write(`${OR}  .  ${O}│  ${R}╰──╯  ●${O}  │${OR}   . ${X}   ${B}${O}██║╚██╔╝██║██╔══██║██╔══██╗╚════██║${X}\n`);
  process.stdout.write(`${OR}   .  ${O}│  ${R}  ●   ${O}   │${OR}  .  ${X}   ${B}${O}██║ ╚═╝ ██║██║  ██║██║  ██║███████║${X}\n`);
  process.stdout.write(`${OR}     . ${O}╰──────────╯${OR} .   ${X}   ${B}${O}╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝${X}\n`);
  process.stdout.write(`${OR}        .  .  .        ${X}   ${D}${W}The JavaScript Notebook for Developers${X}\n`);

  process.stdout.write("\n");
  process.stdout.write(`${D}  🪐  ${B}${W}Server is running!${X}                \n`);
  process.stdout.write(`${D} \n`);
  process.stdout.write(`${D}  ${W}Local    ${X}  ${G}${serverUrl}${X}\n`);
  process.stdout.write(`${D}  ${W}Workspace${X}  ${C}${workspaceRoot}${X}\n`);
  process.stdout.write(`${D}  \n`);
  process.stdout.write(`${D}  ${D}Press Ctrl+C to stop the server${X}\n`);
  process.stdout.write("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const { host, port, workspaceRoot } = await startServer(options);
  const serverUrl = `http://${host}:${port}`;

  printBanner(serverUrl, workspaceRoot)

  if (options.openBrowser) {
    // Small delay so the server is fully ready before the browser connects
    setTimeout(() => openBrowser(serverUrl), 400);
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
