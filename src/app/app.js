/*
 * [HRVST] web app. Talks only to this server's /v1 API with the person's Cumulus ID token.
 * Builds every node with textContent, never innerHTML, so nothing a person typed can run.
 */
(() => {
  const PLACES = [
    ["street", "Street"],
    ["retail", "Shop"],
    ["field", "Field / outdoors"],
    ["public_building", "Public building"],
    ["private_residence", "Private residence (restricted)"],
    ["school", "School (restricted)"],
    ["hospital", "Hospital (restricted)"],
    ["military", "Military site (restricted)"],
    ["home_interior", "Home interior (restricted)"],
  ];
  const I18N = window.HRVST_I18N || { lang: "en", t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s) };
  const t = I18N.t;
  const placeName = (cls) => t((PLACES.find(([v]) => v === cls) || [cls, cls])[1]);
  const RESTRICTED = new Set(["private_residence", "school", "hospital", "military", "home_interior"]);
  const $ = (id) => document.getElementById(id);

  /** h("li", { class: "item" }, child, "text") */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  const chip = (text) => h("span", { class: "chip" }, text);
  const when = (iso) => new Date(iso).toLocaleString(I18N.lang === "ru" ? "ru-RU" : undefined);
  const fill = (list, items, empty) => list.replaceChildren(...(items.length ? items : [h("li", { class: "empty" }, empty)]));

  function status(text, isError) {
    const el = $("status");
    el.textContent = text || "";
    el.className = isError ? "status error" : "status";
  }

  async function api(path, body) {
    const token = window.CumulusID && window.CumulusID.token();
    if (!token) throw new Error(t("Please sign in again."));
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      window.CumulusID.signOut();
      throw new Error(t("Your sign-in ended. Please sign in again."));
    }
    if (!res.ok) throw new Error(data.error || t("Request failed ({status})", { status: res.status }));
    return data;
  }

  /** Run an action, report its outcome, then reload everything. */
  async function act(label, fn) {
    status(`${label}…`);
    try {
      const note = await fn();
      status(typeof note === "string" ? note : t("{label}: done.", { label }));
    } catch (e) {
      status(`${label}: ${e.message}`, true);
      return;
    }
    await load();
  }

  let me = null;
  let board = null;

  function renderSilo() {
    fill($("captures"), board.captures.slice().reverse().map((c) => {
      const restricted = RESTRICTED.has(c.placeClass);
      const optIn = h("input", { type: "checkbox" });
      const canRefine = c.status === "captured" || c.status === "excluded";
      return h("li", { class: "item" },
        h("p", {}, c.note),
        h("div", { class: "meta" }, chip(t(c.status)), chip(c.placeLabel), chip(placeName(c.placeClass)), c.redactions.length ? chip(t("removed: {list}", { list: c.redactions.join(", ") })) : null, when(c.capturedAt)),
        c.excludedReason ? h("p", { class: "muted" }, c.excludedReason) : null,
        canRefine ? h("div", { class: "actions" },
          restricted ? h("label", {}, h("span", {}, t("Opt in: share this restricted place")), optIn) : null,
          h("button", { type: "button", onclick: () => act(t("Refine"), () => api(`/v1/captures/${c.id}/refine`, { optedIn: restricted && optIn.checked })) }, t("Refine into a packet")),
        ) : null,
      );
    }), t("No captures yet."));

    const sales = salesByPacket();
    fill($("packets"), board.packets.slice().reverse().map((p) => {
      const sold = sales.get(p.id);
      const price = h("input", { type: "number", min: 1, max: 1000000, step: 1, value: p.priceCredits, "aria-label": t("Price in credits") });
      const live = p.status !== "retired";
      return h("li", { class: "item" },
        h("p", {}, p.observation),
        h("div", { class: "meta" }, chip(t(p.status)), chip(p.placeLabel), chip(t("quality {q}", { q: p.quality })), chip(t("{n} credits", { n: p.priceCredits })), chip(p.permittedUses.join(", ")), sold ? chip(t("sold {count}×, earned {n}", { count: sold.count, n: sold.earned })) : null),
        live ? h("div", { class: "actions" },
          p.status !== "private" ? h("button", { type: "button", onclick: () => act(t("Keep"), () => api(`/v1/packets/${p.id}/decide`, { action: "keep" })) }, t("Keep private")) : null,
          price,
          h("button", { type: "button", onclick: () => act(t("List"), () => api(`/v1/packets/${p.id}/decide`, { action: "list", priceCredits: Number(price.value) })) }, p.status === "listed" ? t("Update price") : t("List for sale")),
          p.status === "private" || p.status === "listed"
            ? h("button", { type: "button", onclick: () => act(t("Report to Architect"), () => api(`/v1/packets/${p.id}/signal`, {})) }, t("Report as a fault"))
            : null,
          h("button", {
            type: "button",
            onclick: () => confirm(t("Delete this packet? It leaves the market and cannot be listed again.")) && act(t("Delete"), () => api(`/v1/packets/${p.id}/decide`, { action: "delete" })),
          }, t("Delete")),
        ) : null,
      );
    }), t("No packets yet. Refine a capture to make one."));
  }

  async function renderMarket() {
    const f = new FormData($("market-filter"));
    const params = new URLSearchParams();
    for (const key of ["q", "maxPrice", "minQuality", "sort"]) {
      const value = String(f.get(key) || "").trim();
      if (value) params.set(key, value);
    }
    const query = params.toString();
    const listings = await api(`/v1/market${query ? `?${query}` : ""}`);
    const mine = new Set(board.packets.map((p) => p.id));
    const held = new Set(board.grants.filter((g) => g.licensee === me).map((g) => g.packetId));
    fill($("market"), listings.map((l) => h("li", { class: "item" },
      h("p", {}, `${l.placeLabel}`),
      h("div", { class: "meta" }, chip(t("quality {q}", { q: l.quality })), chip(l.permittedUses.join(", ")), chip(t("{n} credits", { n: l.priceCredits })), t("expires {when}", { when: when(l.expiresAt) })),
      h("div", { class: "actions" },
        mine.has(l.id) ? h("span", { class: "muted" }, t("Yours")) :
        held.has(l.id) ? h("span", { class: "muted" }, t("Bought")) :
        h("button", {
          type: "button",
          onclick: () => confirm(t("Buy a licence for {n} credits?", { n: l.priceCredits })) && act(t("Buy"), () => api(`/v1/packets/${l.id}/license`, {})),
        }, t("Buy for {n} credits", { n: l.priceCredits })),
      ),
    )), t("Nothing listed right now."));
  }

  function renderMissions() {
    const usable = board.packets.filter((p) => p.status === "private" || p.status === "listed");
    fill($("missions"), board.missions.slice().reverse().map((m) => {
      const mineAsBuyer = m.buyer === me;
      const mineAsClaimer = m.claimer === me;
      const actions = [];
      let preview = null;
      if (m.status === "open" && !mineAsBuyer) {
        actions.push(h("button", { type: "button", onclick: () => act(t("Claim"), () => api(`/v1/missions/${m.id}/claim`, {})) }, t("Claim")));
      }
      if (m.status === "claimed" && mineAsClaimer) {
        const pick = h("select", { "aria-label": t("Packet to submit") }, usable.map((p) => h("option", { value: p.id }, `${p.placeLabel}: ${p.observation.slice(0, 40)}`)));
        actions.push(
          usable.length ? pick : h("span", { class: "muted" }, t("Keep or list a packet first.")),
          h("button", { type: "button", disabled: !usable.length, onclick: () => act(t("Submit"), () => api(`/v1/missions/${m.id}/submit`, { packetId: pick.value })) }, t("Submit")),
          h("button", { type: "button", onclick: () => act(t("Release"), () => api(`/v1/missions/${m.id}/release`, {})) }, t("Give back")),
        );
      }
      if (mineAsBuyer && m.status === "submitted") {
        preview = h("div", { class: "meta" }, h("span", { class: "muted" }, t("Loading the submission…")));
        const box = preview;
        api(`/v1/missions/${m.id}/submission`).then((s) => box.replaceChildren(...[
          h("span", {}, t("Submitted:")), chip(s.placeLabel), chip(t("quality {q}", { q: s.quality })), chip(s.permittedUses.join(", ")), when(s.createdAt),
          s.rejectedBefore ? chip(t("you turned down {n} before", { n: s.rejectedBefore })) : null,
        ].filter(Boolean))).catch((e) => box.replaceChildren(h("span", { class: "muted" }, e.message)));
        actions.push(
          h("button", { type: "button", onclick: () => confirm(t("Accept and pay {n} credits?", { n: m.rewardCredits })) && act(t("Accept"), () => api(`/v1/missions/${m.id}/accept`, {})) }, t("Accept and pay")),
          h("button", { type: "button", onclick: () => act(t("Reject"), () => api(`/v1/missions/${m.id}/reject`, {})) }, t("Reject")),
        );
      }
      if (mineAsBuyer && (m.status === "open" || m.status === "claimed")) {
        actions.push(h("button", {
          type: "button",
          onclick: () => confirm(t("Cancel this mission and get the reward back?")) && act(t("Cancel"), () => api(`/v1/missions/${m.id}/cancel`, {})),
        }, t("Cancel")));
      }
      return h("li", { class: "item" },
        h("p", {}, m.title),
        m.brief ? h("p", { class: "muted" }, m.brief) : null,
        h("div", { class: "meta" }, chip(t(m.status)), chip(placeName(m.placeClass)), chip(t("{n} credits", { n: m.rewardCredits })), m.deadline ? chip(t("due {when}", { when: when(m.deadline) })) : null, mineAsBuyer ? chip(t("you posted")) : null, mineAsClaimer ? chip(t("you claimed")) : null),
        preview,
        actions.length ? h("div", { class: "actions" }, actions) : null,
      );
    }), t("No missions right now."));
  }

  function renderPurchases() {
    const mine = board.grants.filter((g) => g.licensee === me).reverse();
    fill($("purchases"), mine.map((g) => h("li", { class: "item" },
      h("div", { class: "meta" }, chip(t("{n} credits", { n: g.priceCredits })), chip(g.terms), when(g.issuedAt)),
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => openDelivery(g.id) }, t("Open"))),
    )), t("Nothing bought yet."));
  }

  async function openDelivery(grantId) {
    const box = $("delivery");
    try {
      const { grant, packet, check } = await api(`/v1/grants/${grantId}`);
      const badge = {
        verified: t("Proof checked: it matches the observation and links into the chain."),
        linked: t("Proof links into the chain. The contributor erased the original, so the text itself can no longer be rechecked."),
        broken: t("Proof check failed: the chain does not hold. Contact HRVST before relying on this data."),
      }[check] || "";
      box.replaceChildren(
        h("h3", {}, packet.placeLabel),
        h("p", {}, packet.observation),
        h("div", { class: "meta" }, chip(t("quality {q}", { q: packet.quality })), chip(grant.terms), t("captured {when}", { when: when(packet.createdAt) })),
        h("p", { class: "muted" }, t("Proof of perspective")),
        h("code", {}, packet.proof),
        badge ? h("p", { class: check === "broken" ? "proof-check broken" : "proof-check" }, badge) : null,
      );
      box.hidden = false;
    } catch (e) {
      status(e.message, true);
    }
  }

  /** Licences sold on this person's packets: how many, and what the contributor share came to. */
  function salesByPacket() {
    const own = new Set(board.packets.map((p) => p.id));
    const out = new Map();
    for (const g of board.grants) {
      if (!own.has(g.packetId)) continue;
      const s = out.get(g.packetId) || { count: 0, earned: 0 };
      s.count += 1;
      s.earned += g.contributorCredits;
      out.set(g.packetId, s);
    }
    return out;
  }

  function renderCredits() {
    $("balance").textContent = String(board.balances[me] ?? 0);
    const sales = [...salesByPacket().values()];
    const earned = sales.reduce((n, s) => n + s.earned, 0);
    const count = sales.reduce((n, s) => n + s.count, 0);
    $("earned").textContent = count ? t("Sales of your packets: {count}. Earned: {n} credits.", { n: earned, count }) : t("None of your packets has sold yet.");
    fill($("ledger"), board.ledger.slice().reverse().slice(0, 50).map((e) => h("li", { class: "item" },
      h("div", { class: "meta" }, h("span", { class: e.delta > 0 ? "delta-plus" : "" }, `${e.delta > 0 ? "+" : ""}${e.delta}`), e.reason, when(e.at)),
    )), t("No credit movements yet."));
  }

  async function load() {
    try {
      board = await api("/v1/board");
      renderSilo();
      renderMissions();
      renderPurchases();
      renderCredits();
      await renderMarket();
    } catch (e) {
      status(e.message, true);
    }
  }

  function showTab(name) {
    for (const b of document.querySelectorAll("[data-tab]")) {
      if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  }

  function setup() {
    $("capture-place").replaceChildren(...PLACES.map(([v, label]) => h("option", { value: v }, t(label))));
    $("mission-place").replaceChildren(...PLACES.filter(([v]) => !RESTRICTED.has(v)).map(([v, label]) => h("option", { value: v }, t(label))));
    for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));

    $("capture-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      act(t("Capture"), async () => {
        await api("/v1/captures", { note: f.get("note"), placeLabel: f.get("placeLabel"), placeClass: f.get("placeClass"), mediaKind: "note" });
        ev.target.reset();
      });
    });

    $("mission-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      act(t("Post mission"), async () => {
        const days = f.get("deadlineDays");
        await api("/v1/missions", {
          title: f.get("title"),
          brief: f.get("brief"),
          rewardCredits: Number(f.get("rewardCredits")),
          placeClass: f.get("placeClass"),
          ...(days ? { deadlineDays: Number(days) } : {}),
        });
        ev.target.reset();
      });
    });

    $("market-filter").addEventListener("submit", (ev) => {
      ev.preventDefault();
      renderMarket().catch((e) => status(e.message, true));
    });

    $("export").addEventListener("click", () => act(t("Download"), async () => {
      const data = await api("/v1/me/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = h("a", { href: url, download: "hrvst-export.json" });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }));

    $("erase").addEventListener("click", () => {
      const typed = prompt(t('This cannot be undone. Type "erase" to erase your HRVST data.'));
      if (typed !== "erase") return;
      act(t("Erase"), async () => {
        const done = await api("/v1/me/erase", { confirm: "erase" });
        return t("Erased {captures} captures and {packets} packets; {cancelled} missions cancelled, {released} given back.", { captures: done.captures, packets: done.packets, cancelled: done.missionsCancelled, released: done.missionsReleased });
      });
    });

    const signedIn = (profile) => {
      const next = profile && profile.cid ? profile.cid : null;
      if (next === me && board) return;
      me = next;
      board = null;
      $("signed-out").hidden = !!me;
      $("signed-in").hidden = !me;
      if (me) load();
    };
    window.addEventListener("cumulus-id", (ev) => signedIn(ev.detail));
    // The button script runs first and may already have announced who is signed in.
    if (window.CumulusID) signedIn(window.CumulusID.profile());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
