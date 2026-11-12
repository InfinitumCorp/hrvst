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

/**
 * Hand every pending HRVST fault to Architect, then mark each one delivered in HRVST
 * so it is not sent twice. Needs the HRVST service token; stops at the first failure.
 */
export async function deliverPending(opts: {
  hrvstUrl: string;
  architectUrl: string;
  hrvstToken?: string;
  architectToken?: string;
}): Promise<string[]> {
  const auth: Record<string, string> = opts.hrvstToken ? { authorization: `Bearer ${opts.hrvstToken}` } : {};
  const board = await fetch(`${opts.hrvstUrl}/v1/board`, { headers: auth });
  if (!board.ok) throw new Error(`hrvst ${board.status}`);
  const { signals } = (await board.json()) as {
    signals: Array<{ id: string; goal: string; packetId: string; delivered: boolean }>;
  };
  const done: string[] = [];
  for (const signal of signals.filter((s) => !s.delivered)) {
    const { runId } = await deliverFault({ ...opts, signalId: signal.id, goal: signal.goal, packetId: signal.packetId });
    const marked = await fetch(`${opts.hrvstUrl}/v1/signals/${signal.id}/delivered`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify(runId ? { architectScoreId: runId } : {}),
    });
    if (!marked.ok) throw new Error(`hrvst mark ${signal.id}: ${marked.status}`);
    done.push(signal.id);
  }
  return done;
}
