import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Supabase credentials are not set');
}

/**
 * Custom fetch that logs details when a request fails.
 * Ensures all Supabase requests, including storage, continue as normal while
 * exposing diagnostic information.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
const fetchWithLogging = async (input, init) => {
  const res = await fetch(input, init);

  if (!res.ok) {
    try {
      const clone = res.clone();
      const headers = Object.fromEntries(clone.headers.entries());
      const contentType = clone.headers.get('content-type') || '';
      let body;
      if (contentType.includes('html')) {
        body = await clone.text();
      }

      console.error('Supabase request failed', {
        status: clone.status,
        headers,
        ...(body ? { body } : {}),
      });
    } catch (e) {
      // Logging shouldn't interfere with normal flow.
      console.error('Failed to log Supabase error response', e);
    }
  }

  return res;
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  global: { fetch: fetchWithLogging },
});

export default supabase;
