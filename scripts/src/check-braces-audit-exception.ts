import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const apiSourceDir = path.join(repoRoot, "artifacts", "api-server", "src");
/**
 * GHSA-vfj7-8cjw-p6xm (`braces`) is ignored in the audit (ADR 0007). Since the
 * move off Clerk (ADR 0006) the only remaining path is development tooling
 * (`mockup-sandbox > fast-glob`); the production API has no `braces` and no
 * proxy. This guard keeps it that way: any `braces` in the API's production
 * tree, or any `createProxyMiddleware` in API source, fails CI so the
 * exception is reassessed before it can cover production code again.
 */

interface Dependency {
  version: string;
  dependencies?: Record<string, Dependency>;
}

interface WorkspacePackage extends Dependency {
  name: string;
}

function getBracesPaths(
  dependency: Dependency,
  pathToDependency: string[],
): string[][] {
  const paths: string[][] = [];
  for (const [name, child] of Object.entries(dependency.dependencies ?? {})) {
    const childPath = [...pathToDependency, `${name}@${child.version}`];
    if (name === "braces") {
      paths.push(childPath);
    }
    paths.push(...getBracesPaths(child, childPath));
  }
  return paths;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function checkNoProxyMiddleware(): Promise<void> {
  const files = await listTypeScriptFiles(apiSourceDir);
  const errors: string[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createProxyMiddleware"
      ) {
        errors.push(
          `${path.relative(repoRoot, file)}: createProxyMiddleware is back in the API; reassess the ignored braces advisory (ADR 0007) first`,
        );
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function checkProductionDependencyPaths(): void {
  const output = execFileSync(
    "pnpm",
    [
      "--filter",
      "@workspace/api-server",
      "list",
      "--prod",
      "--depth",
      "Infinity",
      "--json",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const packages = JSON.parse(output) as WorkspacePackage[];
  const apiPackage = packages.find(
    (workspacePackage) => workspacePackage.name === "@workspace/api-server",
  );
  if (!apiPackage) {
    throw new Error(
      "pnpm did not return the @workspace/api-server dependency tree",
    );
  }

  const bracesPaths = getBracesPaths(apiPackage, [apiPackage.name]);
  if (bracesPaths.length > 0) {
    throw new Error(
      [
        "The production API depends on braces again, which the audit exception no longer covers:",
        ...bracesPaths.map((dependencyPath) => dependencyPath.join(" > ")),
        "Reassess the advisory (ADR 0007) and update or remove the exception before changing this guard.",
      ].join("\n"),
    );
  }
}

await checkNoProxyMiddleware();
checkProductionDependencyPaths();
console.log("braces audit exception guard passed");
