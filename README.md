# uiland-mcp

Personal MCP server that lets Claude Code, Antigravity, Cursor and Claude Desktop browse Uiland, see real app screens, and save them straight into your project.

Private use only. It uses your own Uiland account through the same API the website uses. Don't publish it or share your credentials.

## Setup

Requires Node 20+.

```bash
npm install
npm run build
```

## 1. Connect your account

Tip: do this in a **private/incognito window** logged into Uiland, then close the window without logging out. That gives the MCP its own session, so it never logs your normal browser out.

1. Open uiland.design, log in, open DevTools (F12) > Network > Fetch/XHR, and browse any app.
2. Right-click any request to `api.uiland.design` > Copy > Copy as cURL (bash).
3. Run `npm run auth` and paste it, then press Enter. If your terminal acts up with long pastes, save the cURL to `curl.txt` and the token value to `token.txt`, then run `npm run auth -- curl.txt token.txt` instead.
4. When asked for the refresh token: DevTools > Application > Local Storage (or Cookies) > uiland.design. Find the key that starts with `sb-` and ends with `-auth-token`, copy its whole value, paste, Enter.

With the refresh token saved, the session renews itself. Without it, you'll need to rerun `npm run auth` about every hour.

## 2. Check it works

```bash
npm run discover
```

Runs a test of every tool's query against your account (add `-- --schema` to also list Uiland's tables). Writes `discover.txt`. It skips anything account-related (profile, payments, engagement).

Other handy commands:

```bash
npm run probe -- "screenImages?select=id,url&limit=2"   # run any read query
npm run inspect                                         # MCP Inspector in the browser
```

## 3. Add to your tools

**Claude Code**

```bash
claude mcp add uiland --scope user -- node /ABSOLUTE/PATH/TO/uiland-mcp/dist/index.js
```

Then `claude` and `/mcp` to confirm.

**Antigravity**: Agent panel > "..." > MCP Servers > Manage MCP Servers > View raw config:

```json
{
  "mcpServers": {
    "uiland": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/uiland-mcp/dist/index.js"]
    }
  }
}
```

Save, then Refresh. On Windows use double backslashes in the path.

**Cursor**: same JSON in `~/.cursor/mcp.json`.

## Tools

| Tool | What it does |
| --- | --- |
| `uiland_get_app` | App details, flows with screen counts, screen types |
| `uiland_get_app_screens` | An app's screens: a full flow, a screen type, App Store shots, or everything. Includes the flow's screen recording when there is one |
| `uiland_search_screens` | Search every app by flow, screen type, or words on screen |
| `uiland_similar_screens` | Screens from other apps that look like a given one |
| `uiland_search_apps` | Find apps by name, category, country |
| `uiland_save_screens` | Download specific screens by image_url |
| `uiland_auth_status` | Session status and expiry |

Screen tools accept `save_to` to download every result into a folder.

## Example prompts

- "Get Kuda's KYC flow from Uiland and save it to inspo/kyc, then build my Flutter KYC screens in that direction"
- "Search Uiland for bill payment flows across apps and compare how 3 of them structure it"
- "Find Nigerian finance apps on Uiland, then show me how 3 of them do onboarding"
- "Find screens similar to this one from other apps"

## Files

```
src/index.ts      entry: server, or auth / discover / probe commands
src/server.ts     the MCP tools
src/api.ts        Uiland queries (edit here if Uiland changes)
src/supabase.ts   REST client with automatic token renewal
src/auth.ts       credential storage and parsing
src/images.ts     image download and base64
src/discover.ts   schema and health check
```
