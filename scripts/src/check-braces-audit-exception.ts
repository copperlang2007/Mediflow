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
const expectedBracesPath = [
  "@workspace/api-server",
  "http-proxy-middleware@3.0.7",
  "micromatch@4.0.8",
  "braces@3.0.3",
];

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

function hasProperty(
  property: ts.ObjectLiteralElementLike,
  name: string,
): boolean {
  if (ts.isSpreadAssignment(property)) {
    return true;
  }
  if (
    ts.isPropertyAssignment(property) ||
    ts.isShorthandPropertyAssignment(property) ||
    ts.isMethodDeclaration(property)
  ) {
    const propertyName = ts.getNameOfDeclaration(property);
    if (
      !propertyName ||
      (!ts.isIdentifier(propertyName) && !ts.isStringLiteralLike(propertyName))
    ) {
      return true;
    }
    return propertyName.text === name;
  }
  return false;
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

async function checkNoGlobProxyFilters(): Promise<void> {
  const files = await listTypeScriptFiles(apiSourceDir);
  const errors: string[] = [];
  let proxyCalls = 0;

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
        proxyCalls++;
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) {
          errors.push(
            `${path.relative(repoRoot, file)}: proxy options must remain an inline object so the guard can verify them`,
          );
        } else if (
          options.properties.some((property) =>
            hasProperty(property, "pathFilter"),
          )
        ) {
          errors.push(
            `${path.relative(repoRoot, file)}: createProxyMiddleware must not use pathFilter while the braces advisory is ignored`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  if (proxyCalls !== 1) {
    errors.push(
      `Expected one createProxyMiddleware call in API source, found ${proxyCalls}`,
    );
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
  const actualPaths = bracesPaths.map((dependencyPath) =>
    dependencyPath.join(" > "),
  );
  const expectedPath = expectedBracesPath.join(" > ");
  if (actualPaths.length !== 1 || actualPaths[0] !== expectedPath) {
    throw new Error(
      [
        "The production path to the ignored braces advisory changed.",
        `Expected: ${expectedPath}`,
        `Found: ${actualPaths.length > 0 ? actualPaths.join("\n") : "(none)"}`,
        "Reassess the advisory and update or remove the exception before changing this guard.",
      ].join("\n"),
    );
  }
}

await checkNoGlobProxyFilters();
checkProductionDependencyPaths();
console.log("braces audit exception guard passed");
