import { createHash, randomUUID } from "node:crypto";
import {
  CONTRIBUTOR_SHARE_BPS,
  PLATFORM_FEE_BPS,
  type ArchitectSignal,
  type Board,
  type Capture,
  type CreditEntry,
  type Grant,
  type Mission,
  type Packet,
  type PlaceClass,
} from "./types.ts";

export { CONTRIBUTOR_SHARE_BPS, PLATFORM_FEE_BPS };
export type { ArchitectSignal, Board, Capture, Grant, Mission, Packet, PlaceClass };

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

  refine(captureId: string): { capture: Capture; packet?: Packet } {
    const capture = this.requireCapture(captureId);
    if (capture.status === "deleted") throw new HrvstError("capture was deleted", 409);
    if (RESTRICTED.has(capture.placeClass)) {
      capture.status = "excluded";
      capture.excludedReason = `${capture.placeClass} is not eligible to leave the device`;
      return { capture };
    }
    const filtered = privacyFilter(capture.note);
    capture.note = filtered.text;
    capture.redactions = filtered.redactions;
    capture.status = "refined";
    const packet = this.packagePacket(capture);
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

  decide(packetId: string, action: "keep" | "list" | "delete", priceCredits?: number): Packet {
    const packet = this.requirePacket(packetId);
    if (packet.status === "retired") throw new HrvstError("packet is retired", 409);
    if (action === "delete") {
      packet.status = "retired";
      const capture = this.captures.get(packet.captureId);
      if (capture) capture.status = "deleted";
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
    if (input.rewardCredits < 1) throw new HrvstError("reward must be at least 1 credit");
    if ((this.balances.get(buyer) ?? 0) < input.rewardCredits) {
      throw new HrvstError("buyer cannot cover the reward");
    }
    const mission: Mission = {
      id: nid("msn"),
      buyer,
      title: input.title.trim(),
      brief: input.brief.trim(),
      rewardCredits: Math.round(input.rewardCredits),
      placeClass: input.placeClass,
      status: "open",
      createdAt: iso(),
    };
    this.missions.set(mission.id, mission);
    return mission;
  }

  claimMission(missionId: string, owner: string): Mission {
    const mission = this.requireMission(missionId);
    if (mission.status !== "open") throw new HrvstError("mission is not open", 409);
    if (owner === mission.buyer) throw new HrvstError("buyer cannot claim their own mission");
    mission.status = "claimed";
    mission.claimer = owner;
    return mission;
  }

  submitMission(missionId: string, packetId: string): Mission {
    const mission = this.requireMission(missionId);
    if (mission.status !== "claimed" || !mission.claimer) throw new HrvstError("mission is not claimed", 409);
    const packet = this.requirePacket(packetId);
    if (packet.owner !== mission.claimer) throw new HrvstError("packet is not owned by the claimer");
    if (packet.status === "draft" || packet.status === "retired") {
      throw new HrvstError("packet must be kept or listed before it can fulfil a mission");
    }
    mission.status = "submitted";
    mission.packetId = packet.id;
    return mission;
  }

  acceptMission(missionId: string): Mission {
    const mission = this.requireMission(missionId);
    if (mission.status !== "submitted" || !mission.packetId || !mission.claimer) {
      throw new HrvstError("mission has no submission", 409);
    }
    this.credit(mission.buyer, -mission.rewardCredits, `mission ${mission.id}`);
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

  /** Observe → Understand → Act. A kept or listed fault becomes an Architect score, still unapproved. */
  signalArchitect(packetId: string): ArchitectSignal {
    const packet = this.requirePacket(packetId);
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

  markDelivered(signalId: string): ArchitectSignal {
    const signal = this.signals.find((item) => item.id === signalId);
    if (!signal) throw new HrvstError("signal not found", 404);
    signal.delivered = true;
    return signal;
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

let backend: HrvstBackend | null = null;

export function getBackend(): HrvstBackend {
  if (!backend) {
    backend = new HrvstBackend();
    seed(backend);
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
