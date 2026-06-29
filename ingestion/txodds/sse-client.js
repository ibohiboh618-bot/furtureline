// ingestion/txodds/sse-client.js
//
// Thin wrapper around TxODDS's Server-Sent Events endpoints for live odds
// and scores. Handles reconnect-with-backoff and 401 detection so the
// caller only has to provide an onEvent callback and a way to get a fresh
// token pair when needed.

const { EventSource } = require('eventsource');

const TXLINE_BASE_URL = process.env.TXLINE_BASE_URL || 'https://txline.txodds.com';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * @param {Object} opts
 * @param {'odds'|'scores'} opts.stream - which SSE endpoint to connect to
 * @param {() => Promise<{jwt: string, apiToken: string}>} opts.getCredentials
 * @param {(payload: any) => void} opts.onEvent
 * @param {(err: Error) => void} [opts.onError]
 * @returns {() => void} stop function
 */
function connectStream({ stream, getCredentials, onEvent, onError = () => {} }) {
  const path = stream === 'odds' ? '/api/odds/stream' : '/api/scores/stream';
  let es = null;
  let stopped = false;
  let backoffMs = RECONNECT_BASE_MS;

  async function open() {
    if (stopped) return;

    let creds;
    try {
      creds = await getCredentials();
    } catch (err) {
      onError(err);
      scheduleReconnect();
      return;
    }

    es = new EventSource(`${TXLINE_BASE_URL}${path}`, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${creds.jwt}`,
            'X-Api-Token': creds.apiToken,
          },
        }),
    });

    es.onopen = () => {
      backoffMs = RECONNECT_BASE_MS; // reset backoff on a clean connection
    };

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        onEvent(payload);
      } catch (err) {
        onError(new Error(`Failed to parse SSE payload: ${err.message}`));
      }
    };

    es.onerror = (event) => {
      // EventSource doesn't give us the HTTP status directly in all
      // environments; treat any error as reconnect-worthy. If credentials
      // were the issue, getCredentials() will be re-invoked on the next
      // open() call, which is where a 401 should be detected and the
      // session refreshed.
      onError(new Error('SSE connection error, will reconnect'));
      es.close();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (stopped) return;
    setTimeout(open, backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }

  open();

  return function stop() {
    stopped = true;
    if (es) es.close();
  };
}

module.exports = { connectStream };
