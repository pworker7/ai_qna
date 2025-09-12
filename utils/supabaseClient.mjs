import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Supabase credentials are not set');
}

/**
 * Custom fetch that logs details when a request fails (including XML bodies).
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
const fetchWithLogging = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.ok) {
    try {
      const headers = Object.fromEntries(res.headers.entries());
      console.error('Supabase request failed', {
        status: res.status,
        headers,
      });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (
        ct.includes('text/html') ||
        ct.includes('application/xml') ||
        ct.includes('text/xml') ||
        ct.startsWith('text/')
      ) {
        const body = await res.text();
        console.error('Supabase error URL:', res.url);
        console.error('Supabase error body:', body);
      }
    } catch (e) {
      console.error('Failed to log Supabase error response', e);
    }
  }
  return res;
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  global: {
    fetch: fetchWithLogging,
    headers: { Accept: 'application/json' },
  },
});

export default supabase;
