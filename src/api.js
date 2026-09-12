// One place where every request's failure is shaped, because a 90-day session
// cookie means the client will meet a 401 eventually and §9.1's rule is that
// the app must never merely look broken.

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
  }
}

// The Gate lives above the provider tree, so a 401 is reported upwards through
// a registered callback rather than by throwing something App must catch in
// every caller.
let unauthorizedHandler = null;

export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body ? { 'content-type': 'application/json' } : {},
      ...options,
    });
  } catch (err) {
    // Offline, DNS, aborted -- a network failure is not an exception the UI
    // should treat differently from a server one.
    throw new ApiError('Cannot reach NeatInfo. Check your connection.', 0, { cause: String(err) });
  }

  const payload = await res.json().catch(() => ({}));

  if (res.status === 401) {
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(payload.error || 'Signed out.', 401, payload);
  }

  // 409 is a duplicate, which is an answer rather than a failure: AddSheet
  // reads `article` off it and offers to open or fill in the existing item.
  if (!res.ok && res.status !== 409) {
    throw new ApiError(payload.error || `Something went wrong (HTTP ${res.status}).`, res.status, payload);
  }

  return { ...payload, status: res.status };
}

export function localDayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
