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
  const when = (iso) => new Date(iso).toLocaleString();
  const fill = (list, items, empty) => list.replaceChildren(...(items.length ? items : [h("li", { class: "empty" }, empty)]));

  function status(text, isError) {
    const el = $("status");
    el.textContent = text || "";
    el.className = isError ? "status error" : "status";
  }

  async function api(path, body) {
    const token = window.CumulusID && window.CumulusID.token();
    if (!token) throw new Error("Please sign in again.");
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      window.CumulusID.signOut();
      throw new Error("Your sign-in ended. Please sign in again.");
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /** Run an action, report its outcome, then reload everything. */
  async function act(label, fn) {
    status(`${label}…`);
    try {
      await fn();
      status(`${label}: done.`);
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
        h("div", { class: "meta" }, chip(c.status), chip(c.placeLabel), chip(c.placeClass), c.redactions.length ? chip(`removed: ${c.redactions.join(", ")}`) : null, when(c.capturedAt)),
        c.excludedReason ? h("p", { class: "muted" }, c.excludedReason) : null,
        canRefine ? h("div", { class: "actions" },
          restricted ? h("label", {}, h("span", {}, "Opt in: share this restricted place"), optIn) : null,
          h("button", { type: "button", onclick: () => act("Refine", () => api(`/v1/captures/${c.id}/refine`, { optedIn: restricted && optIn.checked })) }, "Refine into a packet"),
        ) : null,
      );
    }), "No captures yet.");

    fill($("packets"), board.packets.slice().reverse().map((p) => {
      const price = h("input", { type: "number", min: 1, max: 1000000, step: 1, value: p.priceCredits, "aria-label": "Price in credits" });
      const live = p.status !== "retired";
      return h("li", { class: "item" },
        h("p", {}, p.observation),
        h("div", { class: "meta" }, chip(p.status), chip(p.placeLabel), chip(`quality ${p.quality}`), chip(`${p.priceCredits} credits`), chip(p.permittedUses.join(", "))),
        live ? h("div", { class: "actions" },
          p.status !== "private" ? h("button", { type: "button", onclick: () => act("Keep", () => api(`/v1/packets/${p.id}/decide`, { action: "keep" })) }, "Keep private") : null,
          price,
          h("button", { type: "button", onclick: () => act("List", () => api(`/v1/packets/${p.id}/decide`, { action: "list", priceCredits: Number(price.value) })) }, p.status === "listed" ? "Update price" : "List for sale"),
          p.status === "private" || p.status === "listed"
            ? h("button", { type: "button", onclick: () => act("Report to Architect", () => api(`/v1/packets/${p.id}/signal`, {})) }, "Report as a fault")
            : null,
          h("button", {
            type: "button",
            onclick: () => confirm("Delete this packet? It leaves the market and cannot be listed again.") && act("Delete", () => api(`/v1/packets/${p.id}/decide`, { action: "delete" })),
          }, "Delete"),
        ) : null,
      );
    }), "No packets yet. Refine a capture to make one.");
  }

  async function renderMarket() {
    const listings = await api("/v1/market");
    const mine = new Set(board.packets.map((p) => p.id));
    const held = new Set(board.grants.filter((g) => g.licensee === me).map((g) => g.packetId));
    fill($("market"), listings.map((l) => h("li", { class: "item" },
      h("p", {}, `${l.placeLabel}`),
      h("div", { class: "meta" }, chip(`quality ${l.quality}`), chip(l.permittedUses.join(", ")), chip(`${l.priceCredits} credits`), `expires ${when(l.expiresAt)}`),
      h("div", { class: "actions" },
        mine.has(l.id) ? h("span", { class: "muted" }, "Yours") :
        held.has(l.id) ? h("span", { class: "muted" }, "Bought") :
        h("button", {
          type: "button",
          onclick: () => confirm(`Buy a licence for ${l.priceCredits} credits?`) && act("Buy", () => api(`/v1/packets/${l.id}/license`, {})),
        }, `Buy for ${l.priceCredits} credits`),
      ),
    )), "Nothing listed right now.");
  }

  function renderMissions() {
    const usable = board.packets.filter((p) => p.status === "private" || p.status === "listed");
    fill($("missions"), board.missions.slice().reverse().map((m) => {
      const mineAsBuyer = m.buyer === me;
      const mineAsClaimer = m.claimer === me;
      const actions = [];
      if (m.status === "open" && !mineAsBuyer) {
        actions.push(h("button", { type: "button", onclick: () => act("Claim", () => api(`/v1/missions/${m.id}/claim`, {})) }, "Claim"));
      }
      if (m.status === "claimed" && mineAsClaimer) {
        const pick = h("select", { "aria-label": "Packet to submit" }, usable.map((p) => h("option", { value: p.id }, `${p.placeLabel}: ${p.observation.slice(0, 40)}`)));
        actions.push(
          usable.length ? pick : h("span", { class: "muted" }, "Keep or list a packet first."),
          h("button", { type: "button", disabled: !usable.length, onclick: () => act("Submit", () => api(`/v1/missions/${m.id}/submit`, { packetId: pick.value })) }, "Submit"),
          h("button", { type: "button", onclick: () => act("Release", () => api(`/v1/missions/${m.id}/release`, {})) }, "Give back"),
        );
      }
      if (mineAsBuyer && m.status === "submitted") {
        actions.push(
          h("button", { type: "button", onclick: () => confirm(`Accept and pay ${m.rewardCredits} credits?`) && act("Accept", () => api(`/v1/missions/${m.id}/accept`, {})) }, "Accept and pay"),
          h("button", { type: "button", onclick: () => act("Reject", () => api(`/v1/missions/${m.id}/reject`, {})) }, "Reject"),
        );
      }
      if (mineAsBuyer && (m.status === "open" || m.status === "claimed")) {
        actions.push(h("button", {
          type: "button",
          onclick: () => confirm("Cancel this mission and get the reward back?") && act("Cancel", () => api(`/v1/missions/${m.id}/cancel`, {})),
        }, "Cancel"));
      }
      return h("li", { class: "item" },
        h("p", {}, m.title),
        m.brief ? h("p", { class: "muted" }, m.brief) : null,
        h("div", { class: "meta" }, chip(m.status), chip(m.placeClass), chip(`${m.rewardCredits} credits`), mineAsBuyer ? chip("you posted") : null, mineAsClaimer ? chip("you claimed") : null),
        actions.length ? h("div", { class: "actions" }, actions) : null,
      );
    }), "No missions right now.");
  }

  function renderPurchases() {
    const mine = board.grants.filter((g) => g.licensee === me).reverse();
    fill($("purchases"), mine.map((g) => h("li", { class: "item" },
      h("div", { class: "meta" }, chip(`${g.priceCredits} credits`), chip(g.terms), when(g.issuedAt)),
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => openDelivery(g.id) }, "Open")),
    )), "Nothing bought yet.");
  }

  async function openDelivery(grantId) {
    const box = $("delivery");
    try {
      const { grant, packet } = await api(`/v1/grants/${grantId}`);
      box.replaceChildren(
        h("h3", {}, packet.placeLabel),
        h("p", {}, packet.observation),
        h("div", { class: "meta" }, chip(`quality ${packet.quality}`), chip(grant.terms), `captured ${when(packet.createdAt)}`),
        h("p", { class: "muted" }, "Proof of perspective"),
        h("code", {}, packet.proof),
      );
      box.hidden = false;
    } catch (e) {
      status(e.message, true);
    }
  }

  function renderCredits() {
    $("balance").textContent = String(board.balances[me] ?? 0);
    fill($("ledger"), board.ledger.slice().reverse().slice(0, 50).map((e) => h("li", { class: "item" },
      h("div", { class: "meta" }, h("span", { class: e.delta > 0 ? "delta-plus" : "" }, `${e.delta > 0 ? "+" : ""}${e.delta}`), e.reason, when(e.at)),
    )), "No credit movements yet.");
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
    $("capture-place").replaceChildren(...PLACES.map(([v, t]) => h("option", { value: v }, t)));
    $("mission-place").replaceChildren(...PLACES.filter(([v]) => !RESTRICTED.has(v)).map(([v, t]) => h("option", { value: v }, t)));
    for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));

    $("capture-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      act("Capture", async () => {
        await api("/v1/captures", { note: f.get("note"), placeLabel: f.get("placeLabel"), placeClass: f.get("placeClass"), mediaKind: "note" });
        ev.target.reset();
      });
    });

    $("mission-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      act("Post mission", async () => {
        await api("/v1/missions", { title: f.get("title"), brief: f.get("brief"), rewardCredits: Number(f.get("rewardCredits")), placeClass: f.get("placeClass") });
        ev.target.reset();
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
