const deploymentBase = window.location.pathname === "/multibase-v1"
  || window.location.pathname.startsWith("/multibase-v1/")
  ? "/multibase-v1"
  : "";

export function publicPath(path) {
  return `${deploymentBase}${path}`;
}

export async function api(path, options = {}) {
  const response = await fetch(publicPath(`/api${path}`), {
    credentials: "same-origin",
    headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...options.headers },
    ...options,
    body: options.body instanceof FormData || typeof options.body === "string" ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") || "";
  const result = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(result?.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = result?.code;
    throw error;
  }
  return result;
}

export function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
