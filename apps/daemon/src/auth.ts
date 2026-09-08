import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
}

/**
 * Returns the path to ~/.aether/daemon.json
 */
export function getDaemonInfoPath(): string {
  return path.join(os.homedir(), ".aether", "daemon.json");
}

/**
 * Generates a cryptographically secure random token.
 */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Writes daemon connection metadata to ~/.aether/daemon.json with strict permissions (0600).
 */
export function writeDaemonInfo(port: number, token: string): string {
  const aetherDir = path.join(os.homedir(), ".aether");
  const daemonJsonPath = path.join(aetherDir, "daemon.json");

  // Ensure ~/.aether directory exists with mode 0700
  if (!fs.existsSync(aetherDir)) {
    fs.mkdirSync(aetherDir, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(aetherDir, 0o700);
    } catch {
      // Ignored on platforms not supporting POSIX permissions
    }
  }

  const payload: DaemonInfo = {
    port,
    token,
    pid: process.pid,
  };

  // Write file with strict 0600 mode (read/write by owner only)
  fs.writeFileSync(daemonJsonPath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });

  try {
    fs.chmodSync(daemonJsonPath, 0o600);
  } catch {
    // Ignored on platforms not supporting POSIX permissions
  }

  return daemonJsonPath;
}

/**
 * Removes ~/.aether/daemon.json on daemon exit.
 */
export function deleteDaemonInfo(): void {
  const daemonJsonPath = getDaemonInfoPath();
  try {
    if (fs.existsSync(daemonJsonPath)) {
      fs.unlinkSync(daemonJsonPath);
    }
  } catch {
    // Ignore deletion errors during shutdown
  }
}

/**
 * Creates a Fastify preHandler hook validating Authorization: Bearer <token>.
 */
export function createAuthPreHandler(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.status(401).send({
        error: "Unauthorized",
        message: "Missing Authorization header",
      });
      return;
    }

    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid Authorization header format. Expected 'Bearer <token>'",
      });
      return;
    }

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);

    if (
      tokenBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(tokenBuf, expectedBuf)
    ) {
      reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid authorization token",
      });
      return;
    }
  };
}
