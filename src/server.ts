import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AuthError,
  getAppScreens,
  listFlows,
  resolveApp,
  screenTypeCounts,
  searchApps,
  searchScreens,
  similarScreens,
  type Screen,
} from "./api.js";
import { AUTH_FILE, jwtExp, loadAuth } from "./auth.js";
import { imageAsContent, saveImages } from "./images.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const MAX_INLINE_IMAGES = 6;

const showImages = z
  .boolean()
  .default(true)
  .describe("Return screenshots so you can see them (first 6). Set false for a fast text-only list.");
const saveTo = z
  .string()
  .optional()
  .describe("Folder to download ALL returned screens into, e.g. 'inspo/kuda-kyc'");
const limit = z.number().int().min(1).max(100).default(12);

function label(s: Screen) {
  const base = [s.app, s.flow, s.screenType].filter(Boolean).join(" / ") || "screen";
  return s.similarity !== undefined ? `${base} (similarity ${s.similarity.toFixed(2)})` : base;
}

async function screensResult(header: string, screens: Screen[], show: boolean, save?: string) {
  if (!screens.length) return { content: [{ type: "text" as const, text: `${header}\n\nNo screens found.` }] };
  const list = screens.map((s, i) => `${i + 1}. ${label(s)}\n   id: ${s.id}\n   image_url: ${s.imageUrl}`).join("\n");
  const content: Content[] = [{ type: "text", text: `${header}\n\n${list}` }];

  if (save) {
    const { saved, failed } = await saveImages(
      screens.map((s) => ({ url: s.imageUrl, name: `${label(s)} ${s.id.slice(0, 8)}` })),
      save
    );
    content.push({ type: "text", text: `Saved ${saved.length} file(s) to ${save}${failed.length ? `\nFailed:\n${failed.join("\n")}` : ""}` });
  }
  if (show) {
    for (const s of screens.slice(0, MAX_INLINE_IMAGES)) {
      try {
        const img = await imageAsContent(s.imageUrl);
        if (img) content.push({ type: "text", text: `[${s.id}] ${label(s)}` }, img);
      } catch {
        /* URL still listed */
      }
    }
    if (screens.length > MAX_INLINE_IMAGES) {
      content.push({ type: "text", text: `Showing ${MAX_INLINE_IMAGES} of ${screens.length} images. Use save_to to get all of them.` });
    }
  }
  return { content };
}

const wrap =
  <A,>(fn: (args: A) => Promise<{ content: Content[] }>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = e instanceof AuthError ? "\nAsk the user to run `npm run auth` in the uiland-mcp folder." : "";
      return { isError: true, content: [{ type: "text" as const, text: msg + hint }] };
    }
  };

