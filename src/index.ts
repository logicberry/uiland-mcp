#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runAuthCommand } from "./auth.js";
import { runDiscover } from "./discover.js";
import { createServer } from "./server.js";
import { rest } from "./supabase.js";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "auth") {
  await runAuthCommand(args);
} else if (cmd === "discover") {
  await runDiscover(args.includes("--schema"));
} else if (cmd === "probe") {
  // npm run probe -- "screenImages?select=id,url&limit=2"
  if (!args[0]) {
    console.error('Usage: npm run probe -- "table?select=...&limit=2"');
    process.exit(1);
  }
  const [table, query = ""] = args[0].split("?");
  const { data, count } = await rest(table, Object.fromEntries(new URLSearchParams(query)), { count: true });
  console.log(JSON.stringify(data, null, 2).slice(0, 6000));
  if (count !== undefined) console.log(`\ntotal rows: ${count}`);
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("uiland-mcp running on stdio");
}
