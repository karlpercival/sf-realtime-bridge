// /functions/index.js  (ESM)
// Registry of tools so server.js imports just one module.

import { searchWebTool, search_web } from "./search_web.js";

export const TOOL_DEFS = [searchWebTool];

const RUNNERS = {
  search_web,
};

export async function runTool(name, args) {
  const fn = RUNNERS[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return await fn(args || {});
}
