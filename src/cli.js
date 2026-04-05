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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const { host, port, workspaceRoot } = await startServer(options);
  const serverUrl = `http://${host}:${port}`;

  const P = "\x1b[35m"; // purple
  const V = "\x1b[95m"; // bright purple / violet
  const W = "\x1b[97m"; // bright white
  const B = "\x1b[1m";  // bold
  const R = "\x1b[0m";  // reset
  process.stdout.write("\n");
  process.stdout.write(`${P}  ██████╗ ${V} ██╗    ${R}  ${B}${W}MarsBook${R}\n`);
  process.stdout.write(`${P} ██╔═══╝ ${V}███╗   ${R}  ${W}Write code in the dark${R}\n`);
  process.stdout.write(`${P} ██║  ╔═╗${V}╚██╗  ${R}\n`);
  process.stdout.write(`${P} ██║  ╚═╝${V} ╚██╗ ${R}  ${W}Server is running!${R}\n`);
  process.stdout.write(`${P} ╚██████╗${V}  ╚██╗${R}\n`);
  process.stdout.write(`${P}  ╚═════╝${V}   ╚═╝${R}\n`);
  process.stdout.write("\n");
  process.stdout.write(`  Local:     ${serverUrl}\n`);
  process.stdout.write(`  Workspace: ${workspaceRoot}\n`);
  process.stdout.write("\n");
  process.stdout.write("  Press Ctrl+C to stop the server.\n");
  process.stdout.write("\n");

  if (options.openBrowser) {
    // Small delay so the server is fully ready before the browser connects
    setTimeout(() => openBrowser(serverUrl), 400);
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
