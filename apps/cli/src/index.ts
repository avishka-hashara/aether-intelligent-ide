import * as path from "node:path";
import * as crypto from "node:crypto";
import { Command } from "commander";
import chalk from "chalk";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { ToolRegistry, toolSchemas } from "@aether/tools";
import { OpenRouterClient } from "@aether/providers";
import { BudgetTracker, runAgentLoop } from "@aether/agent-core";
import { initDB, workspaces, missions, missionEvents } from "./db/index.js";

// Load environment variables (.env)
dotenv.config();

const DEFAULT_SYSTEM_PROMPT = `You are Aether, an expert autonomous software engineer.
You are running in headless CLI mode on a real repository.
You have access to filesystem tools (fs.read, fs.list, fs.glob, fs.patch), search tools (search.grep), and terminal execution (terminal.exec).
Execute the user's goal with precision. Always inspect the codebase, plan your changes, make minimal and safe modifications, and verify your results before completing the mission.`;

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("aether")
    .description("Aether Intelligent IDE - Headless CLI")
    .version("1.0.0");

  program
    .command("run <goal>")
    .description("Execute an autonomous agent mission against a repository")
    .option("-r, --repo <path>", "Path to target repository workspace", process.cwd())
    .option("-m, --model <model>", "OpenRouter model name", "anthropic/claude-3.5-sonnet")
    .option("--max-usd <usd>", "Maximum USD budget limit", "2.0")
    .option("--max-tokens <tokens>", "Maximum total tokens allowed", "500000")
    .option("--max-wall-clock-ms <ms>", "Maximum wall-clock execution time in ms", "1800000")
    .option("--max-tool-calls <count>", "Maximum number of tool executions allowed", "100")
    .action(async (goal: string, options: {
      repo: string;
      model: string;
      maxUsd: string;
      maxTokens: string;
      maxWallClockMs: string;
      maxToolCalls: string;
    }) => {
      // 1. Parse process.env.OPENROUTER_API_KEY
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        console.error(
          chalk.red(
            "\n[Aether CLI Error] OPENROUTER_API_KEY environment variable is missing.\nPlease define OPENROUTER_API_KEY in your environment or a .env file.\n"
          )
        );
        process.exit(1);
      }

      // 2. Resolve absolute path of --repo
      const repoPath = path.resolve(options.repo);

      console.log(chalk.bold.cyan("\n========================================================"));
      console.log(chalk.bold.cyan("                AETHER HEADLESS CLI                     "));
      console.log(chalk.bold.cyan("========================================================"));
      console.log(chalk.dim(`Repository : `) + chalk.white(repoPath));
      console.log(chalk.dim(`Goal       : `) + chalk.yellow(goal));
      console.log(chalk.dim(`Model      : `) + chalk.blue(options.model));

      // 3. Initialize SQLite DB and create mission record
      const { db } = initDB(repoPath);

      const budget = {
        maxUsd: parseFloat(options.maxUsd) || 2.0,
        maxTokens: parseInt(options.maxTokens, 10) || 500000,
        maxWallClockMs: parseInt(options.maxWallClockMs, 10) || 1800000,
        maxToolCalls: parseInt(options.maxToolCalls, 10) || 100,
      };

      const now = new Date().toISOString();
      const missionId = `m_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

      // Ensure workspace record exists
      try {
        db.insert(workspaces)
          .values({
            id: repoPath,
            rootPath: repoPath,
            name: path.basename(repoPath),
            createdAt: now,
          })
          .onConflictDoNothing()
          .run();
      } catch {
        // Table might already have workspace
      }

      // Create new mission record with status: executing
      db.insert(missions)
        .values({
          id: missionId,
          workspaceId: repoPath,
          goal,
          surface: "cli",
          executionMode: "autonomous",
          status: "executing",
          isolation: "inplace",
          policyProfile: "trusted",
          budgetJson: JSON.stringify(budget),
          spendUsd: 0,
          tokensUsed: 0,
          blackboardJson: "{}",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      console.log(chalk.dim(`Mission ID : `) + chalk.green(missionId));
      console.log(chalk.bold.cyan("--------------------------------------------------------\n"));

      // 4. Instantiate ToolRegistry locked to repo path
      const toolsRegistry = new ToolRegistry(repoPath);

      // 5. Instantiate OpenRouterClient and BudgetTracker
      const provider = new OpenRouterClient(apiKey);
      const tracker = new BudgetTracker(budget);

      let finalStatus: "completed" | "failed" = "completed";

      try {
        // 6. Start runAgentLoop and consume events
        const loop = runAgentLoop({
          provider,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          initialUserPrompt: goal,
          toolSchemas,
          tracker,
          toolsRegistry,
          model: options.model,
          missionId,
        });

        for await (const event of loop) {
          // Persistence: Insert EVERY yielded event into mission_events table
          try {
            db.insert(missionEvents)
              .values({
                id: event.id,
                missionId: event.missionId,
                runId: event.runId ?? null,
                turnId: event.turnId ?? null,
                type: event.type,
                payloadJson: JSON.stringify(event.payload),
                ts: event.ts,
              })
              .run();
          } catch (persistErr) {
            console.error(chalk.red(`Failed to persist mission event: ${persistErr}`));
          }

          // Console Output: Render live turn log using chalk
          const payload = event.payload as any;

          switch (event.type) {
            case "turn.started":
              console.log(chalk.cyan(`\n>>> Turn started [${payload.turnId}] (${payload.model || options.model})`));
              break;

            case "turn.text_delta":
              process.stdout.write(chalk.green(payload.text));
              break;

            case "turn.reasoning_delta":
              process.stdout.write(chalk.gray(payload.text));
              break;

            case "turn.usage":
              console.log(
                chalk.dim(
                  `\n[usage] prompt=${payload.promptTokens} completion=${payload.completionTokens} totalSpend=$${tracker.currentUsd.toFixed(4)}`
                )
              );
              break;

            case "tool.started":
              console.log(
                chalk.yellow(
                  `\n⚡ Tool execution: [${payload.name}] args: ${typeof payload.args === "string" ? payload.args : JSON.stringify(payload.args)}`
                )
              );
              break;

            case "tool.finished":
              if (payload.ok) {
                console.log(
                  chalk.yellow(
                    `✔ Tool [${payload.name}] finished in ${payload.durationMs ?? 0}ms`
                  )
                );
              } else {
                console.log(
                  chalk.red(
                    `✖ Tool [${payload.name}] failed: ${payload.error?.message ?? JSON.stringify(payload.error)}`
                  )
                );
              }
              break;

            case "turn.loop_detected":
              console.log(
                chalk.magenta.bold(
                  `\n⚠️ Repetition Loop Detected: Tool [${payload.toolName}] repeated 3 times. Forcing replan.`
                )
              );
              break;

            case "turn.error":
              console.log(chalk.red(`\n[turn error] ${payload.message}`));
              break;

            case "run.finished":
              console.log(chalk.bold.green("\n\n========================================================"));
              console.log(chalk.bold.green("                MISSION COMPLETED SUCCESSFULLY          "));
              console.log(chalk.bold.green("========================================================"));
              finalStatus = "completed";
              break;

            case "run.failed":
              console.log(chalk.bold.red("\n\n========================================================"));
              console.log(chalk.bold.red(`                MISSION FAILED: ${payload.message || payload.error || "Unknown"}`));
              console.log(chalk.bold.red("========================================================"));
              finalStatus = "failed";
              break;

            case "run.aborted":
              console.log(chalk.bold.yellow("\n\n========================================================"));
              console.log(chalk.bold.yellow("                MISSION ABORTED                         "));
              console.log(chalk.bold.yellow("========================================================"));
              finalStatus = "failed";
              break;
          }
        }
      } catch (loopErr: any) {
        finalStatus = "failed";
        console.error(chalk.red(`\nAgent loop terminated with error: ${loopErr?.message || loopErr}`));
      } finally {
        // Update mission record on completion
        const completedAt = new Date().toISOString();
        db.update(missions)
          .set({
            status: finalStatus,
            spendUsd: tracker.currentUsd,
            tokensUsed: tracker.currentTokens,
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(missions.id, missionId))
          .run();
      }
    });

  await program.parseAsync(argv);
}

// Auto-run if executed as script
if (process.argv[1] && (process.argv[1].endsWith("dist/index.js") || process.argv[1].endsWith("src/index.ts") || process.argv[1].includes("aether"))) {
  runCli().catch((err) => {
    console.error(chalk.red(`Fatal CLI error: ${err.message}`));
    process.exit(1);
  });
}
