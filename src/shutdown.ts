/** Cleanup hooks (e.g. session teardown) run on SIGINT/SIGTERM before exit. */
export const shutdownHooks: Array<() => void | Promise<void>> = [];
