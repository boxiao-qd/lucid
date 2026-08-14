const API_BASE = "/bx/api/v1";
const AUTH_BASE = "/bx/api/auth";

let accessToken = "";

export function setAccessToken(token: string) {
  accessToken = token;
}

export function getAccessToken(): string {
  return accessToken;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  return h;
}

export async function apiGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, { headers: headers() });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function apiPut<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function apiDelete(path: string): Promise<void> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
  }
}

export async function apiUploadBinary<T>(path: string, body: Uint8Array, contentType: string): Promise<T> {
  const h: Record<string, string> = {};
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  h["Content-Type"] = contentType;

  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: h,
    body: new Blob([body.buffer as ArrayBuffer], { type: contentType }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function apiUploadFile<T>(path: string, file: File): Promise<T> {
  const h: Record<string, string> = {};
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;

  const formData = new FormData();
  formData.append("file", file);

  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: h,
    body: formData,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// Auth API calls (no Bearer token needed)
export async function authPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// Tool confirmation — user approves/rejects terminal/code_execute execution
export function confirmToolExecution(
  sessionId: string,
  body: { confirmation_id: string; action: string; text?: string },
): Promise<{ ok: boolean }> {
  return apiPost(`/sessions/${sessionId}/tool-confirm`, body);
}
