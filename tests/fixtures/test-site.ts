import type { Server } from "node:http";
import { createServer } from "node:http";
import { once } from "node:events";

/**
 * Deterministic fixture website for e2e tests (replaces testing against a
 * live site that can change). Pure server-rendered HTML + GET forms — no
 * client JS, no external assets — so runs are hermetic and fast.
 *
 * Pages:
 * - `/`            home: nav (Home/Form/Products), hero, link to the form
 * - `/form`        order form: text input, select, checkbox, submit
 * - `/result`      echoes the submitted order in `#summary`
 * - `/products`    searchable list (`?q=` filters server-side)
 * - `/secure`      cookie-gated: `#welcome` only with a `session=ok` cookie
 */

const PRODUCTS = ["Apple", "Banana", "Cherry", "Date", "Elderberry"];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title></head><body>`,
    "<header><nav>",
    '<a href="/">Home</a> | <a href="/form">Form</a> | <a href="/products">Products</a>',
    "</nav></header><main>",
    body,
    "</main></body></html>",
  ].join("\n");
}

function homePage(): string {
  return shell(
    "TestMart",
    [
      "<h1>TestMart home</h1>",
      "<p>Your friendly fixture shop for end-to-end tests.</p>",
      '<a class="cta" href="/form">Order something</a>',
    ].join("\n"),
  );
}

function formPage(): string {
  return shell(
    "Order form",
    [
      "<h1>Order form</h1>",
      '<form id="order" method="GET" action="/result">',
      '<label for="name">Name</label><input id="name" name="name" type="text">',
      '<label for="color">Colour</label><select id="color" name="color">',
      '<option value="red">red</option><option value="green">green</option>',
      '<option value="blue">blue</option></select>',
      '<label><input id="terms" name="terms" type="checkbox" value="yes"> I agree</label>',
      '<button type="submit">Place order</button>',
      "</form>",
    ].join("\n"),
  );
}

function resultPage(params: URLSearchParams): string {
  const name = params.get("name") ?? "missing";
  const color = params.get("color") ?? "missing";
  const terms = params.get("terms") ?? "missing";
  return shell(
    "Order received",
    [
      "<h1>Order received</h1>",
      `<p id="summary">Thanks ${escapeHtml(name)} — ${escapeHtml(color)} (terms: ${escapeHtml(terms)})</p>`,
    ].join("\n"),
  );
}

function productsPage(params: URLSearchParams): string {
  const q = (params.get("q") ?? "").toLowerCase();
  const items = PRODUCTS.filter((p) => p.toLowerCase().includes(q));
  const rows = items.map((p) => `<li>${escapeHtml(p)}</li>`).join("\n");
  return shell(
    "Products",
    [
      "<h1>Products</h1>",
      '<form id="search" method="GET" action="/products">',
      `<label for="q">Search</label><input id="q" name="q" type="text" value="${escapeHtml(params.get("q") ?? "")}">`,
      '<button type="submit">Search</button>',
      "</form>",
      `<ul>${rows === "" ? "<li>Nothing found</li>" : rows}</ul>`,
    ].join("\n"),
  );
}

/**
 * Cookie-gated page (M14 e2e): the auth state file sets `session=ok`, so
 * providing it changes what this route renders.
 */
function securePage(cookieHeader: string | undefined): string {
  const signedIn = (cookieHeader ?? "").split(";").some((cookie) => cookie.trim() === "session=ok");
  if (signedIn) {
    return shell("Secure area", '<h1 id="welcome">Welcome back</h1>');
  }
  return shell("Sign in", '<h1 id="signin">Sign in</h1><p>Please log in to continue.</p>');
}

export interface TestSite {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestSite(): Promise<TestSite> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let status = 200;
    let body: string;
    switch (url.pathname) {
      case "/":
        body = homePage();
        break;
      case "/form":
        body = formPage();
        break;
      case "/result":
        body = resultPage(url.searchParams);
        break;
      case "/products":
        body = productsPage(url.searchParams);
        break;
      case "/secure":
        body = securePage(req.headers.cookie);
        break;
      default:
        status = 404;
        body = shell("Not found", "<h1>Not found</h1>");
        break;
    }
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server failed to bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
  };
}
