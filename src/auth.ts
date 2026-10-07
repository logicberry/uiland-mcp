// Stores your Uiland (Supabase) credentials locally at ~/.uiland-mcp/auth.json.
// They are only ever sent to api.uiland.design.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const AUTH_DIR = path.join(os.homedir(), ".uiland-mcp");
export const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

export interface AuthData {
  apikey: string; // Supabase anon key (public, same for everyone)
  accessToken?: string; // your logged-in JWT, expires about hourly
  refreshToken?: string; // lets the server renew accessToken by itself
  savedAt: string;
}

export function parseCurl(curl: string): Record<string, string> {
  const flat = curl.replace(/\\\r?\n/g, " ");
  const headers: Record<string, string> = {};
  for (const m of flat.matchAll(/(?:-H|--header)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g)) {
    const raw = m[1] ?? m[2] ?? "";
    const i = raw.indexOf(":");
    if (i > 0) headers[raw.slice(0, i).trim().toLowerCase()] = raw.slice(i + 1).trim();
  }
  // "Copy as fetch" format: "apikey": "value"
  for (const m of flat.matchAll(/"(apikey|authorization)"\s*:\s*"([^"]+)"/gi)) headers[m[1].toLowerCase()] ??= m[2];
  // Plain lines copied from the Headers tab: apikey: value  (or apikey <tab> value)
  for (const line of curl.split(/\r?\n/)) {
    const m = line.match(/^\s*(apikey|authorization)\s*[:\t ]\s*(.+?)\s*$/i);
    if (m) headers[m[1].toLowerCase()] ??= m[2].replace(/^['"]|['"]$/g, "");
  }
  return headers;
}

export function jwtExp(token?: string): number | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export function parseSession(input: string): { accessToken?: string; refreshToken?: string } {
  let s = input.replace(/\s+/g, "");
  if (!s) return {};
  if (s.startsWith("base64-")) s = Buffer.from(s.slice(7), "base64").toString("utf8");
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return { accessToken: j[0], refreshToken: j[1] };
    const sess = j.currentSession ?? j;
    return { accessToken: sess.access_token, refreshToken: sess.refresh_token };
  } catch {
    return { refreshToken: parseRefreshToken(input) };
  }
}

// Accepts a raw refresh token, the sb-...-auth-token JSON, or a "base64-..." cookie value.
export function parseRefreshToken(input: string): string | undefined {
  // Chunked cookies (.0, .1) may be pasted on separate lines: join them. Tokens contain no whitespace.
  let s = input.replace(/\s+/g, "");
  if (!s) return undefined;
  if (s.startsWith("base64-")) s = Buffer.from(s.slice(7), "base64").toString("utf8");
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j[1];
      return j.refresh_token ?? j.currentSession?.refresh_token;
    } catch {
      const m = s.match(/"refresh_token"\s*:\s*"([^"]+)"/);
      return m?.[1];
    }
  }
  return s.replace(/^"|"$/g, "");
}

export async function loadAuth(): Promise<AuthData | null> {
  try {
    return JSON.parse(await fs.readFile(AUTH_FILE, "utf8")) as AuthData;
  } catch {
    return null;
  }
}

export async function saveAuth(data: AuthData): Promise<void> {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function lineReader() {
  const rl = readline.createInterface({ input: process.stdin });
  const queue: string[] = [];
  const waiters: ((l: string) => void)[] = [];
  rl.on("line", (l) => (waiters.length ? waiters.shift()!(l) : queue.push(l)));
  const next = () => new Promise<string>((r) => (queue.length ? r(queue.shift()!) : waiters.push(r)));
  return { next, close: () => rl.close() };
}

export async function runAuthCommand(files: string[] = []): Promise<void> {
  // File mode avoids terminal paste issues: npm run auth -- curl.txt [token.txt]
  let curlText: string;
  let tokenText = "";
  if (files[0]) {
    curlText = await fs.readFile(files[0], "utf8");
    if (files[1]) tokenText = await fs.readFile(files[1], "utf8");
  } else {
    const r = lineReader();
    console.log("STEP 1: In DevTools, right-click any request to api.uiland.design");
    console.log("        > Copy > Copy as cURL (bash). Paste it and press Enter.");
    console.log("        (If nothing happens, press Enter once more.)\n");
    const lines: string[] = [];
    for (;;) {
      const l = (await r.next()).replace(/\r$/, "");
      if (l.trim() === "") {
        if (lines.length) break;
        continue;
      }
      lines.push(l);
      // A cURL command ends on the first line without a trailing backslash.
      if (lines.some((x) => /curl\s/.test(x)) && !l.trimEnd().endsWith("\\")) break;
    }
    console.log("\nSTEP 2 (recommended): paste your refresh token so the session renews itself.");
    console.log("        DevTools > Application > Local Storage (or Cookies) > uiland.design,");
    console.log("        key starting with sb- and ending in -auth-token. Paste its whole value, Enter.");
    console.log("        Press Enter on its own to skip.\n");
    tokenText = await r.next();
    r.close();
    curlText = lines.join("\n");
  }

  const h = parseCurl(curlText);
  if (!h.apikey) {
    const preview = curlText.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? "";
    console.error("\nNo apikey header found in what you gave me. It starts with:");
    console.error(`  ${preview}`);
    console.error("\nThat needs the request's headers, not just its URL. In DevTools, click a request to");
    console.error("api.uiland.design > right-click > Copy > Copy as cURL (bash). Or open its Headers tab and");
    console.error("copy the 'apikey' line from Request Headers into curl.txt.");
    process.exit(1);
  }
  const session = parseSession(tokenText);
  const bearer = h.authorization?.replace(/^Bearer\s+/i, "");
  const accessToken = (bearer && bearer !== h.apikey ? bearer : undefined) ?? session.accessToken;
  const refreshToken = session.refreshToken;

  await saveAuth({ apikey: h.apikey, accessToken, refreshToken, savedAt: new Date().toISOString() });
  const exp = jwtExp(accessToken);
  console.log(`\nSaved to ${AUTH_FILE}`);
  console.log(`  logged-in token: ${accessToken ? `yes${exp ? `, expires ${new Date(exp * 1000).toLocaleString()}` : ""}` : "no (public access only)"}`);
  console.log(`  auto-renew:      ${refreshToken ? "yes" : "no, rerun npm run auth when it expires"}`);
  process.exit(0);
}
