/**
 * Dummy income-tax portal for manual testing with PlayTest.
 *
 * Zero dependencies (node:http only). Run:
 *   node dummy-tax-site/server.js [--port 4137]
 *
 * Demo credentials (see README.md):
 *   email:    test@example.com
 *   password: password123
 *
 * All data is in-memory and resets on restart (or GET /__reset).
 * Every interactive element has a stable id + data-testid for recorder runs.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_PORT = 4137;

const DEMO_USER = {
  email: "test@example.com",
  password: "password123",
  fullName: "Aarav Sharma",
  pan: "ABCDE1234F",
  dob: "1990-04-15",
  phone: "9876543210",
  address: "221 MG Road, Bengaluru, Karnataka 560001",
};

const SEED_NOTICES = [
  {
    id: "ITR-2024-001",
    title: "Defective return — Section 139(9)",
    date: "2024-08-12",
    status: "Open",
    body: "Your return for AY 2024-25 is defective: Schedule 80C total does not match the claimed deduction. Please rectify within 15 days.",
  },
  {
    id: "ITR-2024-002",
    title: "Intimation — Section 143(1)",
    date: "2024-09-02",
    status: "Closed",
    body: "Your return for AY 2023-24 has been processed. Refund of Rs 4,200 has been issued to your bank account ending 4821.",
  },
  {
    id: "ITR-2025-003",
    title: "Scrutiny notice — Section 143(2)",
    date: "2025-01-20",
    status: "Open",
    body: "Your return for AY 2024-25 has been selected for limited scrutiny. Please submit bank statements for FY 2023-24.",
  },
];

function createState() {
  return {
    sessions: new Map(),
    profile: { ...DEMO_USER },
    filings: [],
    responses: new Map(),
  };
}

const state = createState();

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie).tax_session;
  if (!token) return null;
  return state.sessions.has(token) ? token : null;
}

function shell(title, body, active) {
  const nav = active
    ? `<nav data-testid="main-nav">
        <a data-testid="nav-dashboard" href="/dashboard">Dashboard</a>
        <a data-testid="nav-profile" href="/profile">Profile</a>
        <a data-testid="nav-file-return" href="/file-return">File Return</a>
        <a data-testid="nav-filings" href="/filings">My Filings</a>
        <a data-testid="nav-notices" href="/notices">Notices</a>
        <a data-testid="nav-logout" href="/logout">Logout</a>
      </nav>`
    : `<nav data-testid="main-nav"><a data-testid="nav-login" href="/login">Login</a></nav>`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — DummyTax</title>`,
    "<style>",
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f1f5f9;color:#0f172a}",
    "header{background:#1e3a8a;color:#fff;padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}",
    "header nav a{color:#dbeafe;margin-right:12px;text-decoration:none;font-weight:600}",
    ".stripe{height:6px;background:linear-gradient(90deg,#ff9933 33%,#fff 33% 66%,#138808 66%)}",
    ".banner{background:#fef3c7;color:#92400e;text-align:center;font-weight:700;padding:8px}",
    "main{max-width:860px;margin:24px auto;padding:0 16px 48px}",
    ".card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin:16px 0}",
    "label{display:block;margin:12px 0 4px;font-weight:600}",
    "input,select,textarea{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:6px;font-size:15px}",
    "button{background:#1e3a8a;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer;margin-top:14px}",
    "table{width:100%;border-collapse:collapse;margin-top:12px}",
    "th,td{border:1px solid #e2e8f0;padding:8px;text-align:left}",
    ".badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700}",
    ".open{background:#fee2e2;color:#991b1b}.closed{background:#dcfce7;color:#166534}",
    ".error{background:#fee2e2;color:#991b1b;padding:10px;border-radius:6px;margin:12px 0}",
    ".success{background:#dcfce7;color:#166534;padding:10px;border-radius:6px;margin:12px 0}",
    "</style></head><body>",
    '<div class="stripe"></div>',
    '<div class="banner" data-testid="dummy-banner">DUMMY PORTAL — FOR TESTING ONLY, NOT A GOVERNMENT SITE</div>',
    `<header><strong>DummyTax India</strong>${nav}</header>`,
    "<main>",
    body,
    "</main></body></html>",
  ].join("\n");
}

function landingPage() {
  return shell(
    "Home",
    [
      "<h1 data-testid='page-title'>Dummy Income Tax Portal</h1>",
      "<p>A fake tax-filing website for testing automation tools. No real data leaves your machine.</p>",
      '<div class="card"><h2>Demo login</h2><p>Email <code>test@example.com</code> / password <code>password123</code></p>',
      '<a data-testid="cta-login" href="/login"><button type="button">Go to login</button></a></div>',
    ].join("\n"),
    false,
  );
}

function loginPage(error) {
  return shell(
    "Login",
    [
      "<h1 data-testid='page-title'>Login</h1>",
      error
        ? `<p id="login-error" data-testid="login-error" class="error">${escapeHtml(error)}</p>`
        : "",
      '<form id="login-form" data-testid="login-form" method="POST" action="/login">',
      '<label for="email">Email</label><input id="email" data-testid="login-email" name="email" type="email" autocomplete="username">',
      '<label for="password">Password</label><input id="password" data-testid="login-password" name="password" type="password" autocomplete="current-password">',
      '<button type="submit" data-testid="login-submit">Sign in</button>',
      "</form>",
    ].join("\n"),
    false,
  );
}

function dashboardPage() {
  const open = SEED_NOTICES.filter((n) => n.status === "Open").length;
  return shell(
    "Dashboard",
    [
      `<h1 data-testid="page-title">Dashboard</h1><p id="welcome" data-testid="welcome">Welcome, ${escapeHtml(state.profile.fullName)} (${escapeHtml(state.profile.email)})</p>`,
      '<div class="card"><h2>Quick actions</h2>',
      '<p><a data-testid="cta-profile" href="/profile">View / edit profile</a></p>',
      '<p><a data-testid="cta-file-return" href="/file-return">File a new return (ITR-1)</a></p>',
      `<p><a data-testid="cta-notices" href="/notices">Notices <span class="badge open" data-testid="notice-count">${open} open</span></a></p>`,
      `<p>Returns filed this session: <strong data-testid="filing-count">${state.filings.length}</strong> (<a data-testid="cta-filings" href="/filings">history</a>)</p></div>`,
    ].join("\n"),
    true,
  );
}

function profilePage(saved) {
  const p = state.profile;
  return shell(
    "Profile",
    [
      "<h1 data-testid='page-title'>My Profile</h1>",
      saved
        ? '<p id="profile-saved" data-testid="profile-saved" class="success">Profile updated successfully.</p>'
        : "",
      '<form id="profile-form" data-testid="profile-form" method="POST" action="/profile">',
      `<label for="fullName">Full name</label><input id="fullName" data-testid="profile-name" name="fullName" type="text" value="${escapeHtml(p.fullName)}">`,
      `<label for="pan">PAN</label><input id="pan" data-testid="profile-pan" name="pan" type="text" value="${escapeHtml(p.pan)}">`,
      `<label for="dob">Date of birth</label><input id="dob" data-testid="profile-dob" name="dob" type="date" value="${escapeHtml(p.dob)}">`,
      `<label for="phone">Phone</label><input id="phone" data-testid="profile-phone" name="phone" type="tel" value="${escapeHtml(p.phone)}">`,
      `<label for="address">Address</label><textarea id="address" data-testid="profile-address" name="address" rows="3">${escapeHtml(p.address)}</textarea>`,
      '<button type="submit" data-testid="profile-save">Save profile</button>',
      "</form>",
    ].join("\n"),
    true,
  );
}

function fileReturnPage(error) {
  return shell(
    "File Return",
    [
      "<h1 data-testid='page-title'>File Return (ITR-1)</h1>",
      error
        ? `<p id="form-error" data-testid="form-error" class="error">${escapeHtml(error)}</p>`
        : "",
      '<form id="itr-form" data-testid="itr-form" method="POST" action="/file-return">',
      '<label for="assessmentYear">Assessment year</label><select id="assessmentYear" data-testid="itr-year" name="assessmentYear"><option value="2024-25">2024-25</option><option value="2025-26">2025-26</option></select>',
      `<label for="pan">PAN</label><input id="pan" data-testid="itr-pan" name="pan" type="text" value="${escapeHtml(state.profile.pan)}">`,
      '<label for="incomeSalary">Salary income (Rs)</label><input id="incomeSalary" data-testid="itr-salary" name="incomeSalary" type="number" min="0" value="850000">',
      '<label for="incomeOther">Other income (Rs)</label><input id="incomeOther" data-testid="itr-other" name="incomeOther" type="number" min="0" value="45000">',
      '<label for="deductions80C">Deductions 80C (Rs)</label><input id="deductions80C" data-testid="itr-80c" name="deductions80C" type="number" min="0" max="150000" value="120000">',
      '<label for="bankAccount">Bank account (for refund)</label><input id="bankAccount" data-testid="itr-bank" name="bankAccount" type="text" value="XXXX-XXXX-4821">',
      '<label><input id="verify" data-testid="itr-verify" name="verify" type="checkbox" value="yes" style="width:auto"> I verify this return is true and complete</label>',
      '<button type="submit" data-testid="itr-submit">Submit return</button>',
      "</form>",
    ].join("\n"),
    true,
  );
}

function filingSuccessPage(filing) {
  const rows = [
    ["Acknowledgement", filing.ack],
    ["Assessment year", filing.assessmentYear],
    ["PAN", filing.pan],
    ["Salary income", `Rs ${filing.incomeSalary}`],
    ["Other income", `Rs ${filing.incomeOther}`],
    ["Deductions 80C", `Rs ${filing.deductions80C}`],
    ["Taxable income", `Rs ${filing.taxable}`],
  ]
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join("\n");
  return shell(
    "Return filed",
    [
      "<h1 data-testid='page-title'>Return filed</h1>",
      `<p id="acknowledgement" data-testid="acknowledgement" class="success">Return submitted! Acknowledgement no: ${escapeHtml(filing.ack)}</p>`,
      `<table id="filing-summary" data-testid="filing-summary">${rows}</table>`,
      '<p><a data-testid="back-filings" href="/filings">View filing history</a></p>',
    ].join("\n"),
    true,
  );
}

function filingsPage() {
  const rows =
    state.filings.length === 0
      ? "<tr><td colspan='4'>No returns filed yet.</td></tr>"
      : state.filings
          .map(
            (f) =>
              `<tr data-testid="filing-row"><td>${escapeHtml(f.ack)}</td><td>${escapeHtml(f.assessmentYear)}</td><td>Rs ${escapeHtml(f.taxable)}</td><td>${escapeHtml(f.filedAt)}</td></tr>`,
          )
          .join("\n");
  return shell(
    "My Filings",
    [
      "<h1 data-testid='page-title'>My Filings</h1>",
      `<table id="filings-table" data-testid="filings-table"><thead><tr><th>Ack no</th><th>Year</th><th>Taxable</th><th>Filed at</th></tr></thead><tbody>${rows}</tbody></table>`,
      '<p><a data-testid="cta-file-new" href="/file-return">File a new return</a></p>',
    ].join("\n"),
    true,
  );
}

function noticesPage(filter) {
  const items = SEED_NOTICES.filter(
    (n) => !filter || n.status.toLowerCase() === filter.toLowerCase(),
  );
  const rows = items
    .map(
      (n) =>
        `<tr data-testid="notice-row"><td><a data-testid="notice-link-${n.id}" href="/notices/${n.id}">${escapeHtml(n.id)}</a></td>` +
        `<td>${escapeHtml(n.title)}</td><td>${escapeHtml(n.date)}</td>` +
        `<td><span class="badge ${n.status.toLowerCase()}" data-testid="notice-status-${n.id}">${n.status}</span></td></tr>`,
    )
    .join("\n");
  return shell(
    "Notices",
    [
      "<h1 data-testid='page-title'>Notices</h1>",
      '<form id="notice-filter" data-testid="notice-filter" method="GET" action="/notices">',
      '<label for="status">Filter by status</label><select id="status" data-testid="notice-filter-status" name="status"><option value="">All</option><option value="Open">Open</option><option value="Closed">Closed</option></select>',
      '<button type="submit" data-testid="notice-filter-submit">Apply</button></form>',
      `<table id="notices-table" data-testid="notices-table"><thead><tr><th>ID</th><th>Subject</th><th>Date</th><th>Status</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>No notices found.</td></tr>"}</tbody></table>`,
    ].join("\n"),
    true,
  );
}

function noticeDetailPage(notice, saved) {
  const response = state.responses.get(notice.id);
  return shell(
    notice.id,
    [
      `<h1 data-testid="page-title">${escapeHtml(notice.id)}</h1>`,
      `<h2 data-testid="notice-title">${escapeHtml(notice.title)}</h2>`,
      `<p data-testid="notice-meta">${escapeHtml(notice.date)} — <span class="badge ${notice.status.toLowerCase()}">${notice.status}</span></p>`,
      `<div class="card" data-testid="notice-body">${escapeHtml(notice.body)}</div>`,
      saved
        ? '<p id="response-saved" data-testid="response-saved" class="success">Response submitted successfully.</p>'
        : "",
      response
        ? `<div class="card"><h3>Your response</h3><p data-testid="notice-response">${escapeHtml(response)}</p></div>`
        : "",
      `<form id="respond-form" data-testid="respond-form" method="POST" action="/notices/${escapeHtml(notice.id)}/respond">`,
      '<label for="response">Your response</label><textarea id="response" data-testid="notice-response-input" name="response" rows="4" placeholder="Type your reply to the tax officer…"></textarea>',
      '<button type="submit" data-testid="notice-respond-submit">Submit response</button></form>',
      '<p><a data-testid="back-notices" href="/notices">Back to notices</a></p>',
    ].join("\n"),
    true,
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

function redirect(res, location, cookie) {
  const headers = { location };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

export function createDummyTaxServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    const authed = getSession(req) !== null;

    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "dummy-tax-site" }));
      return;
    }

    if (path === "/__reset") {
      const fresh = createState();
      state.sessions = fresh.sessions;
      state.profile = fresh.profile;
      state.filings = fresh.filings;
      state.responses = fresh.responses;
      send(
        res,
        200,
        shell("Reset", '<p id="reset-ok" data-testid="reset-ok">State has been reset.</p>', false),
      );
      return;
    }

    if (path === "/" && method === "GET") {
      send(res, 200, authed ? dashboardPage() : landingPage());
      return;
    }

    if (path === "/login" && method === "GET") {
      if (authed) {
        redirect(res, "/dashboard");
        return;
      }
      send(res, 200, loginPage(""));
      return;
    }

    if (path === "/login" && method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      const email = (params.get("email") ?? "").trim();
      const password = params.get("password") ?? "";
      if (email === DEMO_USER.email && password === DEMO_USER.password) {
        const token = randomUUID();
        state.sessions.set(token, { email, createdAt: new Date().toISOString() });
        redirect(res, "/dashboard", `tax_session=${token}; Path=/; HttpOnly`);
        return;
      }
      send(res, 401, loginPage("Invalid email or password. Hint: test@example.com / password123"));
      return;
    }

    if (path === "/logout") {
      const token = parseCookies(req.headers.cookie).tax_session;
      if (token) state.sessions.delete(token);
      redirect(res, "/", "tax_session=; Path=/; Max-Age=0");
      return;
    }

    if (!authed) {
      redirect(res, "/login");
      return;
    }

    if (path === "/dashboard" && method === "GET") {
      send(res, 200, dashboardPage());
      return;
    }

    if (path === "/profile" && method === "GET") {
      send(res, 200, profilePage(false));
      return;
    }

    if (path === "/profile" && method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      state.profile = {
        ...state.profile,
        fullName: params.get("fullName")?.trim() || state.profile.fullName,
        pan: params.get("pan")?.trim().toUpperCase() || state.profile.pan,
        dob: params.get("dob") || state.profile.dob,
        phone: params.get("phone")?.trim() || state.profile.phone,
        address: params.get("address")?.trim() || state.profile.address,
      };
      send(res, 200, profilePage(true));
      return;
    }

    if (path === "/file-return" && method === "GET") {
      send(res, 200, fileReturnPage(""));
      return;
    }

    if (path === "/file-return" && method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      const salary = Number(params.get("incomeSalary") ?? 0);
      const other = Number(params.get("incomeOther") ?? 0);
      const c80 = Number(params.get("deductions80C") ?? 0);
      if (!params.get("verify")) {
        send(res, 400, fileReturnPage("Please tick the verification checkbox before submitting."));
        return;
      }
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(params.get("pan") ?? "")) {
        send(
          res,
          400,
          fileReturnPage("PAN must look like ABCDE1234F (5 letters, 4 digits, 1 letter)."),
        );
        return;
      }
      const filing = {
        ack: `ACK${Date.now().toString().slice(-8)}${state.filings.length + 1}`,
        assessmentYear: params.get("assessmentYear") ?? "2024-25",
        pan: (params.get("pan") ?? "").toUpperCase(),
        incomeSalary: String(salary),
        incomeOther: String(other),
        deductions80C: String(c80),
        taxable: String(Math.max(0, salary + other - c80)),
        filedAt: new Date().toISOString().slice(0, 10),
      };
      state.filings.push(filing);
      redirect(res, `/filing-success?id=${encodeURIComponent(filing.ack)}`);
      return;
    }

    if (path === "/filing-success" && method === "GET") {
      const filing = state.filings.find((f) => f.ack === url.searchParams.get("id"));
      if (!filing) {
        send(res, 404, shell("Not found", "<h1> filing not found</h1>", true));
        return;
      }
      send(res, 200, filingSuccessPage(filing));
      return;
    }

    if (path === "/filings" && method === "GET") {
      send(res, 200, filingsPage());
      return;
    }

    if (path === "/notices" && method === "GET") {
      send(res, 200, noticesPage(url.searchParams.get("status") ?? ""));
      return;
    }

    const noticeMatch = path.match(/^\/notices\/([^/]+)(\/respond)?$/);
    if (noticeMatch) {
      const notice = SEED_NOTICES.find((n) => n.id === noticeMatch[1]);
      if (!notice) {
        send(res, 404, shell("Not found", "<h1>Notice not found</h1>", true));
        return;
      }
      if (noticeMatch[2] === "/respond" && method === "POST") {
        const params = new URLSearchParams(await readBody(req));
        const response = (params.get("response") ?? "").trim();
        if (!response) {
          send(res, 400, noticeDetailPage(notice, false));
          return;
        }
        state.responses.set(notice.id, response);
        send(res, 200, noticeDetailPage(notice, true));
        return;
      }
      if (method === "GET") {
        send(res, 200, noticeDetailPage(notice, false));
        return;
      }
    }

    send(res, 404, shell("Not found", "<h1>Not found</h1>", true));
  });
}

function parsePort(argv) {
  const idx = argv.indexOf("--port");
  if (idx !== -1 && argv[idx + 1]) {
    const port = Number(argv[idx + 1]);
    // 0 = ephemeral port (used by the e2e suite); the actual port is logged on boot.
    if (Number.isInteger(port) && port >= 0) return port;
  }
  return Number(process.env.PORT ?? DEFAULT_PORT);
}

const isMain = process.argv[1]?.endsWith("dummy-tax-site/server.js");
if (isMain) {
  const port = parsePort(process.argv);
  const server = createDummyTaxServer();
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use — another DummyTax instance may still be running.\n` +
          `Stop it (fuser -k ${port}/tcp) or pick another port: node dummy-tax-site/server.js --port 4140`,
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actual = typeof address === "object" && address !== null ? address.port : port;
    console.log(`DummyTax portal: http://127.0.0.1:${actual}`);
    console.log("Login: test@example.com / password123");
  });
}
