import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolves to the package root's package.json from both src/ (dev) and dist/ (published).
const pkg = require("../package.json") as { version: string };

/** Package version, read once at startup. Feeds X-TF-Client-Version upstream. */
export const VERSION: string = pkg.version;
