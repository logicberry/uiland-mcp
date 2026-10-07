// Maps Uiland's API so endpoints can be wired correctly. Prints no tokens or personal data.
// Run: npm run discover   (writes discover.txt; send that file's contents)
import { promises as fs } from "node:fs";
import { getAppScreens, listFlows, resolveApp, searchApps, searchScreens, similarScreens } from "./api.js";
import { rest } from "./supabase.js";

const out: string[] = [];
const log = (s = "") => {
  out.push(s);
  console.log(s);
};
const preview = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 90 ? `${s.slice(0, 90)}...` : s;
};
const SKIP = /profile|user|auth|email|payment|subscri|billing|engagement/i;

async function section(title: string, fn: () => Promise<void>) {
  log(`\n=== ${title} ===`);
  try {
    await fn();
  } catch (e) {
    log(`FAILED: ${(e as Error).message}`);
  }
}

export async function runDiscover(withSchema = false): Promise<void> {
  if (withSchema) await section("Schema (OpenAPI)", async () => {
    const { data } = await rest<any>("", {});
    const defs = data?.definitions ?? {};
    const tables = Object.keys(defs).filter((t) => !SKIP.test(t));
    log(`${tables.length} tables/views:`);
    for (const t of tables) log(`- ${t}: ${Object.keys(defs[t].properties ?? {}).join(", ")}`);
    const rpcs = Object.entries<any>(data?.paths ?? {}).filter(([p]) => p.startsWith("/rpc/") && !SKIP.test(p));
    log(`\n${rpcs.length} RPC functions:`);
    for (const [p, spec] of rpcs) {
      const body = spec.post?.parameters?.find((x: any) => x.in === "body")?.schema?.properties ?? {};
      log(`- ${p.slice(5)}(${Object.keys(body).join(", ")})`);
    }
  });

  await section("Check: resolve kuda", async () => log(preview(await resolveApp("kuda"))));
  await section("Check: kuda flows", async () => {
    const f = await listFlows("kuda");
    log(`${f.length} flows: ${f.map((x) => `${x.slug}(${x.count ?? "?"})`).join(", ")}`);
  });
  let firstId = "";
  await section("Check: kuda kyc screens", async () => {
    const r = await getAppScreens({ app: "kuda", flow: "kyc", limit: 3, offset: 0 });
    firstId = r.screens[0]?.id ?? "";
    log(preview(r.screens));
    log(`video: ${r.videoUrl ?? "none"}`);
  });
  await section("Check: kuda signup screen type", async () => log(preview((await getAppScreens({ app: "kuda", screenType: "signup", limit: 2, offset: 0 })).screens)));
  await section("Check: kuda app store", async () => log(preview((await getAppScreens({ app: "kuda", appStore: true, limit: 2, offset: 0 })).screens)));
  await section("Check: Nigerian finance apps", async () => log((await searchApps({ country: "Nigeria", category: "Finance", limit: 10 })).map((a) => a.slug).join(", ")));
  await section("Check: search flow 'onboarding'", async () => log(preview(await searchScreens("onboarding", "flow", 3))));
  await section("Check: search screen_type 'empty state'", async () => log(preview(await searchScreens("empty state", "screen_type", 3))));
  await section("Check: search text 'bvn'", async () => log(preview(await searchScreens("bvn", "text", 3))));
  await section("Check: similar screens", async () => {
    if (!firstId) return log("skipped, no screen id");
    log(preview(await similarScreens(firstId, 3)));
  });

  await fs.writeFile("discover.txt", out.join("\n"));
  console.log("\nSaved to discover.txt");
}
