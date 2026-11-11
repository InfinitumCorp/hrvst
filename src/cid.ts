// People call HRVST with their Cumulus ID token (from "Sign in with Cumulus ID" in a product).
// The token is checked at the issuer's /api/id/userinfo, and a good answer is cached briefly.
// CID_ISSUER can point at a Cumulus ID mirror that loads in Russia.

export const DEFAULT_ISSUER = "https://id.cumuluscloud.app";
const CACHE_MS = 60_000;
const MAX_CACHE = 1000;

export interface CidProfile {
  cid: string;
  username?: string;
  email?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createCidVerifier(issuer = process.env.CID_ISSUER || DEFAULT_ISSUER, fetchImpl: Fetch = fetch) {
  const base = issuer.replace(/\/+$/, "");
  const cache = new Map<string, { profile: CidProfile; until: number }>();
  /** The profile behind a Cumulus ID token, or null when the issuer does not accept it. */
  return async function verify(token: string): Promise<CidProfile | null> {
    if (!token || token.length > 8000) return null;
    const hit = cache.get(token);
    if (hit && hit.until > Date.now()) return hit.profile;
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/id/userinfo`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Partial<CidProfile> | null;
    if (!body || typeof body.cid !== "string" || !body.cid) return null;
    const profile: CidProfile = { cid: body.cid, username: body.username, email: body.email };
    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(token, { profile, until: Date.now() + CACHE_MS });
    return profile;
  };
}
