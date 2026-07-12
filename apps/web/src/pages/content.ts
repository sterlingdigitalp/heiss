const articles: Record<string, { title: string; dek: string; body: string[] }> = {
  "iphone-farm-guide": {
    title: "How to build a real iPhone farm",
    dek: "A practical hardware and network checklist for an unattended social rack.",
    body: ["Start with one supported iPhone, an MFi-certified data cable, and a Mac that can remain awake during scheduled sessions.", "Use a powered USB hub as the rack grows. Label every cable and give each iPhone a stable name in Heiss.", "Keep one dedicated network identity per iPhone once you operate more than one device. Shared datacenter proxies are a poor substitute for a dedicated ISP, mobile, or SIM connection."],
  },
  "how-to-warm-up-a-tiktok-account": {
    title: "A phased TikTok account warmup",
    dek: "Why new accounts should browse before they publish.",
    body: ["Fresh accounts begin with passive scrolling and niche searches. Likes and follows ramp gradually over later daily sessions.", "Heiss blocks scheduled publishing until the account reaches its maturity threshold, then continues a lighter keep-warm routine around every post.", "No automation can guarantee reach or prevent enforcement. Clean network identity, useful content, and a sane cadence remain your responsibility."],
  },
  "run-multiple-tiktok-accounts": {
    title: "Run multiple TikTok accounts without double-posting",
    dek: "Device locks, time slots, and exactly-once content delivery.",
    body: ["Each account receives its own lifecycle, search terms, and posting slots. Device locks keep two sessions from controlling the same iPhone simultaneously.", "Cloud Drop tracks delivery per target account. A clip selected for eight accounts remains pending until all eight have completed or been explicitly cancelled.", "Publish is two-phase: the controller records an attempt before tapping and verifies the composer outcome after a connection loss instead of tapping twice."],
  },
  "tiktok-automation-mac": {
    title: "TikTok automation on a Mac with real iPhones",
    dek: "A local-first architecture without unofficial social APIs.",
    body: ["The Mac daemon owns schedules, checkpoints, and media. A signed XCTest runner performs visible actions in the real iOS apps.", "Accounts, devices, and the audit log stay on the Mac. The hosted dashboard only stages Cloud Drop media and mirrors the farm records needed for remote selection.", "Layout profiles are pulled separately from the app binary, so coordinates and bundle identifiers can be patched without rebuilding the desktop app."],
  },
  "account-warmup-tiktok-instagram": {
    title: "Account warmup for TikTok and Instagram",
    dek: "A four-phase ramp followed by daily maintenance.",
    body: ["Day one emphasizes browsing and search. Later phases introduce a small number of likes and follows while increasing feed dwell.", "Mature accounts keep receiving activity even when the content queue is empty. Posting sessions add a lighter engagement wrapper before and after publishing.", "Heiss records every completed action and retries failures with exponential backoff."],
  },
};

