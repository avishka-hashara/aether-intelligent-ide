import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Checks whether child is contained within parent directory.
 */
function isSubpath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    return true;
  }

  if (process.platform === "win32") {
    const parentLower = parent.toLowerCase();
    const childLower = child.toLowerCase();
    const relLower = path.relative(parentLower, childLower);
    return relLower === "" || (!relLower.startsWith("..") && !path.isAbsolute(relLower));
  }

  return false;
}

/**
 * Resolves targetPath relative to workspaceRoot and verifies that the canonical
 * path remains strictly inside workspaceRoot to prevent path traversal and symlink escapes.
 *
 * @param workspaceRoot - The absolute or relative root path of the workspace.
 * @param targetPath - The target file or directory path.
 * @returns The validated canonical absolute path.
 * @throws {Error} Descriptive error if targetPath resolves outside workspaceRoot.
 */
export function resolveAndValidatePath(
  workspaceRoot: string,
  targetPath: string
): string {
  if (!workspaceRoot) {
    throw new Error("Invalid workspaceRoot: path must not be empty.");
  }
  if (targetPath === undefined || targetPath === null) {
    throw new Error("Invalid targetPath: path must not be undefined or null.");
  }

  // Canonicalize workspace root
  const absoluteRoot = path.resolve(workspaceRoot);
  const realRoot = fs.existsSync(absoluteRoot)
    ? fs.realpathSync(absoluteRoot)
    : absoluteRoot;

  // Resolve target path against workspace root
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(realRoot, targetPath);

  // Lexical containment check
  if (!isSubpath(realRoot, resolvedTarget)) {
    throw new Error(
      `Path traversal denied: '${targetPath}' resolves outside workspace root '${workspaceRoot}' (resolved: '${resolvedTarget}')`
    );
  }

  // Symlink escape check via canonical realpath
  let realTarget: string;
  if (fs.existsSync(resolvedTarget)) {
    realTarget = fs.realpathSync(resolvedTarget);
  } else {
    // If target doesn't exist yet, check the closest existing ancestor directory
    let current = path.dirname(resolvedTarget);
    const pendingSegments: string[] = [path.basename(resolvedTarget)];

    while (!fs.existsSync(current) && current !== path.dirname(current)) {
      pendingSegments.unshift(path.basename(current));
      current = path.dirname(current);
    }

    const realAncestor = fs.existsSync(current) ? fs.realpathSync(current) : current;
    realTarget = path.resolve(realAncestor, ...pendingSegments);
  }

  if (!isSubpath(realRoot, realTarget)) {
    throw new Error(
      `Symlink escape denied: '${targetPath}' resolves outside workspace root '${workspaceRoot}' (real path: '${realTarget}')`
    );
  }

  return realTarget;
}
