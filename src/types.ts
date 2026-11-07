export const PLATFORM_FEE_BPS = 1500;
export const CONTRIBUTOR_SHARE_BPS = 10_000 - PLATFORM_FEE_BPS;

export type PlaceClass =
  | "street"
  | "retail"
  | "field"
  | "public_building"
  | "private_residence"
  | "school"
  | "hospital"
  | "military"
  | "home_interior";

export type CaptureStatus = "captured" | "refined" | "excluded" | "deleted";
export type PacketStatus = "draft" | "private" | "listed" | "retired";
export type MissionStatus = "open" | "claimed" | "submitted" | "accepted" | "rejected";

export interface Capture {
  id: string;
  owner: string;
  note: string;
  placeLabel: string;
  placeClass: PlaceClass;
  mediaKind: "note" | "glasses";
  capturedAt: string;
  rawDigest: string;
  status: CaptureStatus;
  redactions: string[];
  excludedReason?: string;
}

export interface Packet {
  id: string;
  captureId: string;
  owner: string;
  observation: string;
  quality: number;
  permittedUses: string[];
  placeLabel: string;
  status: PacketStatus;
  proof: string;
  previousProof: string | null;
  createdAt: string;
  expiresAt: string;
  priceCredits: number;
}

export interface Mission {
  id: string;
  buyer: string;
  title: string;
  brief: string;
  rewardCredits: number;
  placeClass: PlaceClass;
  status: MissionStatus;
  claimer?: string;
  packetId?: string;
  createdAt: string;
}

export interface Grant {
  id: string;
  packetId: string;
  licensee: string;
  terms: string;
  priceCredits: number;
  contributorCredits: number;
  platformCredits: number;
  issuedAt: string;
}

export interface CreditEntry {
  id: string;
  account: string;
  delta: number;
  reason: string;
  at: string;
}

export interface ArchitectSignal {
  id: string;
  product: "hrvst";
  type: "fault";
  goal: string;
  packetId: string;
  createdAt: string;
  delivered: boolean;
  architectScoreId?: string;
}

export interface Board {
  captures: Capture[];
  packets: Packet[];
  missions: Mission[];
  grants: Grant[];
  ledger: CreditEntry[];
  signals: ArchitectSignal[];
  balances: Record<string, number>;
}
