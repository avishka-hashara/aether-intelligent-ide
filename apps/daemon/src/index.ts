import dotenv from "dotenv";
import { generateToken, writeDaemonInfo, deleteDaemonInfo, getDaemonInfoPath } from "./auth.js";
import { createDaemonServer } from "./server.js";

// Load environment variables (.env)
dotenv.config();

export * from "./auth.js";
export * from "./server.js";

export async function startDaemon(): Promise<{
  server: any;
  port: number;
  token: string;
  daemonInfoPath: string;
}> {
  const token = generateToken(32);
  const { server } = createDaemonServer({ token });

  // Cleanup on process shutdown
  let isShuttingDown = false;
  const cleanup = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    deleteDaemonInfo();
    try {
      await server.close();
    } catch {
      // Ignored
    }
  };

  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  process.once("exit", () => {
    deleteDaemonInfo();
  });

  // Bind strictly to loopback interface on port 0 (OS chooses free port)
  await server.listen({ host: "127.0.0.1", port: 0 });

  const addr = server.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const daemonInfoPath = writeDaemonInfo(port, token);

  console.log(`[Aether Daemon] Server listening on http://127.0.0.1:${port}`);
  console.log(`[Aether Daemon] Connection metadata written to ${daemonInfoPath}`);

  return {
    server,
    port,
    token,
    daemonInfoPath,
  };
}

// Auto-run if executed directly as entrypoint
const isDirectRun = Boolean(
  process.argv[1] &&
  !process.argv[1].includes("vitest") &&
  (
    process.argv[1].endsWith("apps/daemon/dist/index.js") ||
    process.argv[1].endsWith("apps\\daemon\\dist\\index.js") ||
    process.argv[1].endsWith("apps/daemon/src/index.ts") ||
    process.argv[1].endsWith("apps\\daemon\\src\\index.ts")
  )
);

if (isDirectRun) {
  startDaemon().catch((err) => {
    console.error("[Aether Daemon] Fatal startup failure:", err);
    deleteDaemonInfo();
    process.exit(1);
  });
}
