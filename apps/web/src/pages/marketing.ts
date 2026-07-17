/** Warmr-style marketing landing for Heiss. */
export function marketingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Heiss · Run your socials on autopilot</title>
  <style>
    :root {
      --bg: #050604;
      --fg: #f7f7ef;
      --muted: #a5a79a;
      --accent: #cfff39;
      --card: #11120e;
      --border: #2b2d24;
      --good: #4ade80;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.55;
    }
    a { color: var(--accent); text-decoration: none; }
    header {
      display: flex; justify-content: space-between; align-items: center;
      max-width: 980px; margin: 1rem auto 0; padding: .8rem 1rem; border: 1px solid var(--border);
      border-radius: 1rem; background: rgba(10,11,8,.88); position: sticky; top: 1rem; z-index: 5;
    }
    .logo { font-weight: 700; letter-spacing: -0.03em; font-size: 1.25rem; color: var(--fg); }
    .logo span { color: var(--accent); }
    nav a { margin-left: 1.25rem; color: var(--muted); }
    nav a:hover { color: var(--fg); }
    .btn {
      display: inline-block; background: var(--accent); color: #111; font-weight: 600;
      padding: 0.7rem 1.2rem; border-radius: 999px; border: none; cursor: pointer;
    }
    .btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
    .hero {
      max-width: 1040px; margin: 0 auto; padding: 8rem 1.5rem 5rem; text-align: center;
    }
    .hero .eyebrow { color: var(--accent); font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; }
    h1 { font-family: Georgia, serif; font-weight: 400; font-size: clamp(3.6rem, 8vw, 6.8rem); line-height: .94; letter-spacing: -0.06em; margin: 1rem 0 1.5rem; }
    h1 em { font-weight: 400; color: var(--accent); }
    .lead { color: var(--muted); font-size: 1.15rem; max-width: 40rem; margin: 0 auto 2rem; }
    .stats { display: flex; gap: 2rem; justify-content: center; flex-wrap: wrap; margin: 2.5rem 0; }
    .stat strong { display: block; font-size: 1.75rem; }
    .stat span { color: var(--muted); font-size: 0.9rem; }
    section { max-width: 1000px; margin: 0 auto; padding: 3rem 1.5rem; }
    h2 { font-family: Georgia, serif; font-weight: 400; font-size: clamp(2.2rem,5vw,3.8rem); letter-spacing: -0.05em; }
    h2 em { color: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
    .card {
      background: var(--card); border: 1px solid var(--border); border-radius: 1rem; padding: 1.25rem;
    }
    .card h3 { margin-top: 0; font-size: 1.05rem; }
    .card p { color: var(--muted); font-size: 0.95rem; }
    ol.lifecycle { list-style: none; padding: 0; display: grid; gap: 0.75rem; }
    ol.lifecycle li {
      display: grid; grid-template-columns: 2.5rem 1fr; gap: 0.75rem; align-items: start;
      background: var(--card); border: 1px solid var(--border); border-radius: 0.85rem; padding: 1rem;
    }
    .num {
      width: 2.5rem; height: 2.5rem; border-radius: 999px; background: #431407; color: var(--accent);
      display: grid; place-items: center; font-weight: 700;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { border-bottom: 1px solid var(--border); padding: 0.65rem 0.5rem; text-align: left; }
    th { color: var(--muted); font-weight: 500; }
    .price-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
    .price { position: relative; }
    .price.popular { border-color: var(--accent); }
    .price .tag {
      position: absolute; top: -0.6rem; right: 1rem; background: var(--accent); color: #111;
      font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 999px;
    }
    .price ul { padding-left: 1.1rem; color: var(--muted); font-size: 0.9rem; }
    .price .amt { font-size: 1.8rem; font-weight: 700; }
    footer {
      border-top: 1px solid var(--border); padding: 2rem; text-align: center; color: var(--muted); font-size: 0.9rem;
    }
    .check { color: var(--good); }
    .x { color: #f87171; }
    details { border-top:1px solid var(--border); padding:1rem 0; }
    summary { cursor:pointer; font-weight:700; }
    details p { color:var(--muted); max-width:52rem; }
    @media(max-width:720px){header{margin:.5rem}.hero{padding-top:5rem}nav a:not(.btn){display:none}}
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/">Heiss<span>.</span></a>
    <nav>
      <a href="#how">How it works</a>
      <a href="#lifecycle">Lifecycle</a>
      <a href="#pricing">Pricing</a>
      <a href="/blog.html">Blog</a>
      <a href="/resources.html">Resources</a>
      <a class="btn" href="/app">Open app →</a>
    </nav>
  </header>

  <main>
    <div class="hero">
      <div class="eyebrow">★ For the one-person company</div>
      <h1>Your iPhone farm,<br/><em>on autopilot.</em></h1>
      <p class="lead">
        Plug in iPhones and Heiss takes any account — even brand-new ones — from cold to consistently posting.
        Warms them up, keeps them healthy, and auto-posts to <strong>TikTok, Instagram, and X</strong> on schedule.
        YouTube stays warm.
      </p>
      <a class="btn" href="/app">Try Heiss free →</a>
      <a class="btn ghost" href="#how" style="margin-left:0.5rem">See how it works</a>
      <div class="stats">
        <div class="stat"><strong>3</strong><span>posting platforms</span></div>
        <div class="stat"><strong>24/7</strong><span>runs while you sleep</span></div>
        <div class="stat"><strong>8</strong><span>accounts per platform / phone</span></div>
      </div>
    </div>

    <section id="how">
      <h2>How the farm <em>actually works.</em></h2>
      <div class="grid">
        <div class="card">
          <h3>Acts like a real person</h3>
          <p>No unofficial APIs. No bots. No emulators. Drives real devices with human-like taps so platforms can't tell it from you.</p>
        </div>
        <div class="card">
          <h3>One Mac, whole farm</h3>
          <p>One controller drives multiple iPhones with locks so nothing double-posts. Scale by plugging in more phones.</p>
        </div>
        <div class="card">
          <h3>Every account warms first</h3>
          <p>Scroll, like, follow, search — before any post. Content lands with reach instead of dying cold.</p>
        </div>
        <div class="card">
          <h3>Cloud Drop</h3>
          <p>Drop a clip from phone or laptop. Your Mac claims it and posts to every account you picked on the next open slot.</p>
        </div>
      </div>
    </section>

    <section id="lifecycle">
      <h2>From a fresh account to <em>posting.</em></h2>
      <ol class="lifecycle">
        <li><div class="num">1</div><div><strong>Fresh</strong><p style="margin:0;color:var(--muted)">Brand-new login. No posting yet.</p></div></li>
        <li><div class="num">2</div><div><strong>Warmed up</strong><p style="margin:0;color:var(--muted)">Scrolls, likes, follows, searches daily.</p></div></li>
        <li><div class="num">3</div><div><strong>Matured</strong><p style="margin:0;color:var(--muted)">Ready to post, not flagged.</p></div></li>
        <li><div class="num">4</div><div><strong>Kept warm</strong><p style="margin:0;color:var(--muted)">Stays healthy for months.</p></div></li>
        <li><div class="num">5</div><div><strong>Posting</strong><p style="margin:0;color:var(--muted)">Every post pre-warm + post-warm wrapped.</p></div></li>
      </ol>
    </section>

    <section>
      <h2>Why not manual, bots, or <em>rented farms.</em></h2>
      <div class="card" style="overflow-x:auto">
        <table>
          <thead>
            <tr><th></th><th>Manual</th><th>API bots</th><th>Rented farms</th><th>Heiss</th></tr>
          </thead>
          <tbody>
            <tr><td>Devices</td><td>your phone</td><td>emulated</td><td>cloud phones</td><td>real iPhones you own</td></tr>
            <tr><td>Shadowban risk</td><td>Low</td><td>High</td><td>High</td><td>Low</td></tr>
            <tr><td>Warm-up</td><td>by hand</td><td>none</td><td>opaque</td><td>built-in fresh → matured</td></tr>
            <tr><td>Crash recovery</td><td>start over</td><td>none</td><td>ticket</td><td>auto-resume</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="pricing">
      <h2>Pick your <em>farm.</em></h2>
      <div class="price-grid">
        <div class="card price">
          <h3>Free</h3>
          <div class="amt">$0</div>
          <ul>
            <li>Shadowban-safe warmups</li>
            <li>TikTok, Instagram, X, YouTube</li>
            <li>1 iPhone · 500 MB Cloud Drop</li>
          </ul>
          <a class="btn" href="/app">Get started →</a>
        </div>
        <div class="card price">
          <h3>Solo</h3>
          <div class="amt">$40<span style="font-size:0.9rem;color:var(--muted)">/mo</span></div>
          <ul>
            <li>Auto-posts + carousels + music</li>
            <li>1 iPhone · 8 accounts · 5 GB</li>
          </ul>
          <a class="btn ghost" href="/app">Get Solo</a>
        </div>
        <div class="card price popular">
          <span class="tag">Most popular</span>
          <h3>Rack</h3>
          <div class="amt">$80<span style="font-size:0.9rem;color:var(--muted)">/mo</span></div>
          <ul>
            <li>3 iPhones · 24 accounts · 20 GB</li>
            <li>Post from anywhere</li>
          </ul>
          <a class="btn" href="/app">Get Rack</a>
        </div>
        <div class="card price">
          <h3>Scale</h3>
          <div class="amt">$150<span style="font-size:0.9rem;color:var(--muted)">/mo</span></div>
          <ul>
            <li>Unlimited phones & accounts</li>
            <li>Unlimited Cloud Drop</li>
          </ul>
          <a class="btn ghost" href="/app">Get Scale</a>
        </div>
      </div>
      <p style="color:var(--muted);font-size:0.85rem;margin-top:1rem">Billing modeled only — no live payment processor in this clone.</p>
    </section>

    <section id="faq">
      <h2>Before you <em>start.</em></h2>
      <details><summary>Can a brand-new account post immediately?</summary><p>No. Heiss gates fresh accounts and runs a phased scroll, like, follow, and search routine until they mature enough to join the posting rotation.</p></details>
      <details><summary>What happens if an iPhone or app stalls?</summary><p>Runs checkpoint after every action. The controller resumes from the unfinished step and refuses to publish the same queue item twice.</p></details>
      <details><summary>Where does my data live?</summary><p>Devices, accounts, schedules, credentials, and activity stay on your Mac. Cloud Drop only stages content long enough for your local controller to claim it.</p></details>
      <details><summary>Do I need a proxy?</summary><p>One or two accounts on one iPhone can use a normal home connection. Larger farms should assign one dedicated SOCKS5 or mobile IP to each iPhone.</p></details>
    </section>

    <section>
      <h2>The farm posts. You <em>build.</em></h2>
      <p class="lead" style="margin:0 0 1.5rem;text-align:left;max-width:none">
        Free trial modeled in-app. Install the local controller, seed a sim farm, Cloud Drop a clip, press run.
      </p>
      <a class="btn" href="/app">Open Cloud Drop →</a>
    </section>
  </main>

  <footer>
    Heiss · <a href="/app">App</a> · <a href="/blog.html">Blog</a> · <a href="/resources.html">Resources</a> · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a>
  </footer>
</body>
</html>`;
}
