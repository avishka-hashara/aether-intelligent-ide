import { exec } from "node:child_process";
import { ToolResult } from "@aether/protocol";
import { resolveAndValidatePath } from "./security.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 120 seconds

export interface TerminalExecInput {
  command: string;
  rationale: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * terminal.exec: Runs a shell command inside workspaceRoot with timeout.
 */
export async function execCommand(
  workspaceRoot: string,
  input: TerminalExecInput
): Promise<ToolResult> {
  const startTime = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    if (!input.command || !input.command.trim()) {
      return {
        ok: false,
        error: {
          code: "INVALID_COMMAND",
          message: "Command string must not be empty.",
          recovery: "Provide a valid shell command.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const workingDir = resolveAndValidatePath(
      workspaceRoot,
      input.cwd ?? "."
    );

    return await new Promise<ToolResult>((resolve) => {
      exec(
        input.command,
        {
          cwd: workingDir,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          const stdoutStr = stdout?.toString() ?? "";
          const stderrStr = stderr?.toString() ?? "";

          if (error) {
            // Check if timed out
            if (error.killed || (error as any).signal === "SIGTERM") {
              return resolve({
                ok: false,
                result: {
                  stdout: stdoutStr,
                  stderr: stderrStr,
                  exitCode: null,
                  timedOut: true,
                },
                error: {
                  code: "TIMEOUT",
                  message: `Command timed out after ${timeoutMs}ms.`,
                  recovery:
                    "Increase timeoutMs or break the command into smaller sub-tasks.",
                },
                durationMs,
              });
            }

            const exitCode = typeof error.code === "number" ? error.code : 1;

            return resolve({
              ok: false,
              result: {
                stdout: stdoutStr,
                stderr: stderrStr,
                exitCode,
              },
              error: {
                code: "EXEC_ERROR",
                message: `Command failed with exit code ${exitCode}: ${error.message}`,
                recovery:
                  "Examine stderr output and adjust the command parameters or environment.",
              },
              durationMs,
            });
          }

          resolve({
            ok: true,
            result: {
              stdout: stdoutStr,
              stderr: stderrStr,
              exitCode: 0,
              rationale: input.rationale,
            },
            durationMs,
          });
        }
      );
    });
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "EXEC_SETUP_ERROR",
        message: err instanceof Error ? err.message : String(err),
        recovery: "Verify the working directory and command arguments.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}
