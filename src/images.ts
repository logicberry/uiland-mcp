// Downloads screenshots, either as base64 for the model to see or to disk for your project.
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_INLINE_BYTES = 3_000_000;

async function fetchImage(url: string): Promise<{ data: Buffer; mimeType: string }> {
  // Screenshots are public on images.uiland.design, no login needed.
  const res = await fetch(url, { headers: { referer: "https://uiland.design/" } });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status} (${url})`);
  const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0];
  return { data: Buffer.from(await res.arrayBuffer()), mimeType };
}

export async function imageAsContent(url: string) {
  const { data, mimeType } = await fetchImage(url);
  if (data.length > MAX_INLINE_BYTES) return null;
  return { type: "image" as const, data: data.toString("base64"), mimeType };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "screen";
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export async function saveImages(
  items: { url: string; name: string }[],
  folder: string
): Promise<{ saved: string[]; failed: string[] }> {
  const dir = path.resolve(process.env.UILAND_SAVE_ROOT ?? process.cwd(), folder);
  await fs.mkdir(dir, { recursive: true });
  const saved: string[] = [];
  const failed: string[] = [];

  for (const [i, item] of items.entries()) {
    try {
      const { data, mimeType } = await fetchImage(item.url);
      const file = path.join(dir, `${String(i + 1).padStart(2, "0")}-${slug(item.name)}.${EXT[mimeType] ?? "png"}`);
      await fs.writeFile(file, data);
      saved.push(file);
    } catch (e) {
      failed.push(`${item.url}: ${(e as Error).message}`);
    }
  }
  return { saved, failed };
}
