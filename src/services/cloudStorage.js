// Cloud Storage over plain HTTPS, with the token App Engine hands its own
// service account: no SDK and no stored credential. Used by the nightly backup
// and by receipt photos.

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
export const STORAGE_API = "https://storage.googleapis.com";

export async function accessToken(fetchImpl = fetch) {
  const res = await fetchImpl(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`Could not get a storage token: HTTP ${res.status}`);
  const { access_token: token } = await res.json();
  if (!token) throw new Error("Could not get a storage token: empty response.");
  return token;
}

export async function storageRequest(fetchImpl, token, url, init = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Cloud Storage ${init.method || "GET"} failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return res;
}

export const objectUrl = (bucket, name) =>
  `${STORAGE_API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;

export function uploadUrl(bucket, name) {
  const url = new URL(`${STORAGE_API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", name);
  return url;
}
