import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const proxy = spawn(node, ["scripts/wiki-proxy.mjs"], { cwd: root, stdio: "inherit" });
const wrangler = spawn(node, ["node_modules/wrangler/bin/wrangler.js", "dev"], {
  cwd: root,
  stdio: "inherit",
});

function shutdown(code) {
  proxy.kill("SIGTERM");
  wrangler.kill("SIGTERM");
  process.exit(code);
}

proxy.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});
wrangler.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
