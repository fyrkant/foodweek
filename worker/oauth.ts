/**
 * The OAuth consent page: an MCP client (e.g. Claude) asks for access and
 * the household approves it with the app password.
 */

import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { safeEqual } from "./auth";

/** The whole household shares one account. */
export const OWNER_ID = "household";

const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(details: ConsentDescription, handle: string, query: string, error?: string): string {
  const name = esc(details.clientName);
  const origin = details.clientDomain
    ? `Publicerad av <strong>${esc(details.clientDomain)}</strong>.`
    : "Appen registrerade sig själv, så namnet är inte verifierat.";
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Ge ${name} åtkomst</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --text: #1b1f24; --muted: #6b7280; --line: #e3e6ea; --accent: #1f6feb; --red: #d92d20; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111318; --card: #1c1f26; --text: #e6e8eb; --muted: #9aa1ab; --line: #2c313a; --accent: #6aa4ff; --red: #ff7b6e; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; width: min(420px, 100%); }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; line-height: 1.45; }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .warn { color: var(--red); font-weight: 600; }
  label { display: block; font-weight: 600; font-size: 0.9rem; margin: 16px 0 6px; }
  input { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button { font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Ge ${name} åtkomst till veckans middagar?</h1>
  <p>${name} kan då läsa, planera, flytta och ta bort middagar och ändra maträtter.</p>
  <p class="muted">${origin} Åtkomsten skickas till <strong>${esc(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="warn">Åtkomsten skickas till en app på din dator. Fortsätt bara om du själv precis startade inloggningen därifrån.</p>' : ""}
  <form method="post">
    <input type="hidden" name="handle" value="${esc(handle)}">
    <input type="hidden" name="query" value="${esc(query)}">
    <label for="password">Lösenord till foodweek</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    ${error ? `<p class="warn" style="margin-top:8px">${esc(error)}</p>` : ""}
    <div class="actions">
      <button name="decision" value="deny">Neka</button>
      <button name="decision" value="approve" class="primary">Tillåt</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

async function renderConsent(oauth: OAuthHelpers, request: Request, error?: string): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(page(details, consent.handle, new URL(request.url).search, error), {
    status: error ? 401 : 200,
    headers: consent.headers,
  });
}

function errorPage(message: string): Response {
  return new Response(esc(message), {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function handleAuthorize(
  request: Request,
  oauth: OAuthHelpers,
  appPassword: string,
): Promise<Response> {
  try {
    if (request.method === "GET") return await renderConsent(oauth, request);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    if (!appPassword || !safeEqual(String(form.get("password") ?? ""), appPassword)) {
      // Slow down guessing, then show a fresh form for the same request.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const original = new URL(request.url);
      original.search = String(form.get("query") ?? "");
      return await renderConsent(oauth, new Request(original, { headers: request.headers }), "Fel lösenord");
    }

    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER_ID,
      metadata: {},
      scope: approved.request.scope,
      props: { userId: OWNER_ID },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return errorPage(`${error.description} Starta anslutningen igen från appen.`);
    }
    if (error instanceof CimdFetchError) return errorPage("Appen kunde inte verifieras.");
    throw error;
  }
}
