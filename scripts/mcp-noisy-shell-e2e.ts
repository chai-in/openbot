import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect } from "effect";
import { usableMcpServer } from "../src/backend/mcp-provider-shapes";

// Command and login-PATH caches are process-owned. Each case needs a fresh process so the clean
// shell cannot hide a failure in the noisy shell, or the fake hide a real macOS zsh failure.
const shellCase = process.argv.find((arg) => arg.startsWith("--shell-case="))?.split("=")[1];
if (!shellCase) {
  const cases = process.platform === "darwin" ? ["fake", "zsh-clean", "zsh-noisy"] : ["fake"];
  for (const name of cases) {
    execFileSync(process.execPath, [import.meta.filename, `--shell-case=${name}`], { stdio: "inherit" });
  }
  await mkdir(".openbot-build", { recursive: true });
  await writeFile(".openbot-build/mcp-noisy-shell-e2e.json", JSON.stringify({ passed: true, cases }));
  process.exit(0);
}
assert.ok(["fake", "zsh-clean", "zsh-noisy"].includes(shellCase));

const root = await mkdtemp(join(tmpdir(), "openbot-mcp-shell-"));
try {
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npx"), "#!/bin/sh\nprintf 'fixture-started'\n", { mode: 0o755 });
  if (shellCase === "fake") {
    const shell = join(root, "zsh");
    await writeFile(shell, "#!/bin/sh\nprintf '\\033]1337;ShellIntegration\\007'\nexec /bin/sh -c \"$2\"\n", {
      mode: 0o755,
    });
    process.env.SHELL = shell;
  } else {
    process.env.SHELL = "/bin/zsh";
    process.env.ZDOTDIR = root;
    process.env.OPENBOT_TEST_MCP_BIN = bin;
    await writeFile(
      join(root, ".zprofile"),
      `export PATH="$OPENBOT_TEST_MCP_BIN:/usr/bin:/bin"\n${shellCase === "zsh-noisy" ? "printf '\\033]1337;ShellIntegration\\007'\n" : ""}`,
    );
  }
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  const result = await Effect.runPromise(
    usableMcpServer({
      id: "",
      name: "test",
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: "",
      headers: [],
    }),
  );
  assert.equal(result.command, join(bin, "npx"));
  assert.equal(result.path?.split(delimiter)[0], bin);
  assert.equal(execFileSync(result.command, { encoding: "utf8" }).trim(), "fixture-started");
  process.stdout.write(`PASS ${shellCase}: executable, PATH and process launch\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
