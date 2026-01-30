import { spawn } from "node:child_process";

const INTERVAL_MS = Number(process.env.NEWS_REFRESH_MS || 3 * 60 * 1000);

function runBuildOnce() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["scripts/build-data.mjs"], {
      stdio: "inherit"
    });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
}

async function main() {
  // Start server
  const server = spawn(process.execPath, ["dev-server.js"], {
    stdio: "inherit"
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try {
      server.kill("SIGINT");
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Build immediately, then repeat.
  await runBuildOnce();
  // eslint-disable-next-line no-console
  console.log(`\n[dev:live] Rebuild every ${Math.round(INTERVAL_MS / 1000)}s\n`);

  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    if (stopping) return;
    await runBuildOnce();
  }
}

await main();
