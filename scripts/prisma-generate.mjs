import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = path.join(root, "packages", "database");
const maxAttempts = 5;

function runGenerate() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "prisma", "generate"], {
      cwd: dbDir,
      shell: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma generate exited with code ${code}`));
    });
  });
}

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    await runGenerate();
    process.exit(0);
  } catch (err) {
    const isLast = attempt === maxAttempts;
    if (isLast) {
      console.error("\nprisma generate failed after", maxAttempts, "attempts.");
      console.error(
        "On Windows this is often EPERM: stop `pnpm dev`, API/worker, and Prisma Studio, then run `pnpm build` again.",
      );
      console.error(err?.message ?? err);
      process.exit(1);
    }
    const waitMs = attempt * 2000;
    console.warn(
      `\nprisma generate attempt ${attempt} failed — retrying in ${waitMs / 1000}s...`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
}
