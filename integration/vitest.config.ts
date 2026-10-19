import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each file owns an isolated fork; native LiteSVM state is never shared between files.
    // Bound concurrency because crash suites also launch their own child processes.
    pool: "forks",
    maxWorkers: Math.min(4, availableParallelism()),
    fileParallelism: true,
    testTimeout: 30_000,
  },
});