export function createServer(): McpServer {
  const server = new McpServer({ name: "uiland", version: "0.4.0" });

  server.registerTool(
    "uiland_get_app",
    {
      title: "App overview",
      description:
        "Overview of one app on Uiland: details, its flows (onboarding, kyc, bill-payment...) with screen counts, " +
        "and its screen types. Call this before uiland_get_app_screens to get exact flow and screen-type slugs.",
      inputSchema: { app: z.string().min(1).describe("App slug, e.g. 'kuda', or name or id") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ app }) => {
      const a = await resolveApp(app);
      const [flows, types] = await Promise.all([listFlows(a.id), screenTypeCounts(a.id).catch(() => [])]);
      const text = [
        `${a.name} [${a.slug}]${a.category ? `, ${a.category}` : ""}${a.country ? `, ${a.country}` : ""}`,
        a.description ?? "",
        a.website ? `Website: ${a.website}` : "",
        flows.length ? `\nFlows (${flows.length}):\n${flows.map((f) => `- ${f.name.trim()} [${f.slug}]${f.count ? `: ${f.count} screens` : ""}`).join("\n")}` : "\nNo flows.",
        types.length ? `\nScreen types:\n${types.map((t) => `- ${t.slug}: ${t.count}`).join("\n")}` : "",
      ];
      return { content: [{ type: "text", text: text.filter(Boolean).join("\n") }] };
    })
  );

  server.registerTool(
    "uiland_get_app_screens",
    {
      title: "Get an app's screens",
      description:
        "Get real screens from one app, in order. Pass a flow slug (e.g. 'onboarding', 'kyc') for a complete flow, " +
        "a screen_type (e.g. 'signup', 'transfer-send-money'), app_store=true for its App Store screenshots, " +
        "or nothing for all screens. Page with offset.",
      inputSchema: {
        app: z.string().min(1).describe("App slug, e.g. 'kuda'"),
        flow: z.string().optional().describe("Flow slug or name"),
        screen_type: z.string().optional().describe("Screen type slug"),
        app_store: z.boolean().default(false),
        limit,
        offset: z.number().int().min(0).default(0),
        show_images: showImages,
        save_to: saveTo,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    wrap(async (a) => {
      const r = await getAppScreens({
        app: a.app,
        flow: a.flow,
        screenType: a.screen_type,
        appStore: a.app_store,
        limit: a.limit,
        offset: a.offset,
      });
      const what = a.app_store ? "App Store" : [r.flow, a.screen_type].filter(Boolean).join(" / ") || "all screens";
      const header =
        `${r.app.name} / ${what}: ${r.screens.length} screen(s) from offset ${a.offset}` +
        (r.videoUrl ? `\nScreen recording of this flow: ${r.videoUrl}` : "");
      return screensResult(header, r.screens, a.show_images, a.save_to);
    })
  );

  server.registerTool(
    "uiland_search_screens",
    {
      title: "Search screens across all apps",
      description:
        "Search every app on Uiland (strong on African fintech, banking, ride-hailing, e-commerce). " +
        "mode 'flow' matches flow names (onboarding, kyc, bill payment), 'screen_type' matches screen types " +
        "(signup, empty state, paywall), 'text' matches words shown on screen (e.g. 'bvn', 'verify'), " +
        "'auto' tries flow then screen type. Good for comparing how different apps handle the same thing.",
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(["auto", "flow", "screen_type", "text"]).default("auto"),
        limit,
        show_images: showImages,
        save_to: saveTo,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    wrap(async (a) => screensResult(`Results for "${a.query}" (${a.mode}):`, await searchScreens(a.query, a.mode, a.limit), a.show_images, a.save_to))
  );

  server.registerTool(
    "uiland_similar_screens",
    {
      title: "Visually similar screens",
      description:
        "Find screens from OTHER apps that look like a given screen. Pass a screen id from any other tool's results. " +
        "Great for seeing several takes on the same screen.",
      inputSchema: { screen_id: z.string().min(1), limit, show_images: showImages, save_to: saveTo },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    wrap(async (a) => screensResult(`Screens similar to ${a.screen_id}:`, await similarScreens(a.screen_id, a.limit), a.show_images, a.save_to))
  );

  server.registerTool(
    "uiland_search_apps",
    {
      title: "Find apps",
      description:
        "Find apps on Uiland by name, description, category and/or country, e.g. query 'payments', " +
        "country 'Nigeria', category 'Finance'. Returns slugs for the other tools.",
      inputSchema: {
        query: z.string().optional(),
        country: z.string().optional(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      if (!a.query && !a.country && !a.category) throw new Error("Give at least one of query, country or category.");
      const apps = await searchApps(a);
      const text = apps.length
        ? apps.map((x, i) => `${i + 1}. ${x.name} [${x.slug}]${x.category ? `, ${x.category}` : ""}${x.country ? `, ${x.country}` : ""}${x.description ? `: ${x.description}` : ""}`).join("\n")
        : "No apps found.";
      return { content: [{ type: "text", text }] };
    })
  );

  server.registerTool(
    "uiland_save_screens",
    {
      title: "Save screens to the project",
      description: "Download specific screens (by image_url from earlier results) into a project folder.",
      inputSchema: {
        screens: z.array(z.object({ image_url: z.string().url(), name: z.string().default("screen") })).min(1).max(100),
        folder: z.string().default("inspo"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    wrap(async ({ screens, folder }) => {
      const { saved, failed } = await saveImages(screens.map((s) => ({ url: s.image_url, name: s.name })), folder);
      return { content: [{ type: "text", text: `Saved ${saved.length} file(s):\n${saved.join("\n")}${failed.length ? `\nFailed:\n${failed.join("\n")}` : ""}` }] };
    })
  );

  server.registerTool(
    "uiland_auth_status",
    {
      title: "Check Uiland login",
      description: "Check the saved Uiland session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const a = await loadAuth();
      if (!a) return { content: [{ type: "text", text: `Not set up (${AUTH_FILE}). Run: npm run auth` }] };
      const exp = jwtExp(a.accessToken);
      const text = [
        `Saved ${a.savedAt}`,
        `Logged-in token: ${a.accessToken ? (exp ? `expires ${new Date(exp * 1000).toISOString()}` : "yes") : "no, public access only"}`,
        `Auto-renew: ${a.refreshToken ? "yes" : "no"}`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    })
  );

  return server;
}
