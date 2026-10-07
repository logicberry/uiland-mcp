// Thin client for Uiland's Supabase REST API with automatic token renewal.
import { type AuthData, jwtExp, loadAuth, saveAuth } from "./auth.js";

export const API_URL = process.env.UILAND_API_URL ?? "https://api.uiland.design";

export class AuthError extends Error {}
export class RestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let refreshing: Promise<AuthData> | null = null;

async function refresh(a: AuthData): Promise<AuthData> {
  if (!a.refreshToken) throw new AuthError("Session expired. Run: npm run auth");
  refreshing ??= (async () => {
    const res = await fetch(`${API_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: a.apikey, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: a.refreshToken }),
    });
    if (!res.ok) throw new AuthError(`Could not renew session (${res.status}). Run: npm run auth`);
    const j = (await res.json()) as { access_token: string; refresh_token: string };
    const next = { ...a, accessToken: j.access_token, refreshToken: j.refresh_token, savedAt: new Date().toISOString() };
    await saveAuth(next);
    return next;
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function credentials(forceRefresh = false): Promise<{ apikey: string; bearer: string }> {
  let a = await loadAuth();
  if (!a) throw new AuthError("Not set up yet. Run: npm run auth");
  const exp = jwtExp(a.accessToken);
  const expired = exp !== null && exp * 1000 < Date.now() + 60_000;
  if ((forceRefresh || expired) && a.refreshToken) a = await refresh(a);
  else if (expired) {
    console.error("uiland-mcp: logged-in token expired, falling back to public access");
    return { apikey: a.apikey, bearer: a.apikey };
  }
  return { apikey: a.apikey, bearer: a.accessToken ?? a.apikey };
}

export interface RestResult<T> {
  data: T;
  count?: number;
}

export async function rest<T = any>(
  table: string,
  params: Record<string, string | number | undefined>,
  opts: { count?: boolean; method?: string; body?: unknown } = {}
): Promise<RestResult<T>> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.append(k, String(v));
  const url = `${API_URL}/rest/v1/${table}${qs.size ? `?${qs}` : ""}`;

  const attempt = async (force: boolean) => {
    const { apikey, bearer } = await credentials(force);
    return fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        apikey,
        authorization: `Bearer ${bearer}`,
        accept: "application/json",
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(opts.count ? { prefer: "count=exact" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };

  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`Uiland refused access (${res.status}). Run: npm run auth`);
  }
  if (!res.ok) throw new RestError(res.status, `Uiland API ${res.status} on ${table}: ${(await res.text()).slice(0, 300)}`);

  const range = res.headers.get("content-range");
  const count = range?.includes("/") ? Number(range.split("/")[1]) : undefined;
  return { data: (await res.json()) as T, count: Number.isFinite(count) ? count : undefined };
}
