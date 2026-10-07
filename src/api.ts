// Uiland data access via its Supabase REST API.
// Tables/RPCs below were confirmed with `npm run discover` on 2026-10-07.
import { RestError, rest } from "./supabase.js";

export { AuthError } from "./supabase.js";

const IMAGE_HOST = process.env.UILAND_IMAGE_HOST ?? "https://images.uiland.design";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Screen {
  id: string;
  app?: string;
  appId?: string;
  imageUrl: string;
  flow?: string;
  screenType?: string;
  similarity?: number;
}

export interface Flow {
  name: string; // raw category, can have trailing spaces; used as the filter value
  slug: string;
  count?: number;
}

export interface App {
  id: string;
  name: string;
  slug: string;
  category?: string;
  country?: string;
  description?: string;
  website?: string;
  versionId?: string;
}

// ---------- helpers ----------

export function normalizeImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".r2.dev")) return `${IMAGE_HOST}${u.pathname}`;
  } catch {
    /* keep */
  }
  return url;
}

export function appFromUrl(url: string): string | undefined {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "mobile-screens") return parts[1];
    if (parts[0] === "app-store") return undefined;
    return parts.length > 1 ? parts[0] : undefined;
  } catch {
    return undefined;
  }
}

function mapScreen(r: any, app?: string): Screen {
  const url = normalizeImageUrl(String(r.url ?? r.image_url ?? ""));
  const product = Array.isArray(r.Products) ? r.Products[0] : r.Products;
  return {
    id: String(r.id ?? r.similar_screen_image_id ?? r.image_id),
    appId: r.screenId ?? r.screen_id,
    app: app ?? r.brand_slug ?? appFromUrl(url),
    imageUrl: url,
    flow: product?.category?.trim() || undefined,
    screenType: r.screen_type_slug ?? undefined,
    similarity: typeof r.visual_similarity === "number" ? r.visual_similarity : undefined,
  };
}

