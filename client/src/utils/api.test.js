/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api, { isAuthEndpoint, invalidateAuthSession, _resetRefreshState } from './api';

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
});

