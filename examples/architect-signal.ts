/**
 * Hand a queued HRVST fault to a running :\ARCHITECT\ server.
 * Architect's own policy still pauses before irreversible actions.
 */
export async function deliverFault(opts: {
  hrvstUrl: string;
  architectUrl: string;
  hrvstToken?: string;
  architectToken?: string;
  signalId: string;
  goal: string;
  packetId: string;
}): Promise<{ runId?: string }> {
  const headers = (token?: string) => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const response = await fetch(`${opts.architectUrl}/v1/signals/hrvst`, {
    method: "POST",
    headers: headers(opts.architectToken),
    body: JSON.stringify({
      type: "fault",
      payload: { packetId: opts.packetId, goal: opts.goal, source: "hrvst" },
    }),
  });
  if (!response.ok) throw new Error(`architect ${response.status}`);
  return response.json() as Promise<{ runId?: string }>;
}
