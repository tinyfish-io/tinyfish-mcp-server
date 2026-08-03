/** Phase 3 registers session cleanup here; hooks run on SIGINT/SIGTERM before exit. */
export const shutdownHooks: Array<() => void | Promise<void>> = [];
