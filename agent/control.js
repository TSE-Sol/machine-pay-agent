// Client for the control plane (the dashboard's backend): sends the agent's phase events
// and asks for human approvals. Reporting is best effort: if the dashboard is down the
// agent keeps working, and an approval that can't be requested is simply not granted there.
export function createControlClient({ url, token }) {
  if (!token) return null;

  const call = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // Events are sent one after another so they arrive in the order they happened,
  // without making the decision loop wait for the network.
  let queue = Promise.resolve();
  let warned = false;

  return {
    sendEvent(event) {
      queue = queue
        .then(() => call("POST", "/agent/events", event))
        .then((result) => {
          if (result.status !== 200 && !warned) {
            warned = true;
            console.warn(`(dashboard) event feed not accepted: HTTP ${result.status} ${result.body?.error ?? ""}`);
          }
        })
        .catch(() => {}); // dashboard unreachable: carry on
    },
    flush: () => queue,

    async createApproval(request) {
      const result = await call("POST", "/agent/approvals", request);
      if (result.status !== 201) throw new Error(`could not request approval (HTTP ${result.status})`);
      return result.body;
    },
    async getApproval(id) {
      const result = await call("GET", `/agent/approvals/${id}`);
      return result.status === 200 ? result.body : null;
    },
    /** Tell the dashboard the question was answered elsewhere (terminal or timeout). */
    async resolveApproval(id, decision, by) {
      await call("POST", `/agent/approvals/${id}`, { decision, by });
    },
  };
}
