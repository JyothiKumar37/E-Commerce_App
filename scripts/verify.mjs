#!/usr/bin/env node
/**
 * Structural checks that a linter cannot make.
 *
 * The failure mode these guard against is drift: someone adds a service and
 * forgets to list it in the Dockerfile, or in compose, or gives it a different
 * internal layout. Each of those breaks a build or a deploy long after the
 * commit that caused it, so they are asserted here and run in CI.
 *
 *   node scripts/verify.mjs
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const problems = [];
const notes = [];

const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);

const exists = async (path) => {
  try {
    await stat(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
};

const readJson = async (path) => JSON.parse(await readFile(join(ROOT, path), "utf8"));
const readText = async (path) => readFile(join(ROOT, path), "utf8");

/** Every workspace directory on disk, as repo-relative paths. */
async function discoverWorkspaces() {
  const found = [];
  for (const group of ["packages", "apps", "services"]) {
    if (!(await exists(group))) continue;
    for (const entry of await readdir(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${group}/${entry.name}`;
      if (await exists(`${path}/package.json`)) found.push(path);
    }
  }
  return found.sort();
}

/* ------------------------------------------------------------------ */

async function checkWorkspaceManifests(workspaces) {
  const root = await readJson("package.json");
  const globs = root.workspaces ?? [];

  for (const path of workspaces) {
    const group = path.split("/")[0];
    if (!globs.includes(`${group}/*`)) {
      fail(`root package.json workspaces is missing "${group}/*" (needed by ${path})`);
    }
  }

  for (const path of workspaces) {
    const pkg = await readJson(`${path}/package.json`);
    if (!pkg.name?.startsWith("@ecom/")) {
      fail(`${path}: package name "${pkg.name}" should be scoped @ecom/*`);
    }
    if (pkg.type !== "module") {
      fail(`${path}: "type" must be "module" (the codebase is ESM throughout)`);
    }
  }
}

/**
 * Every runnable service must expose the same four files, so that moving
 * between services requires no re-orientation.
 */
async function checkServiceLayout(workspaces) {
  const runnable = workspaces.filter((p) => p.startsWith("services/") || p === "apps/api-gateway");

  for (const path of runnable) {
    for (const file of ["src/index.js", "src/app.js", "src/routes.js", "src/config.js"]) {
      if (!(await exists(`${path}/${file}`))) fail(`${path}: missing ${file}`);
    }

    const pkg = await readJson(`${path}/package.json`);
    if (pkg.main !== "src/index.js") {
      fail(`${path}: "main" should be "src/index.js", found "${pkg.main}"`);
    }
    if (pkg.scripts?.start !== "node src/index.js") {
      fail(`${path}: "start" should be "node src/index.js", found "${pkg.scripts?.start}"`);
    }

    // app.js must stay side-effect free so tests can construct it offline.
    const app = await readText(`${path}/src/app.js`);
    if (/^\s*await\s/m.test(app)) {
      fail(`${path}/src/app.js: top-level await belongs in index.js, not app.js`);
    }
    if (!/export function buildApp/.test(app)) {
      fail(`${path}/src/app.js: must export a buildApp() function`);
    }
  }

  note(`${runnable.length} runnable services share the same layout`);
}

const NODE_IMAGE = "node:20.19-bookworm-slim";

/**
 * Each deployable owns a self-contained Dockerfile beside its code.
 *
 * "Self-contained" is the property worth protecting: `docker build -f
 * <service>/Dockerfile .` must work from a fresh clone with no prerequisite
 * image and no ordering to remember. A shared base image would remove a few
 * duplicated lines and cost that, which is a bad trade at this size.
 *
 * The price is thirteen near-identical files, and the original repository
 * proved how those drift — so their shape is asserted here instead.
 */
async function checkDockerfiles(workspaces) {
  const deployables = workspaces.filter((p) => p !== "packages/shared");
  let checked = 0;

  for (const path of deployables) {
    const dockerfile = `${path}/Dockerfile`;
    if (!(await exists(dockerfile))) {
      fail(`${path}: no Dockerfile — it cannot be built`);
      continue;
    }
    checked += 1;
    const content = await readText(dockerfile);
    // Comments explain what not to do and would otherwise trip the checks below.
    const instructions = content
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    // Its own manifest must be copied, or npm cannot resolve the workspace.
    if (!instructions.includes(`${path}/package.json`)) {
      fail(`${dockerfile}: does not COPY ${path}/package.json`);
    }
    if (!instructions.includes("COPY package.json package-lock.json")) {
      fail(`${dockerfile}: does not COPY the root manifest and lockfile`);
    }

    // The install must be scoped. A blanket `--workspaces` drags every other
    // service's dependencies — and the storefront's React tree — into the image.
    if (instructions.includes("npm ci") && /--workspaces(?!=)/.test(instructions)) {
      fail(`${dockerfile}: uses a blanket --workspaces; scope it with --workspace=${path}`);
    }

    // Nothing may depend on an image this repository has to build first.
    // Stages defined within the same file are fine — those are internal.
    const stages = new Set(
      [...instructions.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()),
    );
    for (const [, ref] of instructions.matchAll(/^FROM\s+(\S+)/gim)) {
      const isPublic = /^(node|nginx|alpine|debian|ubuntu|scratch|busybox)[:@]?/.test(ref);
      if (!isPublic && !stages.has(ref.toLowerCase())) {
        fail(
          `${dockerfile}: FROM ${ref} — images must be self-contained, so a fresh ` +
            "clone can build any service with no prerequisite image",
        );
      }
    }

    // The storefront ships behind nginx and shares none of the Node runtime.
    if (path === "apps/web") continue;

    if (!instructions.includes(`FROM ${NODE_IMAGE}`)) {
      fail(`${dockerfile}: should build on ${NODE_IMAGE}, pinned like every other service`);
    }
    if (!instructions.includes("packages/shared") && path !== "packages/database") {
      fail(`${dockerfile}: does not COPY packages/shared, which every service imports`);
    }
    if (!/^USER node$/m.test(instructions)) {
      fail(`${dockerfile}: does not drop privileges with USER node`);
    }
    if (!/^ENV NODE_ENV=production/m.test(instructions)) {
      fail(`${dockerfile}: runtime stage does not set NODE_ENV=production`);
    }
    if (!/^CMD \["node", "/m.test(instructions)) {
      fail(`${dockerfile}: CMD should be exec-form node, so SIGTERM reaches the process`);
    }
    // curl is not installed; a shell-form probe calling it would always fail.
    if (/HEALTHCHECK[\s\S]{0,200}?curl/.test(instructions)) {
      fail(`${dockerfile}: healthcheck uses curl, which is not in the image — use node -e fetch`);
    }
  }

  note(`${checked} deployables each own a self-contained Dockerfile`);
}

/** Every deployable must be wired into compose, with a healthcheck. */
async function checkCompose(workspaces) {
  if (!(await exists("docker-compose.yml"))) {
    fail("missing docker-compose.yml");
    return;
  }
  const compose = await readText("docker-compose.yml");

  for (const path of workspaces) {
    if (path === "packages/shared") continue; // a library, never deployed alone
    if (!compose.includes(`dockerfile: ${path}/Dockerfile`)) {
      fail(`docker-compose.yml: nothing builds ${path}/Dockerfile`);
    }
  }

  const buildCount = (compose.match(/dockerfile: /g) ?? []).length;
  const healthCount = (compose.match(/healthz/g) ?? []).length;
  if (healthCount < buildCount - 4) {
    fail(`docker-compose.yml: ${buildCount} builds but only ${healthCount} healthchecks`);
  }

  note(`compose builds ${buildCount} images`);
}

/** Relative imports must resolve; a bad path only fails at runtime otherwise. */
async function checkImports(workspaces) {
  let checked = 0;

  for (const workspace of [...workspaces, "packages/database"]) {
    const srcDir = (await exists(`${workspace}/src`)) ? `${workspace}/src` : workspace;
    for (const file of await walk(srcDir)) {
      if (!/\.(js|mjs)$/.test(file)) continue;
      const content = await readFile(file, "utf8");
      checked += 1;

      for (const match of content.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const target = resolve(dirname(file), match[1]);
        if (!(await pathExists(target))) {
          fail(`${file.replace(`${ROOT}/`, "")}: unresolved import "${match[1]}"`);
        }
      }
    }
  }

  note(`${checked} modules checked for unresolved relative imports`);
}

async function walk(relDir) {
  const out = [];
  const dir = join(ROOT, relDir);
  if (!(await exists(relDir))) return out;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(join(relDir, entry.name))));
    else out.push(full);
  }
  return out;
}

const pathExists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** A secret placeholder that survives into a real .env is a live incident. */
async function checkEnvTemplate() {
  if (!(await exists(".env.example"))) {
    fail("missing .env.example");
    return;
  }
  const template = await readText(".env.example");
  for (const key of ["JWT_SECRET", "INTERNAL_JWT_SECRET", "CORS_ORIGINS", "POSTGRES_PASSWORD"]) {
    if (!template.includes(key)) fail(`.env.example: missing ${key}`);
  }
  if (await exists(".env")) {
    const env = await readText(".env");
    if (env.includes("CHANGE_ME")) {
      fail(".env still contains a CHANGE_ME placeholder — generate real secrets");
    }
    const secrets = [...env.matchAll(/^(JWT_SECRET|INTERNAL_JWT_SECRET)=(.*)$/gm)];
    for (const [, key, value] of secrets) {
      if (value.trim().length < 32) fail(`.env: ${key} must be at least 32 characters`);
    }
    if (secrets.length === 2 && secrets[0][2] === secrets[1][2]) {
      fail(".env: JWT_SECRET and INTERNAL_JWT_SECRET must differ");
    }
  }
}

/* ------------------------------------------------------------------ */

const workspaces = await discoverWorkspaces();

await checkWorkspaceManifests(workspaces);
await checkServiceLayout(workspaces);
await checkDockerfiles(workspaces);
await checkCompose(workspaces);
await checkImports(workspaces);
await checkEnvTemplate();

console.log(`\nverify: ${workspaces.length} workspaces\n`);
for (const line of notes) console.log(`  ok    ${line}`);

if (problems.length > 0) {
  console.error("");
  for (const line of problems) console.error(`  FAIL  ${line}`);
  console.error(`\n${problems.length} problem(s) found.\n`);
  process.exit(1);
}

console.log("\nAll structural checks passed.\n");
