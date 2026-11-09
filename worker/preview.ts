/**
 * Recipe link previews: title and image from the recipe page, preferring
 * schema.org Recipe data (JSON-LD), then Open Graph / Twitter tags, then
 * <title>. Requests to private addresses are blocked by the
 * global_fetch_strictly_public compatibility flag.
 */

export interface RecipePreview {
  title: string | null;
  image: string | null;
}

const MAX_BYTES = 1_500_000;
const MAX_TITLE = 300;
const MAX_IMAGE_URL = 2000;

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  aring: "å", auml: "ä", ouml: "ö", Aring: "Å", Auml: "Ä", Ouml: "Ö",
  eacute: "é", egrave: "è", uuml: "ü", Uuml: "Ü", oslash: "ø", aelig: "æ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (entity, name) => NAMED_ENTITIES[name] ?? entity)
    .replace(/&amp;/g, "&");
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = decodeEntities(value).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, MAX_TITLE) : null;
}

function absoluteImage(value: unknown, base: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const href = url.toString();
    return href.length <= MAX_IMAGE_URL ? href : null;
  } catch {
    return null;
  }
}

/** schema.org image: a URL, an ImageObject, or a list of either. */
function schemaImage(value: unknown): unknown {
  if (Array.isArray(value)) return schemaImage(value[0]);
  if (value && typeof value === "object") return (value as { url?: unknown }).url;
  return value;
}

function isRecipe(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  return type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
}

/** Finds a Recipe in a JSON-LD document (top level, a list, or @graph). */
function findRecipe(data: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipe(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const node = data as Record<string, unknown>;
  if (isRecipe(node)) return node;
  return findRecipe(node["@graph"]);
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (bytes < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

export async function fetchRecipePreview(url: string): Promise<RecipePreview> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "sv,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; foodweek-preview/1.0)",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!(response.headers.get("Content-Type") ?? "").includes("html")) return { title: null, image: null };

  const base = response.url || url;
  const html = await readCapped(response);
  const meta: Record<string, string> = {};
  const jsonLd: string[] = [];
  let pageTitle = "";
  let currentLd: string | null = null;

  await new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
        const content = el.getAttribute("content");
        if (key && content && !(key in meta)) meta[key] = content;
      },
    })
    .on("title", {
      text(chunk) {
        pageTitle += chunk.text;
      },
    })
    .on('script[type="application/ld+json"]', {
      element(el) {
        currentLd = "";
        el.onEndTag(() => {
          if (currentLd) jsonLd.push(currentLd);
          currentLd = null;
        });
      },
      text(chunk) {
        if (currentLd !== null) currentLd += chunk.text;
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html" } }))
    .arrayBuffer();

  let recipe: Record<string, unknown> | undefined;
  for (const block of jsonLd) {
    try {
      recipe = findRecipe(JSON.parse(block));
    } catch {
      /* invalid JSON-LD; ignore */
    }
    if (recipe) break;
  }

  return {
    title:
      cleanTitle(recipe?.name) ??
      cleanTitle(meta["og:title"]) ??
      cleanTitle(meta["twitter:title"]) ??
      cleanTitle(pageTitle),
    image:
      absoluteImage(schemaImage(recipe?.image), base) ??
      absoluteImage(meta["og:image"], base) ??
      absoluteImage(meta["og:image:url"], base) ??
      absoluteImage(meta["twitter:image"], base),
  };
}

/**
 * Fetches and stores the preview for a dish. The UPDATE only applies if
 * the link is unchanged, so a slow fetch can't overwrite a newer link.
 * Returns true when a preview was found and stored.
 */
export async function refreshDishPreview(db: D1Database, dishId: string): Promise<boolean> {
  const dish = await db
    .prepare("SELECT recipe_url FROM dishes WHERE id = ?")
    .bind(dishId)
    .first<{ recipe_url: string | null }>();
  if (!dish?.recipe_url) return false;

  let preview: RecipePreview = { title: null, image: null };
  try {
    preview = await fetchRecipePreview(dish.recipe_url);
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "recipe_preview_failed",
        dishId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  const result = await db
    .prepare(
      `UPDATE dishes SET recipe_title = ?, recipe_image = ?, recipe_checked_at = datetime('now')
       WHERE id = ? AND recipe_url = ?`,
    )
    .bind(preview.title, preview.image, dishId, dish.recipe_url)
    .run();
  return result.meta.changes > 0 && Boolean(preview.title || preview.image);
}