function shell(title: string, description: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Heiss</title><meta name="description" content="${description}"><style>:root{--lime:#cfff39;--ink:#f7f7ef;--muted:#a5a79a;--line:#2b2d24}*{box-sizing:border-box}body{margin:0;background:#050604;color:var(--ink);font-family:Inter,system-ui,sans-serif;line-height:1.7}a{color:var(--lime)}header{max-width:980px;margin:1rem auto;padding:.8rem 1rem;border:1px solid var(--line);border-radius:1rem;display:flex;justify-content:space-between;align-items:center}.brand{color:white;text-decoration:none;font-weight:850}.mark{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:7px;background:var(--lime);color:#111;margin-right:.5rem}nav a{color:var(--muted);text-decoration:none;margin-left:1rem}main{max-width:820px;margin:0 auto;padding:6rem 1.25rem}h1{font:400 clamp(3rem,8vw,5.8rem)/.98 Georgia,serif;letter-spacing:-.055em;margin:.5rem 0 1.2rem}h2{font:400 2rem Georgia,serif;margin-top:3rem}.dek{color:var(--muted);font-size:1.15rem;max-width:42rem}.card{background:#11120e;border:1px solid var(--line);border-radius:1rem;padding:1.25rem;margin:1rem 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem}.eyebrow{font:700 .72rem ui-monospace,monospace;letter-spacing:.17em;text-transform:uppercase;color:var(--lime)}footer{border-top:1px solid var(--line);padding:2rem;text-align:center;color:var(--muted)}</style></head><body><header><a class="brand" href="/"><span class="mark">H</span>Heiss</a><nav><a href="/blog.html">Blog</a><a href="/resources.html">Resources</a><a href="/app">Sign in</a></nav></header><main>${content}</main><footer>© 2026 Heiss · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></footer></body></html>`;
}

export function contentPage(pathname: string): string | null {
  if (pathname === "/privacy.html") return shell("Privacy", "How Heiss handles farm and Cloud Drop data.", `<div class="eyebrow">Legal</div><h1>Privacy policy</h1><p class="dek">Heiss is local-first. This policy explains what remains on your Mac and what the hosted dashboard stores.</p><h2>Local farm data</h2><p>Social credentials, device state, automation checkpoints, proxy credentials, and detailed activity remain in the farm data directory on your Mac. Heiss does not ask for social-platform passwords.</p><h2>Hosted account data</h2><p>The dashboard stores your email, salted password hash when password sign-in is used, subscription state, mirrored device/account labels, schedules, and queued media. Staged media is deleted after all selected accounts report completion or you cancel the queued item.</p><h2>Security and deletion</h2><p>Use TLS, an encrypted persistent volume, and a strong session secret in production. Contact the operator of your Heiss deployment to export or delete hosted account data.</p>`);
  if (pathname === "/terms.html") return shell("Terms", "Terms for using Heiss.", `<div class="eyebrow">Legal</div><h1>Terms of service</h1><p class="dek">You control the devices, accounts, networks, content, and policies governing your farm.</p><h2>Acceptable use</h2><p>Use Heiss only with accounts and devices you are authorized to operate. Do not use it for deception, harassment, spam, unlawful content, or to bypass platform safety systems.</p><h2>No outcome guarantee</h2><p>Heiss cannot guarantee reach, account health, uptime, or continued compatibility with third-party apps. Platform interfaces and enforcement change without notice.</p><h2>Your responsibility</h2><p>You are responsible for reviewing scheduled content, maintaining clean network identity, complying with platform terms, and protecting license, proxy, signing, and deployment secrets.</p>`);
  if (pathname === "/resources.html") return shell("Resources", "Hardware and setup resources for an iPhone farm.", `<div class="eyebrow">Operator library</div><h1>Build the farm once.</h1><p class="dek">The essentials for a reliable, owned iPhone rack.</p><div class="grid"><div class="card"><h2>Hardware</h2><p>iPhone XR minimum; iPhone 12 or newer recommended. Use MFi data cables and a powered hub for larger racks.</p></div><div class="card"><h2>Signing</h2><p>A free Apple ID signs the XCTest runner for seven days. A paid developer membership avoids weekly reinstall work.</p></div><div class="card"><h2>Networks</h2><p>Use one dedicated ISP, mobile, or SIM IP per iPhone when scaling beyond a single device.</p></div><div class="card"><h2>Operations</h2><p>Keep the Mac awake, enable automatic farm start, and watch failure screenshots when an app layout changes.</p></div></div>`);
  if (pathname === "/blog.html") {
    const cards = Object.entries(articles).map(([slug, article]) => `<a class="card" style="display:block;color:inherit;text-decoration:none" href="/blog/${slug}.html"><div class="eyebrow">Guide</div><h2>${article.title}</h2><p>${article.dek}</p></a>`).join("");
    return shell("Blog", "Practical guides for iPhone farms and account warmup.", `<div class="eyebrow">Field notes</div><h1>The iPhone farm manual.</h1><p class="dek">Practical guides for local-first social operations.</p><div class="grid">${cards}</div>`);
  }
  const match = pathname.match(/^\/blog\/([^/]+)\.html$/);
  const article = match ? articles[match[1]!] : undefined;
  if (article) return shell(article.title, article.dek, `<div class="eyebrow">Guide</div><h1>${article.title}</h1><p class="dek">${article.dek}</p>${article.body.map((paragraph) => `<p>${paragraph}</p>`).join("")}<p><a href="/app">Start your farm →</a></p>`);
  return null;
}
