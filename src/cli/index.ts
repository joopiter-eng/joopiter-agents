#!/usr/bin/env node

import { createTUI } from "../tui/index.js";

async function main() {
  const args = process.argv.slice(2);
  const workingDirectory = process.cwd();

  // Parse arguments
  const initialPrompt = args.length > 0 && args[0] !== "--help"
    ? args.join(" ")
    : undefined;

  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Deep Agent CLI");
    console.log("");
    console.log("Usage:");
    console.log("  deep-agent              Start interactive REPL");
    console.log("  deep-agent <prompt>     Run a one-shot prompt");
    console.log("");
    console.log("Examples:");
    console.log('  deep-agent "Explain the structure of this codebase"');
    console.log('  deep-agent "Add a new endpoint to handle user authentication"');
    console.log("");
    console.log("Keyboard shortcuts:");
    console.log("  esc           Abort current operation / exit");
    console.log("  ctrl+c        Force exit");
    console.log("  shift+tab     Cycle auto-accept mode");
    console.log("  ctrl+r        Expand tool output (when available)");
    process.exit(0);
  }

  try {
    await createTUI({
      initialPrompt,
      workingDirectory,
      header: {
        name: "Open Claude Code",
        version: "0.1.0",
      },
    });
  } catch (error) {
    // Ignore abort errors from ESC key interrupts
    if (error instanceof Error && error.name === "AbortError") {
      return;
    }
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
