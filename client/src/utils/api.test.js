/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api, {
  isAuthEndpoint,
  invalidateAuthSession,
  _resetRefreshState,
  AUTH_LOCK_NAME,
  getActiveSessionId,
  setActiveSessionId,
  getSharedRefreshSeq,
  setSharedRefreshSeq,
  clearLocalAuthState,
  onAuthSessionChange,
  notifyAuthLogin,
  broadcastAuthLogout,
  resolveApiBaseUrl,
  API_URL
} from './api';

describe('API Client and Token Refresh Interceptor', () => {
  let originalLocation;

  beforeEach(() => {
    _resetRefreshState();
    localStorage.clear();
    originalLocation = window.location;
    delete window.location;
    window.location = {
      pathname: '/dashboard',
      href: 'http://localhost:5173/dashboard'
    };
  });

  afterEach(() => {
    window.location = originalLocation;
    try {
      delete navigator.locks;
    } catch (e) {
      navigator.locks = undefined;
    }
    vi.restoreAllMocks();
  });

  it('correctly identifies auth endpoints', () => {
    expect(isAuthEndpoint('/api/auth/login')).toBe(true);
    expect(isAuthEndpoint('/api/auth/register')).toBe(true);
    expect(isAuthEndpoint('/api/auth/forgotpassword')).toBe(true);
    expect(isAuthEndpoint('/api/auth/resetpassword/token123')).toBe(true);
    expect(isAuthEndpoint('/api/auth/logout')).toBe(true);
    expect(isAuthEndpoint('/api/auth/refresh')).toBe(true);
    expect(isAuthEndpoint('/api/forms')).toBe(false);
    expect(isAuthEndpoint('/api/responses/123')).toBe(false);
    expect(isAuthEndpoint('')).toBe(false);
    expect(isAuthEndpoint(null)).toBe(false);
  });

  it('transparently refreshes access token and retries request on 401', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'Old User' }));
    let formsCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        if (formsCallCount === 1) {
          const error = new Error('Request failed with status code 401');
          error.config = config;
          error.response = { status: 401, data: { message: 'Token expired' } };
          throw error;
        }
        return {
          data: { success: true, data: [{ _id: 'f1', title: 'Survey' }] },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return {
          data: {
            success: true,
            data: { user: { id: 'u1', name: 'Refreshed User' } }
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const res = await api.get('/api/forms');
    expect(res.data.success).toBe(true);
    expect(res.data.data[0].title).toBe('Survey');
    expect(formsCallCount).toBe(2);
    expect(refreshCallCount).toBe(1);
    expect(JSON.parse(localStorage.getItem('user')).name).toBe('Refreshed User');
  });

  it('shares a single refresh request across concurrent 401 responses', async () => {
    let formsCallCount = 0;
    let responsesCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        if (formsCallCount === 1) {
          const error = new Error('401');
          error.config = config;
          error.response = { status: 401, data: {} };
          throw error;
        }
        return {
          data: { success: true, data: 'forms-data' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (config.url.includes('/api/responses')) {
        responsesCallCount++;
        if (responsesCallCount === 1) {
          const error = new Error('401');
          error.config = config;
          error.response = { status: 401, data: {} };
          throw error;
        }
        return {
          data: { success: true, data: 'responses-data' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        // Small delay to simulate in-flight refresh
        await new Promise((r) => setTimeout(r, 10));
        return {
          data: { success: true, data: { user: { id: 'u1' } } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const [formsRes, responsesRes] = await Promise.all([
      api.get('/api/forms'),
      api.get('/api/responses')
    ]);

    expect(formsRes.data.data).toBe('forms-data');
    expect(responsesRes.data.data).toBe('responses-data');
    expect(formsCallCount).toBe(2);
    expect(responsesCallCount).toBe(2);
    expect(refreshCallCount).toBe(1);
  });

  it('clears auth state and redirects to login when refresh fails', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1' }));

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        const error = new Error('401');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      if (config.url.includes('/api/auth/refresh')) {
        const error = new Error('Refresh 401');
        error.config = config;
        error.response = { status: 401, data: { message: 'Invalid refresh token' } };
        throw error;
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    await expect(api.get('/api/forms')).rejects.toThrow();
    expect(localStorage.getItem('user')).toBeNull();
    expect(window.location.href).toBe('/login');
  });

  it('does not attempt refresh or redirect for auth endpoints on 401', async () => {
    let refreshCalled = false;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/auth/login')) {
        const error = new Error('Login failed');
        error.config = config;
        error.response = { status: 401, data: { message: 'Invalid credentials' } };
        throw error;
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCalled = true;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    await expect(api.post('/api/auth/login', { email: 'test@example.com', password: 'wrong' })).rejects.toThrow();
    expect(refreshCalled).toBe(false);
    expect(window.location.href).toBe('http://localhost:5173/dashboard');
  });

  it('does not retry indefinitely if retried request fails with 401 again', async () => {
    let formsCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        const error = new Error('401');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return {
          data: { success: true, data: { user: { id: 'u1' } } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    await expect(api.get('/api/forms')).rejects.toThrow();
    expect(refreshCallCount).toBe(1);
    expect(formsCallCount).toBe(2);
    expect(window.location.href).toBe('/login');
  });

  it('does not trigger duplicate navigation if already on /login', async () => {
    window.location.pathname = '/login';
    window.location.href = 'http://localhost:5173/login';

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        const error = new Error('401');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      if (config.url.includes('/api/auth/refresh')) {
        const error = new Error('Refresh 401');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    await expect(api.get('/api/forms')).rejects.toThrow();
    expect(window.location.href).toBe('http://localhost:5173/login');
  });

  it('prevents an in-flight refresh from restoring stale user or retrying requests after logout', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'Original User' }));

    let resolveRefresh;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    let formsCallCount = 0;
    let responsesCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        const error = new Error('401 Forms');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      if (config.url.includes('/api/responses')) {
        responsesCallCount++;
        const error = new Error('401 Responses');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return refreshPromise;
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    // Start request A (initiates refresh)
    const formsPromise = api.get('/api/forms');
    await new Promise((r) => setTimeout(r, 0));

    // Start request B while refresh is in flight (should be queued)
    const responsesPromise = api.get('/api/responses');
    await new Promise((r) => setTimeout(r, 0));

    expect(refreshCallCount).toBe(1);

    // User logs out and clears authentication state
    localStorage.removeItem('user');
    invalidateAuthSession();

    // Now resolve the in-flight refresh with user data
    resolveRefresh({
      data: {
        success: true,
        data: { user: { id: 'u1', name: 'Stale Refreshed User' } }
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { url: '/api/auth/refresh' }
    });

    // Both requests must reject
    await expect(formsPromise).rejects.toThrow('Session invalidated');
    await expect(responsesPromise).rejects.toThrow('Session invalidated');

    // Verify localStorage was NOT rewritten with stale user
    expect(localStorage.getItem('user')).toBeNull();

    // Verify neither request was retried
    expect(formsCallCount).toBe(1);
    expect(responsesCallCount).toBe(1);
  });

  it('rejects all concurrent requests and clears queue when shared refresh fails', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1' }));

    let refreshCallCount = 0;
    let rejectRefresh;
    const refreshPromise = new Promise((_, reject) => {
      rejectRefresh = reject;
    });

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms') || config.url.includes('/api/responses')) {
        const error = new Error('401');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return refreshPromise;
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const formsPromise = api.get('/api/forms');
    await new Promise((r) => setTimeout(r, 0));

    const responsesPromise = api.get('/api/responses');
    await new Promise((r) => setTimeout(r, 0));

    expect(refreshCallCount).toBe(1);

    const refreshError = new Error('Refresh 401');
    refreshError.config = { url: '/api/auth/refresh' };
    refreshError.response = { status: 401, data: { message: 'Invalid refresh token' } };
    rejectRefresh(refreshError);

    await expect(formsPromise).rejects.toThrow('Refresh 401');
    await expect(responsesPromise).rejects.toThrow('Refresh 401');

    expect(localStorage.getItem('user')).toBeNull();
    expect(window.location.href).toBe('/login');
  });

  it('delivers original request error to queued caller when retried request fails with non-401 without redirect', async () => {
    let formsCallCount = 0;
    let responsesCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        if (formsCallCount === 1) {
          const error = new Error('401');
          error.config = config;
          error.response = { status: 401, data: {} };
          throw error;
        }
        return {
          data: { success: true, data: 'forms-ok' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (config.url.includes('/api/responses')) {
        responsesCallCount++;
        if (responsesCallCount === 1) {
          const error = new Error('401');
          error.config = config;
          error.response = { status: 401, data: {} };
          throw error;
        }
        const error500 = new Error('Database error');
        error500.config = config;
        error500.response = { status: 500, data: { message: 'Database connection failed' } };
        throw error500;
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return {
          data: { success: true, data: { user: { id: 'u1' } } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const formsPromise = api.get('/api/forms');
    const responsesPromise = api.get('/api/responses');

    const [formsRes, responsesResult] = await Promise.allSettled([
      formsPromise,
      responsesPromise
    ]);

    expect(formsRes.status).toBe('fulfilled');
    expect(formsRes.value.data.data).toBe('forms-ok');
    expect(refreshCallCount).toBe(1);

    expect(responsesResult.status).toBe('rejected');
    const capturedError = responsesResult.reason;
    expect(capturedError).toBeDefined();
    expect(capturedError.response?.status).toBe(500);
    expect(capturedError.response?.data?.message).toBe('Database connection failed');

    // Confirm that non-401 failure did not cause an auth redirect to /login
    expect(window.location.href).toBe('http://localhost:5173/dashboard');
  });

  it('manages shared refresh sequence counter in localStorage', () => {
    expect(getSharedRefreshSeq()).toBe(0);
    setSharedRefreshSeq(5);
    expect(getSharedRefreshSeq()).toBe(5);
    expect(localStorage.getItem('auth_refresh_seq')).toBe('5');
  });

  it('manages active session ID in localStorage', () => {
    expect(getActiveSessionId()).toBeNull();
    setActiveSessionId('sess-xyz');
    expect(getActiveSessionId()).toBe('sess-xyz');
    expect(localStorage.getItem('auth_session_id')).toBe('sess-xyz');
    setActiveSessionId(null);
    expect(getActiveSessionId()).toBeNull();
    expect(localStorage.getItem('auth_session_id')).toBeNull();
  });

  it('clears local auth state including user and auth_session_id', () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1' }));
    localStorage.setItem('auth_session_id', 'sess-123');
    clearLocalAuthState();
    expect(localStorage.getItem('user')).toBeNull();
    expect(localStorage.getItem('auth_session_id')).toBeNull();
  });

  it('uses Web Locks API to coordinate cross-tab refresh and bypasses refresh call if another tab already bumped sequence', async () => {
    let refreshCallCount = 0;
    let formsCallCount = 0;

    const mockRequest = vi.fn(async (lockName, callback) => {
      // Simulate another tab acquiring the lock first and incrementing the sequence
      setSharedRefreshSeq(getSharedRefreshSeq() + 1);
      return callback();
    });
    Object.defineProperty(navigator, 'locks', {
      value: { request: mockRequest },
      configurable: true,
      writable: true
    });

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        if (formsCallCount === 1) {
          const error = new Error('401');
          error.config = config;
          error.response = { status: 401, data: {} };
          throw error;
        }
        return {
          data: { success: true, data: 'forms-after-cross-tab-refresh' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const res = await api.get('/api/forms');
    expect(res.data.data).toBe('forms-after-cross-tab-refresh');
    expect(mockRequest).toHaveBeenCalledWith(AUTH_LOCK_NAME, expect.any(Function));
    expect(refreshCallCount).toBe(0);
    expect(formsCallCount).toBe(2);
  });

  it('falls back gracefully and refreshes normally when navigator.locks is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', {
      value: undefined,
      configurable: true,
      writable: true
    });

    let formsCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        if (formsCallCount === 1) {
          const error = new Error('401');
          error.config = config;
          error.response = { status: 401, data: {} };
          throw error;
        }
        return {
          data: { success: true, data: 'forms-fallback-ok' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return {
          data: { success: true, data: { user: { id: 'u1' } } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const res = await api.get('/api/forms');
    expect(res.data.data).toBe('forms-fallback-ok');
    expect(refreshCallCount).toBe(1);
    expect(formsCallCount).toBe(2);
  });

  it('recovers by retrying request when refresh endpoint fails but another tab refreshed concurrently', async () => {
    let formsCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        if (formsCallCount === 1) {
          const error = new Error('401');
          error.config = config;
          error.response = { status: 401, data: {} };
          throw error;
        }
        return {
          data: { success: true, data: 'forms-recovered' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        // Simulate that another tab refreshed concurrently and bumped the sequence
        setSharedRefreshSeq(getSharedRefreshSeq() + 1);
        const error = new Error('Refresh rejected due to concurrent rotation');
        error.config = config;
        error.response = { status: 401, data: { message: 'Token rotated' } };
        throw error;
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const res = await api.get('/api/forms');
    expect(res.data.data).toBe('forms-recovered');
    expect(refreshCallCount).toBe(1);
    expect(formsCallCount).toBe(2);
    // Did not redirect to login because recovery succeeded
    expect(window.location.href).toBe('http://localhost:5173/dashboard');
  });

  it('broadcasts and handles cross-tab logout', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'User 1' }));
    setActiveSessionId('sess-1');

    const listener = vi.fn();
    const unsubscribe = onAuthSessionChange(listener);

    broadcastAuthLogout();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOGOUT' })
    );
    expect(localStorage.getItem('user')).toBeNull();
    expect(getActiveSessionId()).toBeNull();

    unsubscribe();
  });

  it('broadcasts and handles cross-tab login', () => {
    const listener = vi.fn();
    const unsubscribe = onAuthSessionChange(listener);

    notifyAuthLogin({ id: 'u2', name: 'New User' });

    expect(getActiveSessionId()).toBeTruthy();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LOGIN',
        user: { id: 'u2', name: 'New User' }
      })
    );

    unsubscribe();
  });

  it('isolates and aborts in-flight refresh when active session ID changes due to cross-tab login', async () => {
    setActiveSessionId('sess-tab1');
    localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'User 1' }));

    let resolveRefresh;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    let formsCallCount = 0;
    let refreshCallCount = 0;

    api.defaults.adapter = async (config) => {
      if (config.url.includes('/api/forms')) {
        formsCallCount++;
        const error = new Error('401');
        error.config = config;
        error.response = { status: 401, data: {} };
        throw error;
      }

      if (config.url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return refreshPromise;
      }

      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    const formsPromise = api.get('/api/forms');
    await new Promise((r) => setTimeout(r, 0));

    expect(refreshCallCount).toBe(1);

    // Another tab logs in as a different user
    notifyAuthLogin({ id: 'u2', name: 'User 2' });

    // Now resolve the old in-flight refresh
    resolveRefresh({
      data: {
        success: true,
        data: { user: { id: 'u1', name: 'Stale User 1' } }
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { url: '/api/auth/refresh' }
    });

    await expect(formsPromise).rejects.toThrow('Session invalidated');
    // Stale user was NOT written back to localStorage
    expect(JSON.parse(localStorage.getItem('user')).name).not.toBe('Stale User 1');
    expect(formsCallCount).toBe(1);
  });

  it('handles incoming storage event fallback for cross-tab sync', () => {
    const listener = vi.fn();
    const unsubscribe = onAuthSessionChange(listener);
    localStorage.setItem('user', JSON.stringify({ id: 'u1' }));

    const storagePayload = JSON.stringify({
      type: 'LOGOUT',
      timestamp: Date.now()
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'auth_sync_event',
        newValue: storagePayload
      })
    );

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOGOUT' })
    );
    expect(localStorage.getItem('user')).toBeNull();

    unsubscribe();
  });

  describe('resolveApiBaseUrl', () => {
    it('defaults to empty string for relative proxy requests when no variables set', () => {
      expect(resolveApiBaseUrl({})).toBe('');
      expect(resolveApiBaseUrl(undefined)).toBe('');
      expect(resolveApiBaseUrl({ VITE_API_URL: '', VITE_BACKEND_URL: '' })).toBe('');
      expect(resolveApiBaseUrl({ VITE_API_URL: '   ' })).toBe('');
    });

    it('prefers VITE_BACKEND_URL or VITE_API_URL when explicitly specified', () => {
      expect(
        resolveApiBaseUrl({ VITE_API_URL: 'https://api.paperless.example.com' })
      ).toBe('https://api.paperless.example.com');

      expect(
        resolveApiBaseUrl({
          VITE_BACKEND_URL: 'https://backend.paperless.example.com',
          VITE_API_URL: 'https://fallback.paperless.example.com'
        })
      ).toBe('https://backend.paperless.example.com');
    });

    it('trims whitespace around configured URL', () => {
      expect(
        resolveApiBaseUrl({ VITE_API_URL: '  https://custom.api.com  ' })
      ).toBe('https://custom.api.com');
    });

    it('current module exports default API_URL without hardcoded localhost:5001 fallback', () => {
      expect(API_URL).not.toBe('http://localhost:5001');
    });
  });
});

