import { scaffold } from "./_scaffold-helper";

export const EXECUTE_COMMAND = scaffold(
	"execute_command",
	"Execute a shell command on the user's system and return the output.",
	"write",
	`params:
  command:
    type: string
    description: "Shell command to execute."
  working_directory:
    type: string
    description: "Working directory for the command, relative to vault root or absolute."
    default: ""
    path_namespace: filesystem
settings:
  execute_command_allowed_paths:
    name: "Allowed Working Directories"
    type: string[]
    description: "Additional filesystem paths allowed as working directories. The vault root is always allowed."
    default: []
  execute_command_timeout:
    name: "Command Timeout (seconds)"
    type: number
    description: "Maximum execution time in seconds before the command is killed."
    default: 30
    min: 1
    max: 600
  execute_command_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters of command output returned. Longer output is truncated."
    default: 50000
    min: 1000
    max: 500000
  execute_command_allowed_command_patterns:
    name: "Auto-Approve Command Patterns"
    type: string[]
    description: "Glob patterns for commands to auto-approve (e.g., 'git *', 'ls', 'npm test'). Matched commands skip the approval prompt."
    default: []
  execute_command_blocked_command_patterns:
    name: "Never Auto-Approve Command Patterns"
    type: string[]
    description: "Glob patterns for commands that ALWAYS require approval, even when execute_command is fully auto-approved (e.g., 'rm *', 'sudo *')."
    default: []`,
	`const log = utils.logger("execute_command");

if (!params.command || typeof params.command !== "string") {
  throw new Error("Missing required parameter: command");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error(
    "execute_command is only available on desktop. " +
    "Shell execution is not supported on mobile."
  );
}

const workingDirectory = (params.working_directory as string) || "";

// Validate working directory against vault root and allowed paths
const cwdResult = utils.resolveAndValidatePath(
  workingDirectory,
  settings.execute_command_allowed_paths as string[],
);
if (!cwdResult.valid) {
  throw new Error(
    \`Working directory '\${workingDirectory}' is outside the allowed paths. \` +
    \`Allowed: vault root and configured paths.\`
  );
}

// Verify the working directory exists before spawning, so a missing cwd
// surfaces a clear error instead of an ambiguous "Shell not found" ENOENT.
// Empty working_directory defaults to the vault root, which always exists.
if (workingDirectory) {
  let cwdStat;
  try {
    cwdStat = await libs.fs.promises.stat(cwdResult.resolvedPath);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(
        \`Working directory '\${workingDirectory}' does not exist. \` +
        \`Provide an existing directory path (relative to the vault root or absolute).\`
      );
    }
    throw e;
  }
  if (!cwdStat.isDirectory()) {
    throw new Error(\`Working directory '\${workingDirectory}' is not a directory.\`);
  }
}

log.info("Executing command", {
  command: (params.command as string).substring(0, 200),
  cwd: cwdResult.resolvedPath,
  timeout: \`\${settings.execute_command_timeout}s\`,
});

try {
  const result = await utils.executeShellCommand(params.command as string, {
    cwd: cwdResult.resolvedPath,
    timeoutSeconds: settings.execute_command_timeout as number,
    maxOutputChars: settings.execute_command_max_output_chars as number,
    spiller: utils.tempOutputSpiller,
  });

  let output = result.stdout;

  if (result.truncated && result.spillFilePath && result.totalOutputChars) {
    output = utils.tempOutputSpiller!.formatSpilloverMessage(
      result.stdout,
      result.spillFilePath,
      result.totalOutputChars,
      settings.execute_command_max_output_chars as number,
    );
  } else if (result.truncated) {
    output +=
      \`\\n\\nNote: command output was truncated at \` +
      \`\${(settings.execute_command_max_output_chars as number).toLocaleString()} characters.\`;
  }

  if (result.timedOut) {
    const msg = \`Command timed out after \${settings.execute_command_timeout} seconds.\`;
    throw new Error(output ? \`\${msg} Partial output:\\n\${output}\` : msg);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      \`Command exited with code \${result.exitCode}\` +
      (output ? \`\\n\${output}\` : "")
    );
  }

  return output;
} catch (e: any) {
  // Re-throw errors already created above (and the precise working-directory
  // errors) so they keep their actionable message and never get the
  // shell-config hint appended below.
  if (e instanceof Error && (
    e.message.includes("timed out") ||
    e.message.includes("exited with code") ||
    e.message.includes("Working directory")
  )) {
    throw e;
  }

  const message = e instanceof Error ? e.message : String(e);
  log.error("Command execution failed", {
    command: (params.command as string).substring(0, 200),
    error: message,
  });

  if (message.includes("Shell not found")) {
    throw new Error(\`\${message}. Check your shell configuration in Settings → Notor.\`);
  }

  throw new Error(\`Failed to execute command: \${message}\`);
}`,
);
