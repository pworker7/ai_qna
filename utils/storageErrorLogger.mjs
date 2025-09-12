import { StorageUnknownError } from '@supabase/storage-js';

/**
 * Logs detailed information when a StorageUnknownError occurs.
 * @param {Error} error
 */
export async function logStorageError(error) {
  if (error instanceof StorageUnknownError) {
    const res = error.originalError;
    try {
      if (res?.status) {
        console.error('StorageUnknownError status:', res.status);
      }
      const headers = res?.headers;
      if (headers) {
        const headerObj = Object.fromEntries(headers.entries());
        console.error('StorageUnknownError headers:', headerObj);
        const contentType = headers.get('content-type');
        if (contentType && contentType.includes('text/html')) {
          const body = await res.text();
          console.error('StorageUnknownError body:', body);
        }
      }
    } catch (e) {
      console.error('Failed to log StorageUnknownError details:', e);
    }
  }
}

export default logStorageError;
