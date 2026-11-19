// Searches whose values are customer details (a name, a phone number, an
// Instagram handle, a serial, an address being typed) are also accepted as a
// POST with those values in the JSON body. Google's App Engine request log
// records every URL in full, query string included, and keeps it for 30 days;
// request bodies are never logged. The app and the MCP server send these
// searches as POSTs; the GET forms keep working for older clients.
//
// This hands the body to the same handler the GET uses, as if it had been the
// query string: plain values become strings ("true", "20"), lists become lists
// of strings, and anything nested is dropped, exactly what a URL could carry.

function asQueryValue(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(asQueryValue).filter((item) => typeof item === "string");
  if (typeof value === "object") return undefined;
  return String(value);
}

export function queryFromBody(req, _res, next) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const fromBody = {};
  for (const [key, value] of Object.entries(body)) {
    const text = asQueryValue(value);
    if (text !== undefined) fromBody[key] = text;
  }
  req.query = { ...req.query, ...fromBody };
  next();
}
