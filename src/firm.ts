// FIRM Suite for [HRVST]: FIRM (settlement token), FIRM Wallet (firmwallet.app) and
// Firmament Network (CPO, firmnetwork.app). HRVST has no UI of its own, so the glasses app and
// partner clients read this from GET /v1/firm and render it (or embed <firm-suite product="hrvst">,
// see infinitum-nexus/packages/firm/suite). Registry values match that package and firmwallet.app.

export const FIRM_WALLET_URL = "https://firmwallet.app";
export const FIRMAMENT_URL = "https://firmnetwork.app";

export interface FirmSuiteInfo {
  suite: { token: "FIRM"; wallet: "FIRM Wallet"; network: "Firmament Network" };
  product: { id: "hrvst"; wordmark: "[HRVST]"; token: "HRVST"; network: "Solana" };
  settlesThrough: "FIRM";
  status: "coming_soon";
  links: { wallet: string; network: string };
  account?: { owner: string; credits: number; settlement: "pending" };
}

/** The FIRM Suite as HRVST uses it. With an owner, includes their Harvest Credits awaiting settlement. */
export function firmSuite(owner?: string, credits?: number): FirmSuiteInfo {
  const info: FirmSuiteInfo = {
    suite: { token: "FIRM", wallet: "FIRM Wallet", network: "Firmament Network" },
    product: { id: "hrvst", wordmark: "[HRVST]", token: "HRVST", network: "Solana" },
    settlesThrough: "FIRM",
    status: "coming_soon",
    links: { wallet: `${FIRM_WALLET_URL}/?ref=hrvst`, network: `${FIRMAMENT_URL}/?ref=hrvst` },
  };
  // Credits stay Harvest Credits until token settlement goes live; nothing is paid on-chain yet.
  if (owner) info.account = { owner, credits: credits ?? 0, settlement: "pending" };
  return info;
}
