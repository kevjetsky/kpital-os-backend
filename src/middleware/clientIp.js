// Which address a request really came from, for rate limits and access logs.
//
// On App Engine the app's socket is the local proxy (127.0.0.1), so without
// help every visitor looks like the same client and one rate-limit bucket is
// shared by the whole internet. Google's load balancer appends exactly two
// entries to X-Forwarded-For, "CLIENT_IP, FORWARDING_RULE_IP"; anything before
// them came from the client and is not checked by Google, so it is never
// trusted.
//
// Express walks the hops from the socket outwards and stops at the first one
// it does not trust: hop 0 is the socket (trusted only when it is the local
// proxy), hop 1 is the load balancer's own entry, and hop 2 is the client.
// Off App Engine (local runs, tests) nothing is forwarded and the socket
// address is used as it is.
const LOOPBACK = /^(127\.|::1$|::ffff:127\.|169\.254\.)/;

export function trustAppEngineProxy(address, hop) {
  if (hop === 0) return LOOPBACK.test(String(address || ""));
  return hop === 1;
}
