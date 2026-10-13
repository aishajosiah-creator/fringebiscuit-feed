// Fetches the newest Instagram posts for @fringebiscuitmagazine and writes a
// static feed (feed.json plus rehosted images) into ./public, which GitHub
// Pages then serves to the Framer component.
//
// Instagram's media URLs are signed CDN links that expire, so every image is
// downloaded and re-served from this repository rather than hot-linked.
//
// Environment:
//   IG_ACCESS_TOKEN   long-lived Instagram token (repository secret)
//   POST_COUNT        optional, defaults to 6
//
// Exit codes: non-zero on any failure, so the workflow fails visibly and
// GitHub emails the repository owner. The previous good feed.json is left in
// place on failure, so the site keeps showing the last good posts.

import { mkdir, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const TOKEN = process.env.IG_ACCESS_TOKEN;
const COUNT = Number(process.env.POST_COUNT || 6);
const OUT = path.resolve("public");
const IMG_DIR = path.join(OUT, "img");
const API = "https://graph.instagram.com";

if (!TOKEN) {
  console.error("IG_ACCESS_TOKEN is not set.");
  process.exit(1);
}

async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    // Never print the URL: it carries the token.
    throw new Error(`Instagram API ${res.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

function cleanCaption(raw = "") {
  // House style, mirroring catchup.py: drop trailing hashtag blocks and
  // ticket/credit lines, keep inline hashtags, handles and emoji.
  const lines = raw.split(/\r?\n/);
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (
      last === "" ||
      /^(#\S+\s*)+$/.test(last) ||
      /^(📸|photo|tickets?|book now|link in bio)/i.test(last)
    ) {
      lines.pop();
    } else break;
  }
  return lines.join("\n").trim();
}

function firstLine(text) {
  return (text.split(/\r?\n/).find((l) => l.trim()) || "").trim();
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  return buf.length;
}

async function main() {
  const fields =
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}";
  const data = await getJSON(
    `${API}/me/media?fields=${encodeURIComponent(fields)}&limit=${COUNT * 2}&access_token=${TOKEN}`
  );

  const posts = [];
  await mkdir(IMG_DIR, { recursive: true });

  for (const item of data.data || []) {
    if (posts.length >= COUNT) break;

    // Pick a still image for every media type.
    let src = null;
    if (item.media_type === "IMAGE") src = item.media_url;
    else if (item.media_type === "VIDEO") src = item.thumbnail_url;
    else if (item.media_type === "CAROUSEL_ALBUM") {
      const first = item.children?.data?.[0];
      src = first?.media_type === "VIDEO" ? first.thumbnail_url : first?.media_url;
      src = src || item.media_url;
    }
    if (!src) continue;

    const file = `${item.id}.jpg`;
    const dest = path.join(IMG_DIR, file);
    if (!existsSync(dest)) await download(src, dest);

    const caption = cleanCaption(item.caption);
    posts.push({
      id: item.id,
      permalink: item.permalink,
      timestamp: item.timestamp,
      type: item.media_type,
      image: `img/${file}`,
      title: firstLine(caption),
      caption,
    });
  }

  if (posts.length === 0) {
    throw new Error("Instagram returned no usable posts; keeping the previous feed.");
  }

  // Remove images no longer in the feed so the repository stays small.
  const keep = new Set(posts.map((p) => path.basename(p.image)));
  for (const f of await readdir(IMG_DIR)) {
    if (!keep.has(f)) await rm(path.join(IMG_DIR, f));
  }

  const feed = { updated: new Date().toISOString(), count: posts.length, posts };
  const next = JSON.stringify(feed, null, 2);

  // Only rewrite when the posts themselves changed, so the hourly job does
  // not create an empty commit every hour.
  const feedPath = path.join(OUT, "feed.json");
  if (existsSync(feedPath)) {
    const prev = JSON.parse(await readFile(feedPath, "utf8"));
    if (JSON.stringify(prev.posts) === JSON.stringify(posts)) {
      console.log(`No change: ${posts.length} posts.`);
      return;
    }
  }
  await writeFile(feedPath, next + "\n");
  console.log(`Wrote ${posts.length} posts.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
