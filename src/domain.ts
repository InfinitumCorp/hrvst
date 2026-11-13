import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CONTRIBUTOR_SHARE_BPS,
  PLATFORM_FEE_BPS,
  type ArchitectSignal,
  type Board,
  type Capture,
  type CreditEntry,
  type Delivery,
  type Grant,
  type Listing,
  type Mission,
  type Packet,
  type PlaceClass,
} from "./types.ts";

export { CONTRIBUTOR_SHARE_BPS, PLATFORM_FEE_BPS };
export type { ArchitectSignal, Board, Capture, Delivery, Grant, Listing, Mission, Packet, PlaceClass };

/** Holds mission rewards between posting and acceptance. */
export const ESCROW = "escrow";

/** After this long without a submission, the buyer may cancel a claimed mission. */
export const CLAIM_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 7;

const RESTRICTED = new Set<PlaceClass>(["private_residence", "school", "hospital", "military", "home_interior"]);

export class HrvstError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "HrvstError";
    this.status = status;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nid(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 10)}`;
}

function iso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

export function privacyFilter(raw: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let text = raw;
  const rules: Array<[RegExp, string, string]> = [
    [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]", "email"],
    [/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}\b/g, "[phone]", "phone"],
    [/\b\d{3}-\d{2}-\d{4}\b/g, "[id]", "national-id"],
    [/\b[A-Z]{1,3}[\s-]?\d{1,4}[\s-]?[A-Z]{0,3}\b/g, "[plate]", "plate-like"],
  ];
  for (const [pattern, token, label] of rules) {
    if (pattern.test(text)) {
      redactions.push(label);
      pattern.lastIndex = 0;
      text = text.replace(pattern, token);
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), redactions };
}

/** A person (actor) may only act on what they own. Services pass no actor. */
function mustBe(actor: string | undefined, owner: string | undefined, what: string) {
  if (actor !== undefined && actor !== owner) throw new HrvstError(`only the ${what} can do that`, 403);
}

function qualityOf(text: string, placeClass: PlaceClass): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = Math.min(0.95, 0.35 + words * 0.04);
  if (placeClass === "street" || placeClass === "retail" || placeClass === "field") score += 0.05;
  return Math.round(score * 100) / 100;
}

export class HrvstBackend {
  captures = new Map<string, Capture>();
  packets = new Map<string, Packet>();
  missions = new Map<string, Mission>();
  grants: Grant[] = [];
  ledger: CreditEntry[] = [];
  signals: ArchitectSignal[] = [];
  balances = new Map<string, number>();
  private chainTip: string | null = null;

  constructor() {
    this.credit("platform", 0, "open");
  }

  credit(account: string, delta: number, reason: string) {
    const next = (this.balances.get(account) ?? 0) + delta;
    if (next < 0) throw new HrvstError(`${account} does not have enough Harvest Credits`);
    this.balances.set(account, next);
    this.ledger.push({ id: nid("led"), account, delta, reason, at: iso() });
  }

  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  capture(input: {
    owner: string;
    note: string;
    placeLabel: string;
    placeClass: PlaceClass;
    mediaKind?: "note" | "glasses";
  }): Capture {
    const owner = input.owner.trim();
    const note = input.note.trim();
    if (!owner || !note) throw new HrvstError("owner and note are required");
    if (note.length > 2000) throw new HrvstError("note is too long");
    const capture: Capture = {
      id: nid("cap"),
      owner,
      note,
      placeLabel: input.placeLabel.trim() || "unspecified",
      placeClass: input.placeClass,
      mediaKind: input.mediaKind ?? "glasses",
      capturedAt: iso(),
      rawDigest: sha256(`${owner}|${note}|${input.placeLabel}`),
      status: "captured",
      redactions: [],
    };
    this.captures.set(capture.id, capture);
    return capture;
  }

  refine(captureId: string, optedIn = false, actor?: string): { capture: Capture; packet?: Packet } {
    const capture = this.requireCapture(captureId);
    mustBe(actor, capture.owner, "owner");
    if (capture.status === "deleted") throw new HrvstError("capture was deleted", 409);
    if (RESTRICTED.has(capture.placeClass) && !optedIn) {
      capture.status = "excluded";
      capture.excludedReason = `${capture.placeClass} stays on the device until the owner opts in`;
      return { capture };
    }
    const filtered = privacyFilter(capture.note);
    capture.note = filtered.text;
    capture.redactions = filtered.redactions;
    capture.status = "refined";
    const packet = this.packagePacket(capture);
    if (RESTRICTED.has(capture.placeClass)) packet.permittedUses = [`restricted:${capture.placeClass}`];
    return { capture, packet };
  }

  private packagePacket(capture: Capture): Packet {
    const proof = sha256(
      `${this.chainTip ?? "genesis"}|${capture.owner}|${capture.capturedAt}|${capture.rawDigest}|${capture.note}`,
    );
    const packet: Packet = {
      id: nid("pkt"),
      captureId: capture.id,
      owner: capture.owner,
      observation: capture.note,
      quality: qualityOf(capture.note, capture.placeClass),
      permittedUses: ["inspection", "research"],
      placeLabel: capture.placeLabel,
      status: "draft",
      proof,
      previousProof: this.chainTip,
      createdAt: iso(),
      expiresAt: iso(Date.now() + 1000 * 60 * 60 * 24 * 180),
      priceCredits: 40,
    };
    this.chainTip = proof;
    this.packets.set(packet.id, packet);
    return packet;
  }

  decide(packetId: string, action: "keep" | "list" | "delete", priceCredits?: number, actor?: string): Packet {
    const packet = this.requirePacket(packetId);
    mustBe(actor, packet.owner, "owner");
    if (packet.status === "retired") throw new HrvstError("packet is retired", 409);
    if (action === "delete") {
      this.erasePacket(packet);
      return packet;
    }
    if (action === "keep") {
      packet.status = "private";
      return packet;
    }
    if (priceCredits !== undefined) {
      if (!Number.isFinite(priceCredits) || priceCredits < 1) throw new HrvstError("price must be at least 1 credit");
      packet.priceCredits = Math.round(priceCredits);
    }
    packet.status = "listed";
    return packet;
  }

  postMission(input: {
    buyer: string;
    title: string;
    brief: string;
    rewardCredits: number;
    placeClass: PlaceClass;
  }): Mission {
    const buyer = input.buyer.trim();
    if (!buyer || !input.title.trim()) throw new HrvstError("buyer and title are required");
    if (!Number.isFinite(input.rewardCredits) || input.rewardCredits < 1) throw new HrvstError("reward must be at least 1 credit");
    if (RESTRICTED.has(input.placeClass)) throw new HrvstError(`a mission cannot ask for ${input.placeClass}`);
    const reward = Math.round(input.rewardCredits);
    if ((this.balances.get(buyer) ?? 0) < reward) {
      throw new HrvstError("buyer cannot cover the reward");
    }
    const mission: Mission = {
      id: nid("msn"),
      buyer,
      title: input.title.trim(),
      brief: input.brief.trim(),
      rewardCredits: reward,
      placeClass: input.placeClass,
      status: "open",
      createdAt: iso(),
      escrowed: true,
    };
    this.credit(buyer, -reward, `escrow ${mission.id}`);
    this.credit(ESCROW, reward, `escrow ${mission.id}`);
    this.missions.set(mission.id, mission);
    return mission;
  }

  /** The buyer withdraws an open mission and the held reward comes back. */
  cancelMission(missionId: string, actor?: string): Mission {
    const mission = this.requireMission(missionId);
    mustBe(actor, mission.buyer, "buyer");
    const stale = mission.status === "claimed" && Date.now() - new Date(mission.claimedAt ?? 0).getTime() > CLAIM_TIMEOUT_MS;
    if (mission.status !== "open" && !stale) {
      throw new HrvstError("only an open mission, or one claimed over 7 days ago with no submission, can be cancelled", 409);
    }
    if (mission.escrowed) {
      this.credit(ESCROW, -mission.rewardCredits, `refund ${mission.id}`);
      this.credit(mission.buyer, mission.rewardCredits, `refund ${mission.id}`);
    }
    mission.status = "cancelled";
    return mission;
  }

  claimMission(missionId: string, owner: string): Mission {
    const mission = this.requireMission(missionId);
    if (mission.status !== "open") throw new HrvstError("mission is not open", 409);
    if (owner === mission.buyer) throw new HrvstError("buyer cannot claim their own mission");
    mission.status = "claimed";
    mission.claimer = owner;
    mission.claimedAt = iso();
    return mission;
  }

  /** The claimer gives the mission back so someone else can take it. */
  releaseMission(missionId: string, actor?: string): Mission {
    const mission = this.requireMission(missionId);
    mustBe(actor, mission.claimer, "claimer");
    if (mission.status !== "claimed") throw new HrvstError("only a claimed mission can be released", 409);
    return this.reopen(mission);
  }

  /** The buyer turns a submission down. The mission reopens and the reward stays in escrow. */
  rejectMission(missionId: string, actor?: string): Mission {
    const mission = this.requireMission(missionId);
    mustBe(actor, mission.buyer, "buyer");
    if (mission.status !== "submitted" || !mission.packetId) throw new HrvstError("mission has no submission", 409);
    mission.rejectedPackets = [...(mission.rejectedPackets ?? []), mission.packetId];
    return this.reopen(mission);
  }

  private reopen(mission: Mission): Mission {
    mission.status = "open";
    delete mission.claimer;
    delete mission.claimedAt;
    delete mission.packetId;
    return mission;
  }

  submitMission(missionId: string, packetId: string, actor?: string): Mission {
    const mission = this.requireMission(missionId);
    mustBe(actor, mission.claimer, "claimer");
    if (mission.status !== "claimed" || !mission.claimer) throw new HrvstError("mission is not claimed", 409);
    const packet = this.requirePacket(packetId);
    if (packet.owner !== mission.claimer) throw new HrvstError("packet is not owned by the claimer");
    if (mission.rejectedPackets?.includes(packet.id)) throw new HrvstError("the buyer already turned this packet down", 409);
    if (packet.status === "draft" || packet.status === "retired") {
      throw new HrvstError("packet must be kept or listed before it can fulfil a mission");
    }
    mission.status = "submitted";
    mission.packetId = packet.id;
    return mission;
  }

  acceptMission(missionId: string, actor?: string): Mission {
    const mission = this.requireMission(missionId);
    mustBe(actor, mission.buyer, "buyer");
    if (mission.status !== "submitted" || !mission.packetId || !mission.claimer) {
      throw new HrvstError("mission has no submission", 409);
    }
    this.credit(mission.escrowed ? ESCROW : mission.buyer, -mission.rewardCredits, `mission ${mission.id}`);
    const platform = Math.round((mission.rewardCredits * PLATFORM_FEE_BPS) / 10_000);
    const contributor = mission.rewardCredits - platform;
    this.credit(mission.claimer, contributor, `mission ${mission.id}`);
    this.credit("platform", platform, `mission fee ${mission.id}`);
    this.grants.push({
      id: nid("grn"),
      packetId: mission.packetId,
      licensee: mission.buyer,
      terms: `mission:${mission.id}`,
      priceCredits: mission.rewardCredits,
      contributorCredits: contributor,
      platformCredits: platform,
      issuedAt: iso(),
    });
    mission.status = "accepted";
    return mission;
  }

  license(packetId: string, licensee: string): Grant {
    const packet = this.requirePacket(packetId);
    if (packet.status !== "listed") throw new HrvstError("packet is not listed", 409);
    if (licensee === packet.owner) throw new HrvstError("owner already holds the packet");
    if (this.grants.some((g) => g.packetId === packet.id && g.licensee === licensee)) {
      throw new HrvstError("licensee already holds this packet", 409);
    }
    if (new Date(packet.expiresAt).getTime() < Date.now()) {
      packet.status = "retired";
      throw new HrvstError("packet has expired", 409);
    }
    const price = packet.priceCredits;
    this.credit(licensee, -price, `license ${packet.id}`);
    const platform = Math.round((price * PLATFORM_FEE_BPS) / 10_000);
    const contributor = price - platform;
    this.credit(packet.owner, contributor, `license ${packet.id}`);
    this.credit("platform", platform, `license fee ${packet.id}`);
    const grant: Grant = {
      id: nid("grn"),
      packetId: packet.id,
      licensee,
      terms: packet.permittedUses.join(","),
      priceCredits: price,
      contributorCredits: contributor,
      platformCredits: platform,
      issuedAt: iso(),
    };
    this.grants.push(grant);
    return grant;
  }

  /** Listed, unexpired packets as a buyer sees them before paying. */
  market(): Listing[] {
    const now = Date.now();
    return [...this.packets.values()]
      .filter((p) => p.status === "listed" && new Date(p.expiresAt).getTime() >= now)
      .map(({ id, placeLabel, quality, permittedUses, priceCredits, createdAt, expiresAt }) => ({
        id, placeLabel, quality, permittedUses, priceCredits, createdAt, expiresAt,
      }));
  }

  /** The licensee collects what they paid for. The contributor stays anonymous. */
  delivery(grantId: string, actor?: string): Delivery {
    const grant = this.grants.find((g) => g.id === grantId);
    if (!grant) throw new HrvstError("grant not found", 404);
    mustBe(actor, grant.licensee, "licensee");
    const { owner: _o, captureId: _c, status: _s, priceCredits: _p, ...packet } = this.requirePacket(grant.packetId);
    return { grant, packet };
  }

  /** Observe → Understand → Act. A kept or listed fault becomes an Architect score, still unapproved. */
  signalArchitect(packetId: string, actor?: string): ArchitectSignal {
    const packet = this.requirePacket(packetId);
    mustBe(actor, packet.owner, "owner");
    if (packet.status !== "private" && packet.status !== "listed") {
      throw new HrvstError("only an approved packet can start work");
    }
    const signal: ArchitectSignal = {
      id: nid("sig"),
      product: "hrvst",
      type: "fault",
      packetId: packet.id,
      goal: `Field observation ${packet.id} at ${packet.placeLabel}: ${packet.observation}. Prepare a service request and stop for approval before any irreversible step.`,
      createdAt: iso(),
      delivered: false,
    };
    this.signals.push(signal);
    return signal;
  }

  markDelivered(signalId: string, architectScoreId?: string): ArchitectSignal {
    const signal = this.signals.find((item) => item.id === signalId);
    if (!signal) throw new HrvstError("signal not found", 404);
    signal.delivered = true;
    if (architectScoreId) signal.architectScoreId = architectScoreId;
    return signal;
  }

  /** Issue Harvest Credits to an account (a purchase or a grant settled outside HRVST). */
  topUp(account: string, credits: number, reason: string): number {
    const who = account.trim();
    if (!who || who === ESCROW || who === "platform") throw new HrvstError("a person or buyer account is required");
    if (!Number.isInteger(credits) || credits < 1) throw new HrvstError("credits must be a whole number of at least 1");
    if (!reason.trim()) throw new HrvstError("a reason is required");
    this.credit(who, credits, `top up: ${reason.trim()}`);
    return this.balance(who);
  }

  snapshot(): Board {
    return {
      captures: [...this.captures.values()],
      packets: [...this.packets.values()],
      missions: [...this.missions.values()],
      grants: [...this.grants],
      ledger: [...this.ledger],
      signals: [...this.signals],
      balances: Object.fromEntries(this.balances),
    };
  }

  /** What one person may see: their own silo, credits and grants, plus open missions and their own missions. */
  snapshotFor(cid: string): Board {
    const packets = [...this.packets.values()].filter((p) => p.owner === cid);
    const mine = new Set(packets.map((p) => p.id));
    return {
      captures: [...this.captures.values()].filter((c) => c.owner === cid),
      packets,
      missions: [...this.missions.values()].filter((m) => m.status === "open" || m.buyer === cid || m.claimer === cid),
      grants: this.grants.filter((g) => g.licensee === cid || mine.has(g.packetId)),
      ledger: this.ledger.filter((e) => e.account === cid),
      signals: this.signals.filter((s) => mine.has(s.packetId)),
      balances: { [cid]: this.balance(cid) },
    };
  }

  /**
   * Deleting erases the words, not the proof. The capture's note is wiped. The packet's observation is
   * wiped too, unless someone already holds a licence to it: they paid for that copy, so it stays for them.
   * Proof hashes stay so the chain still verifies.
   */
  private erasePacket(packet: Packet) {
    packet.status = "retired";
    if (!this.grants.some((g) => g.packetId === packet.id)) packet.observation = "";
    const capture = this.captures.get(packet.captureId);
    if (capture) this.eraseCapture(capture);
  }

  private eraseCapture(capture: Capture) {
    capture.status = "deleted";
    capture.note = "";
    capture.placeLabel = "deleted";
    delete capture.excludedReason;
  }

  /** Everything HRVST holds about one person, for them to download. */
  exportFor(cid: string): Board & { owner: string; exportedAt: string } {
    return { owner: cid, exportedAt: iso(), ...this.snapshotFor(cid) };
  }

  /**
   * Erase a person's data: every capture and packet (as delete does), every open mission they posted
   * (reward refunded), and every mission they claimed but did not finish (given back). Credits, licences
   * already sold and the ledger stay: they are other people's purchases and the money record.
   */
  eraseAccount(cid: string): { captures: number; packets: number; missionsCancelled: number; missionsReleased: number } {
    let captures = 0;
    let packets = 0;
    let missionsCancelled = 0;
    let missionsReleased = 0;
    for (const packet of this.packets.values()) {
      const licensed = this.grants.some((g) => g.packetId === packet.id);
      if (packet.owner !== cid || (packet.status === "retired" && (!packet.observation || licensed))) continue;
      this.erasePacket(packet);
      packets++;
    }
    for (const capture of this.captures.values()) {
      if (capture.owner !== cid || (capture.status === "deleted" && !capture.note)) continue;
      this.eraseCapture(capture);
      captures++;
    }
    for (const mission of this.missions.values()) {
      if (mission.buyer === cid && mission.status === "open") {
        this.cancelMission(mission.id);
        missionsCancelled++;
      } else if (mission.claimer === cid && mission.status === "claimed") {
        this.releaseMission(mission.id);
        missionsReleased++;
      }
    }
    return { captures, packets, missionsCancelled, missionsReleased };
  }

  /** Everything needed to rebuild the store, including the proof-chain tip. */
  toJSON(): StoredState {
    return { version: 1, ...this.snapshot(), chainTip: this.chainTip };
  }

  static fromJSON(state: StoredState): HrvstBackend {
    if (state.version !== 1) throw new Error(`unknown HRVST data version ${String(state.version)}`);
    const store = new HrvstBackend();
    store.balances = new Map(Object.entries(state.balances));
    store.captures = new Map(state.captures.map((c) => [c.id, c]));
    store.packets = new Map(state.packets.map((p) => [p.id, p]));
    store.missions = new Map(state.missions.map((m) => [m.id, m]));
    store.grants = state.grants;
    store.ledger = state.ledger;
    store.signals = state.signals;
    store.chainTip = state.chainTip;
    return store;
  }

  /** Write the store to disk atomically (temp file, then rename). No-op without a data file. */
  save(file = this.file) {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.toJSON()), { mode: 0o600 });
    renameSync(tmp, file);
  }

  file?: string;

  private requireCapture(id: string): Capture {
    const capture = this.captures.get(id);
    if (!capture) throw new HrvstError("capture not found", 404);
    return capture;
  }

  private requirePacket(id: string): Packet {
    const packet = this.packets.get(id);
    if (!packet) throw new HrvstError("packet not found", 404);
    return packet;
  }

  private requireMission(id: string): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new HrvstError("mission not found", 404);
    return mission;
  }
}

export type StoredState = Board & { version: 1; chainTip: string | null };

let backend: HrvstBackend | null = null;

/**
 * Open the store. With a data file it is loaded from disk and survives restarts; a new file starts empty
 * unless `seedDemo` is set. Without a data file the store lives in memory with the demo seed.
 */
export function openBackend(file?: string, seedDemo = !file): HrvstBackend {
  if (file && existsSync(file)) {
    const store = HrvstBackend.fromJSON(JSON.parse(readFileSync(file, "utf8")) as StoredState);
    store.file = file;
    return store;
  }
  const store = new HrvstBackend();
  if (seedDemo) seed(store);
  store.file = file;
  store.save();
  return store;
}

export function getBackend(): HrvstBackend {
  if (!backend) {
    const file = process.env.HRVST_DATA_FILE || undefined;
    backend = openBackend(file, file ? process.env.HRVST_SEED === "1" : true);
  }
  return backend;
}

export function seed(store: HrvstBackend) {
  store.credit("cid:field", 0, "open silo");
  store.credit("cid:auditor", 500, "opening balance");
  store.credit("cid:retail", 800, "opening balance");
  const fault = store.capture({
    owner: "cid:field",
    note: "Lifted sidewalk slab outside the municipal library. Trip edge about two centimetres. No people in frame.",
    placeLabel: "Library approach",
    placeClass: "street",
  });
  const refined = store.refine(fault.id);
  if (refined.packet) store.decide(refined.packet.id, "keep");
  store.postMission({
    buyer: "cid:auditor",
    title: "Accessible entrances on 4th",
    brief: "Document step-free public entrances. Blur faces and plates. Do not record residences.",
    rewardCredits: 120,
    placeClass: "public_building",
  });
  store.postMission({
    buyer: "cid:retail",
    title: "Empty shelf, aisle 6",
    brief: "Note missing oat milk facings. No customer faces.",
    rewardCredits: 60,
    placeClass: "retail",
  });
}