const clean = (q: string) => q.replace(/[*,()"]/g, " ").trim();
const like = (q: string) => `*${clean(q)}*`;
const slugify = (q: string) => q.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Run a screenImages query with the rich select; if the join is rejected, retry without it.
async function screens(params: Record<string, string | number | undefined>, withFlowJoin: "inner" | "left") {
  const join = withFlowJoin === "inner" ? "Products!inner(category)" : "Products(category)";
  try {
    return (await rest<any[]>("screenImages", { ...params, select: `id,url,screenId,screen_type_slug,${join}` })).data;
  } catch (e) {
    if (e instanceof RestError && e.status === 400 && withFlowJoin === "left") {
      return (await rest<any[]>("screenImages", { ...params, select: "id,url,screenId,screen_type_slug" })).data;
    }
    throw e;
  }
}

// ---------- apps ----------

const APP_COLS = "id,name,slug,category,country,description,url";
const appCache = new Map<string, App>();

function mapApp(r: any, slug?: string): App {
  return {
    id: String(r.id ?? r.brand_id),
    name: r.name,
    slug: r.slug ?? slug ?? r.brand_slug ?? slugify(r.name ?? ""),
    category: r.category ?? undefined,
    country: r.country ?? undefined,
    description: r.description?.trim() || undefined,
    website: r.url ?? undefined,
  };
}

export async function resolveApp(slugOrId: string): Promise<App> {
  const key = slugOrId.toLowerCase().trim();
  if (appCache.has(key)) return appCache.get(key)!;

  let app: App | undefined;
  if (UUID.test(key)) {
    const { data } = await rest<any[]>("Screens", { select: APP_COLS, id: `eq.${key}`, limit: 1 });
    if (data[0]) app = mapApp(data[0]);
  } else {
    // Screens.slug is empty for some apps, so the flows view (brand_slug) is the reliable lookup.
    const { data } = await rest<any[]>("screenshot_flowsss_slugged_mat", {
      select: "brand_id,brand_slug,name,version_id",
      brand_slug: `eq.${key}`,
      limit: 1,
    });
    if (data[0]) {
      app = { ...mapApp({ id: data[0].brand_id, name: data[0].name }, key), versionId: data[0].version_id };
      const meta = (await rest<any[]>("Screens", { select: APP_COLS, id: `eq.${app.id}`, limit: 1 })).data[0];
      if (meta) app = { ...mapApp(meta, key), versionId: app.versionId };
    } else {
      const { data: byName } = await rest<any[]>("Screens", { select: APP_COLS, or: `(slug.eq.${key},name.ilike.${clean(key)})`, limit: 1 });
      if (byName[0]) app = mapApp(byName[0]);
    }
  }
  if (!app) throw new Error(`No app "${slugOrId}" on Uiland. Try uiland_search_apps.`);

  if (!app.versionId) {
    const v = await rest<any[]>("screenImages", { select: "version_id", screenId: `eq.${app.id}`, order: "created_at.desc", limit: 1 });
    app.versionId = v.data[0]?.version_id;
  }
  appCache.set(key, app);
  appCache.set(app.id, app);
  return app;
}

export async function searchApps(opts: { query?: string; country?: string; category?: string; limit: number }): Promise<App[]> {
  const params: Record<string, string | number | undefined> = { select: APP_COLS, order: "updated_at.desc", limit: opts.limit };
  if (opts.query) params.or = `(name.ilike.${like(opts.query)},description.ilike.${like(opts.query)},category.ilike.${like(opts.query)})`;
  if (opts.country) params.country = `ilike.${like(opts.country)}`;
  if (opts.category) params.category = `ilike.${like(opts.category)}`;
  const { data } = await rest<any[]>("Screens", params);
  return data.map((r) => mapApp(r));
}

// ---------- flows ----------

export async function listFlows(slugOrId: string): Promise<Flow[]> {
  const app = await resolveApp(slugOrId);
  const { data } = await rest<{ category: string; category_slug: string }[]>("screenshot_flowsss_slugged_mat", {
    select: "category,category_slug",
    brand_id: `eq.${app.id}`,
    category: "neq.null",
    version_id: app.versionId ? `eq.${app.versionId}` : undefined,
  });
  const flows = new Map<string, Flow>();
  for (const r of data) if (!flows.has(r.category_slug)) flows.set(r.category_slug, { name: r.category, slug: r.category_slug });

  try {
    const { data: feed } = await rest<{ count: number; source_id: string }[]>("home_feed_items", {
      select: "count,source_id",
      source_id: `like.${app.id}:*`,
      is_active: "eq.true",
    });
    for (const f of feed) {
      const s = f.source_id.split(":")[1]?.replace(/-$/, "");
      const flow = [...flows.values()].find((x) => x.slug.replace(/-$/, "") === s);
      if (flow && typeof f.count === "number") flow.count = f.count;
    }
  } catch {
    /* counts are optional */
  }
  return [...flows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function findFlow(app: App, flow: string): Promise<Flow> {
  const flows = await listFlows(app.id);
  const want = slugify(flow);
  const hit =
    flows.find((f) => f.slug.replace(/-$/, "") === want) ??
    flows.find((f) => slugify(f.name) === want) ??
    flows.find((f) => slugify(f.name).includes(want));
  if (!hit) throw new Error(`No "${flow}" flow in ${app.name}. Available: ${flows.map((f) => f.slug).join(", ")}`);
  return hit;
}

export async function screenTypeCounts(slugOrId: string): Promise<{ slug: string; count: number }[]> {
  const app = await resolveApp(slugOrId);
  const { data } = await rest<{ screen_type_slug: string | null }[]>("screenImages", {
    select: "screen_type_slug",
    screenId: `eq.${app.id}`,
    version_id: app.versionId ? `eq.${app.versionId}` : undefined,
    screen_type_slug: "not.is.null",
    limit: 5000,
  });
  const counts = new Map<string, number>();
  for (const r of data) counts.set(r.screen_type_slug!, (counts.get(r.screen_type_slug!) ?? 0) + 1);
  return [...counts].map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count);
}

// ---------- screens ----------

export async function getAppScreens(opts: {
  app: string;
  flow?: string;
  screenType?: string;
  appStore?: boolean;
  limit: number;
  offset: number;
}): Promise<{ app: App; screens: Screen[]; flow?: string; videoUrl?: string }> {
  const app = await resolveApp(opts.app);

  if (opts.appStore) {
    const { data } = await rest<any[]>("appStoreImages", {
      select: "id,url,screenId,screen_type_slug",
      screenId: `eq.${app.id}`,
      order: "app_store_position.asc",
      offset: opts.offset,
      limit: opts.limit,
    });
    return { app, screens: data.map((r) => mapScreen(r, app.slug)) };
  }

  const params: Record<string, string | number | undefined> = {
    screenId: `eq.${app.id}`,
    version_id: app.versionId ? `eq.${app.versionId}` : undefined,
    order: "url.asc,id.asc",
    offset: opts.offset,
    limit: opts.limit,
  };
  if (opts.screenType) params.screen_type_slug = `eq.${slugify(opts.screenType)}`;

  let flow: Flow | undefined;
  let videoUrl: string | undefined;
  if (opts.flow) {
    flow = await findFlow(app, opts.flow);
    params["Products.category"] = `eq.${flow.name}`;
    try {
      const v = await rest<any[]>("mobileFlowVideos", {
        select: "video_url,Products!inner(category)",
        screen_id: `eq.${app.id}`,
        "Products.category": `eq.${flow.name}`,
        video_url: "not.is.null",
        limit: 1,
      });
      videoUrl = v.data[0]?.video_url ? normalizeImageUrl(v.data[0].video_url) : undefined;
    } catch {
      /* video is optional */
    }
  }

  const rows = await screens(params, flow ? "inner" : "left");
  return { app, screens: rows.map((r) => mapScreen(r, app.slug)), flow: flow?.name.trim(), videoUrl };
}

// Cross-app search. mode "flow" matches flow names, "screen_type" matches screen types,
// "text" matches words visible on the screen (OCR). "auto" tries flow, then screen type.
export async function searchScreens(query: string, mode: "auto" | "flow" | "screen_type" | "text", limit: number): Promise<Screen[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  const add = (rows: any[]) => {
    for (const r of rows) if (!seen.has(r.id) && out.length < limit) (seen.add(r.id), out.push(r));
  };

  if (mode === "flow" || mode === "auto") {
    add(await screens({ "Products.category": `ilike.${like(query)}`, order: "created_at.desc", limit }, "inner"));
  }
  if ((mode === "screen_type" || mode === "auto") && out.length < limit) {
    const { data: types } = await rest<{ slug: string }[]>("screentypes", {
      select: "slug",
      or: `(slug.ilike.${like(slugify(query))},category.ilike.${like(query)})`,
      limit: 5,
    });
    if (types.length) {
      add(await screens({ screen_type_slug: `in.(${types.map((t) => t.slug).join(",")})`, order: "created_at.desc", limit: limit - out.length }, "left"));
    }
  }
  if (mode === "text" && out.length < limit) {
    const words = clean(query).toLowerCase().split(/\s+/).filter(Boolean);
    try {
      add(await screens({ imagetext: `cs.${JSON.stringify(words)}`, order: "created_at.desc", limit }, "left"));
    } catch {
      add(await screens({ imagetext: `cs.{${words.join(",")}}`, order: "created_at.desc", limit }, "left"));
    }
  }
  return out.map((r) => mapScreen(r));
}

// Visually similar screens across all apps. Tries the site's RPCs from fastest to slowest.
export async function similarScreens(screenId: string, limit: number): Promise<Screen[]> {
  const attempts: [string, Record<string, unknown>][] = [
    ["get_similar_mobile_screens_cached", { p_source_image_id: screenId, p_match_count: limit }],
    ["get_similar_mobile_screens_with_count", { p_source_image_id: screenId, p_match_count: limit, p_max: limit }],
    ["get_similar_mobile_screens_v2", { p_source_image_id: screenId, p_match_count: limit }],
  ];
  let lastError: unknown;
  for (const [fn, body] of attempts) {
    try {
      const { data } = await rest<any>(`rpc/${fn}`, {}, { method: "POST", body });
      const rows: any[] = Array.isArray(data) ? data : data?.rows ?? [];
      if (rows.length) return rows.filter((r) => String(r.id ?? r.similar_screen_image_id) !== screenId).slice(0, limit).map((r) => mapScreen(r));
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return [];
}
