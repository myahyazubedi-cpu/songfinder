// Netlify Function for /api/search
//   mode=lyrics (default): Genius finds songs by lyrics, then Spotify supplies cover + link
//   mode=title:            plain Spotify search by song name / artist
// Environment variables (Netlify > Site configuration > Environment variables):
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, GENIUS_ACCESS_TOKEN

const PAGE_SIZE = 10;

let token = null;
let tokenExpires = 0;

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function getToken() {
  if (token && Date.now() < tokenExpires - 30_000) return token;
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw fail("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET environment variables", 500);

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw fail("Spotify rejected the credentials (check your Client ID/Secret)", 502);
  const data = await res.json();
  token = data.access_token;
  tokenExpires = Date.now() + data.expires_in * 1000;
  return token;
}

function shape(s) {
  return {
    id: s.id,
    name: s.name,
    artists: s.artists.map((a) => a.name).join(", "),
    album: s.album.name,
    image: (s.album.images[1] || s.album.images[0] || {}).url || null,
    url: s.external_urls.spotify,
  };
}

async function spotifySearch(q, limit, offset) {
  const t = await getToken();
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", q);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", limit);
  url.searchParams.set("offset", offset);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 429) throw fail("Spotify rate limit hit, wait a few seconds and try again", 429);
  if (!res.ok) throw fail(`Spotify error ${res.status}`, 502);
  return (await res.json()).tracks;
}

// --- plain Spotify search (song name / artist) ---
async function titleSearch(q, offset) {
  const tracks = await spotifySearch(q, PAGE_SIZE, offset);
  return {
    total: tracks.total,
    nextOffset: tracks.next ? offset + PAGE_SIZE : null,
    items: tracks.items.map(shape),
  };
}

// --- lyrics search: Genius -> Spotify ---
async function lyricsSearch(q, offset) {
  const gt = process.env.GENIUS_ACCESS_TOKEN;
  if (!gt) throw fail("Missing GENIUS_ACCESS_TOKEN environment variable", 500);

  const url = new URL("https://api.genius.com/search");
  url.searchParams.set("q", q);
  url.searchParams.set("per_page", PAGE_SIZE);
  url.searchParams.set("page", Math.floor(offset / PAGE_SIZE) + 1);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${gt}` } });
  if (res.status === 401) throw fail("Genius rejected the token (check GENIUS_ACCESS_TOKEN)", 502);
  if (!res.ok) throw fail(`Lyrics service error ${res.status}`, 502);
  const data = await res.json();
  const found = (data.response?.hits || [])
    .filter((h) => h.type === "song")
    .map((h) => h.result);

  // find each one on Spotify (in parallel) to get the cover and link
  const clean = (s) => s.replace(/["]/g, "").replace(/\(.*?\)|\[.*?\]/g, "").trim();
  const matched = await Promise.all(
    found.map(async (t) => {
      try {
        const title = clean(t.title);
        const artist = clean(t.primary_artist?.name || "");
        let tr = await spotifySearch(`track:${title} artist:${artist}`, 1, 0);
        if (!tr.items[0]) tr = await spotifySearch(`${title} ${artist}`, 1, 0);
        return tr.items[0] ? shape(tr.items[0]) : null;
      } catch {
        return null;
      }
    })
  );

  const seen = new Set();
  const items = matched.filter((s) => s && !seen.has(s.id) && seen.add(s.id));

  return {
    total: null,
    nextOffset: found.length >= PAGE_SIZE && offset + PAGE_SIZE < PAGE_SIZE * 10 ? offset + PAGE_SIZE : null,
    items,
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const mode = url.searchParams.get("mode") === "title" ? "title" : "lyrics";
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  if (!q) return json({ error: "Type some lyrics or a keyword to search" }, 400);
  try {
    return json(mode === "title" ? await titleSearch(q, offset) : await lyricsSearch(q, offset));
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};

export const config = { path: "/api/search" };
