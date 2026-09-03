export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) {
    throw Object.assign(new Error(payload.error || `HTTP ${res.status}`), { payload, status: res.status });
  }
  return { ...payload, status: res.status };
}

export function localDayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
