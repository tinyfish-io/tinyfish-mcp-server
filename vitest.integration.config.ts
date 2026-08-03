import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    // Integration tests start the local proxy server in-process and hit the real
    // hosted upstream, so keep the runner on a single forked process (serial) for
    // deterministic behavior.
    pool: "forks",
    fileParallelism: false,
  },
});
