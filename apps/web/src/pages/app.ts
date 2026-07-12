/** Authenticated Cloud Drop + farm overview UI. */
export function appHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Heiss App · Cloud Drop</title>
  <style>
    :root {
      --bg: #0c0a09; --fg: #fafaf9; --muted: #a8a29e; --accent: #f97316;
      --card: #1c1917; --border: #292524;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
    header { display:flex; justify-content:space-between; align-items:center; padding:1rem 1.5rem; border-bottom:1px solid var(--border); }
    .logo { font-weight:700; color:var(--fg); text-decoration:none; }
    .logo span { color: var(--accent); }
    main { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 1rem; padding: 1.25rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
    h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
    label { display:block; font-size: 0.85rem; color: var(--muted); margin: 0.5rem 0 0.25rem; }
    input, select, textarea {
      width: 100%; background: #0c0a09; border: 1px solid var(--border); color: var(--fg);
      border-radius: 0.5rem; padding: 0.6rem 0.75rem; font: inherit;
    }
    button, .btn {
      background: var(--accent); color: #111; font-weight: 600; border: none; border-radius: 999px;
      padding: 0.55rem 1rem; cursor: pointer; font: inherit; margin-top: 0.75rem;
    }
    button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    @media (max-width:640px){ .row { grid-template-columns: 1fr; } }
    .muted { color: var(--muted); font-size: 0.9rem; }
    .chip {
      display:inline-block; border:1px solid var(--border); border-radius:999px; padding:0.2rem 0.6rem;
      margin: 0.2rem; font-size: 0.8rem; cursor: pointer; user-select: none;
    }
    .chip.on { border-color: var(--accent); background: #431407; color: #fdba74; }
    pre {
      background: #0c0a09; border: 1px solid var(--border); border-radius: 0.5rem;
      padding: 0.75rem; overflow: auto; font-size: 0.8rem; max-height: 280px;
    }
    .err { color: #f87171; }
    .ok { color: #4ade80; }
    .hidden { display: none; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--border); }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/">Heiss<span>.</span></a>
    <div>
      <a href="/" class="muted" style="margin-right:1rem">Marketing</a>
      <span id="userLabel" class="muted">Signed out</span>
      <button class="secondary" id="logoutBtn" type="button" style="margin-left:0.5rem">Log out</button>
    </div>
  </header>
  <main>
    <div id="authPanel" class="card">
      <h1>Sign in</h1>
      <p class="muted">Cloud Drop requires an account. Free — no card.</p>
      <div class="row">
        <div>
          <label>Email</label>
          <input id="email" type="email" placeholder="you@company.com" />
        </div>
        <div>
          <label>Password</label>
          <input id="password" type="password" placeholder="••••••••" />
        </div>
      </div>
      <button type="button" id="signupBtn">Sign up</button>
      <button type="button" class="secondary" id="loginBtn">Log in</button>
      <p id="authMsg" class="muted"></p>
    </div>

    <div id="appPanel" class="hidden">
      <div class="card">
        <h1>Cloud Drop</h1>
        <p class="muted">Drop a clip. Your local farm runner claims it and posts on the next open slot.</p>
        <label>Caption</label>
        <textarea id="caption" rows="2" placeholder="Ship in public…"></textarea>
        <div class="row">
          <div>
            <label>Media ref (URL or path)</label>
            <input id="mediaRef" value="https://cdn.example/clip.mp4" />
          </div>
          <div>
            <label>Music (optional)</label>
            <input id="music" placeholder="track name" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>Kind</label>
            <select id="kind">
              <option value="video">Video</option>
              <option value="carousel">Carousel</option>
            </select>
          </div>
        </div>
        <label>Target accounts</label>
        <div id="accountChips"></div>
        <button type="button" id="dropBtn">Drop to queue</button>
        <p id="dropMsg"></p>
        <pre id="dropResult" class="hidden"></pre>
      </div>

      <div class="card">
        <h2>Farm overview</h2>
        <button type="button" class="secondary" id="refreshBtn">Refresh</button>
        <div id="overview"></div>
      </div>
    </div>
  </main>
  <script>
    const state = { token: localStorage.getItem("heiss_token") || "", accounts: [], selected: new Set() };

    function headers() {
      const h = { "Content-Type": "application/json" };
      if (state.token) h.Authorization = "Bearer " + state.token;
      return h;
    }

    async function api(path, opts = {}) {
      const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function showApp(email) {
      document.getElementById("authPanel").classList.add("hidden");
      document.getElementById("appPanel").classList.remove("hidden");
      document.getElementById("userLabel").textContent = email || "Signed in";
    }

    function showAuth() {
      document.getElementById("authPanel").classList.remove("hidden");
      document.getElementById("appPanel").classList.add("hidden");
      document.getElementById("userLabel").textContent = "Signed out";
    }

    async function auth(mode) {
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      const msg = document.getElementById("authMsg");
      try {
        const data = await api("/api/" + mode, {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        state.token = data.token;
        localStorage.setItem("heiss_token", state.token);
        msg.innerHTML = '<span class="ok">OK</span>';
        showApp(data.user.email);
        await loadOverview();
      } catch (e) {
        msg.innerHTML = '<span class="err">' + e.message + '</span>';
      }
    }

    function renderChips() {
      const el = document.getElementById("accountChips");
      el.innerHTML = state.accounts.map(a => {
        const on = state.selected.has(a.id) ? " on" : "";
        return '<span class="chip' + on + '" data-id="' + a.id + '">' + a.handle + ' · ' + a.platform + ' · ' + a.stage + '</span>';
      }).join("");
      el.querySelectorAll(".chip").forEach(chip => {
        chip.addEventListener("click", () => {
          const id = chip.getAttribute("data-id");
          if (state.selected.has(id)) state.selected.delete(id);
          else state.selected.add(id);
          renderChips();
        });
      });
    }

    async function loadOverview() {
      const data = await api("/api/overview");
      state.accounts = data.accounts || [];
      if (state.selected.size === 0) {
        state.accounts.filter(a => a.stage !== "fresh" && (a.platform === "tiktok" || a.platform === "instagram"))
          .forEach(a => state.selected.add(a.id));
      }
      renderChips();
      const rows = (data.accounts || []).map(a =>
        "<tr><td>" + a.handle + "</td><td>" + a.platform + "</td><td>" + a.stage + "</td><td>" + a.trustScore + "</td></tr>"
      ).join("");
      const q = (data.queue || []).map(q =>
        "<tr><td>" + q.id.slice(0,8) + "</td><td>" + q.status + "</td><td>" + (q.accountIds||[]).join(", ") + "</td></tr>"
      ).join("");
      document.getElementById("overview").innerHTML =
        "<h3>Accounts</h3><table><tr><th>Handle</th><th>Platform</th><th>Stage</th><th>Trust</th></tr>" + rows + "</table>" +
        "<h3 style='margin-top:1rem'>Queue</h3><table><tr><th>ID</th><th>Status</th><th>Accounts</th></tr>" + q + "</table>";
    }

    document.getElementById("signupBtn").onclick = () => auth("signup");
    document.getElementById("loginBtn").onclick = () => auth("login");
    document.getElementById("logoutBtn").onclick = () => {
      state.token = "";
      localStorage.removeItem("heiss_token");
      showAuth();
    };
    document.getElementById("refreshBtn").onclick = () => loadOverview().catch(e => alert(e.message));
    document.getElementById("dropBtn").onclick = async () => {
      const msg = document.getElementById("dropMsg");
      const pre = document.getElementById("dropResult");
      try {
        const kind = document.getElementById("kind").value;
        const mediaRef = document.getElementById("mediaRef").value;
        const body = {
          kind,
          mediaRef,
          caption: document.getElementById("caption").value,
          music: document.getElementById("music").value || undefined,
          accountIds: [...state.selected],
          slides: kind === "carousel" ? [mediaRef, mediaRef + "-2"] : undefined,
        };
        const data = await api("/api/drop", { method: "POST", body: JSON.stringify(body) });
        msg.innerHTML = '<span class="ok">Queued · claimable by runner</span>';
        pre.classList.remove("hidden");
        pre.textContent = JSON.stringify(data, null, 2);
        await loadOverview();
      } catch (e) {
        msg.innerHTML = '<span class="err">' + e.message + '</span>';
      }
    };

    (async () => {
      if (!state.token) { showAuth(); return; }
      try {
        const me = await api("/api/me");
        showApp(me.user.email);
        await loadOverview();
      } catch {
        showAuth();
      }
    })();
  </script>
</body>
</html>`;
}
