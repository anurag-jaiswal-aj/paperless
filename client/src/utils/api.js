import axios from 'axios';

export const resolveApiBaseUrl = (env = import.meta.env) => {
  const configured = env?.VITE_BACKEND_URL || env?.VITE_API_URL;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim();
  }
  // Default to relative base URL ('') in both dev and production
  // so that Vite proxy and Nginx reverse proxy work seamlessly without localhost leakage.
  return '';
};

export const API_URL = resolveApiBaseUrl();

// Create axios instance
const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

const AUTH_ENDPOINTS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgotpassword',
  '/api/auth/resetpassword',
  '/api/auth/logout',
  '/api/auth/refresh'
];

export const isAuthEndpoint = (url) => {
  if (!url || typeof url !== 'string') return false;
  return AUTH_ENDPOINTS.some((endpoint) => url.includes(endpoint));
};

export const AUTH_LOCK_NAME = 'paperless_auth_refresh_lock';
export const AUTH_CHANNEL_NAME = 'paperless_auth_sync';

let isRefreshing = false;
let failedQueue = [];
let currentSessionGeneration = 0;
let authChannel = null;
let sessionListeners = [];

export const getActiveSessionId = () => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem('auth_session_id');
};

export const setActiveSessionId = (id) => {
  if (typeof localStorage === 'undefined') return;
  if (id) {
    localStorage.setItem('auth_session_id', id);
  } else {
    localStorage.removeItem('auth_session_id');
  }
};

export const getSharedRefreshSeq = () => {
  if (typeof localStorage === 'undefined') return 0;
  const val = localStorage.getItem('auth_refresh_seq');
  return val ? parseInt(val, 10) : 0;
};

export const setSharedRefreshSeq = (seq) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem('auth_refresh_seq', String(seq));
};

export const clearLocalAuthState = () => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('user');
    localStorage.removeItem('auth_session_id');
  }
};

const getAuthChannel = () => {
  if (authChannel) return authChannel;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
      authChannel.onmessage = (event) => {
        handleIncomingAuthSync(event.data);
      };
    } catch (e) {
      authChannel = null;
    }
  }
  return authChannel;
};

// Also listen on window storage events as fallback
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'auth_sync_event' && e.newValue) {
      try {
        const data = JSON.parse(e.newValue);
        handleIncomingAuthSync(data);
      } catch (err) {
        // Ignore malformed storage events
      }
    }
  });
}

const handleIncomingAuthSync = (data) => {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'LOGOUT') {
    invalidateAuthSession();
    clearLocalAuthState();
    notifySessionListeners(data);
  } else if (data.type === 'LOGIN') {
    currentSessionGeneration += 1;
    if (data.sessionId) {
      setActiveSessionId(data.sessionId);
    }
    notifySessionListeners(data);
  } else if (data.type === 'REFRESH_SUCCESS') {
    if (data.seq && data.seq > getSharedRefreshSeq()) {
      setSharedRefreshSeq(data.seq);
    }
  }
};

export const onAuthSessionChange = (callback) => {
  sessionListeners.push(callback);
  getAuthChannel();
  return () => {
    sessionListeners = sessionListeners.filter((cb) => cb !== callback);
  };
};

const notifySessionListeners = (event) => {
  sessionListeners.forEach((cb) => {
    try {
      cb(event);
    } catch (e) {
      // Ignore listener error
    }
  });
};

export const broadcastAuthEvent = (event) => {
  const channel = getAuthChannel();
  if (channel) {
    try {
      channel.postMessage(event);
    } catch (e) {
      // BroadcastChannel postMessage error ignored
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('auth_sync_event', JSON.stringify({ ...event, _t: Date.now() }));
    } catch (e) {
      // LocalStorage write error ignored
    }
  }
};

export const notifyAuthLogin = (user) => {
  const newSessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  setActiveSessionId(newSessionId);
  currentSessionGeneration += 1;
  const event = {
    type: 'LOGIN',
    sessionId: newSessionId,
    user,
    timestamp: Date.now()
  };
  broadcastAuthEvent(event);
  notifySessionListeners(event);
};

export const broadcastAuthLogout = () => {
  invalidateAuthSession();
  clearLocalAuthState();
  const event = {
    type: 'LOGOUT',
    timestamp: Date.now()
  };
  broadcastAuthEvent(event);
  notifySessionListeners(event);
};

export const invalidateAuthSession = () => {
  currentSessionGeneration += 1;
  isRefreshing = false;
  const sessionError = new Error('Session invalidated');
  sessionError.isSessionTerminated = true;
  failedQueue.forEach((prom) => {
    prom.reject(sessionError);
  });
  failedQueue = [];
};

export const _resetRefreshState = () => {
  currentSessionGeneration += 1;
  isRefreshing = false;
  failedQueue = [];
  sessionListeners = [];
};

const processQueue = (error) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.config._retry = true;
      prom.resolve(api(prom.config));
    }
  });
  failedQueue = [];
};

const runWithLock = async (callback) => {
  if (
    typeof navigator !== 'undefined' &&
    navigator.locks &&
    typeof navigator.locks.request === 'function'
  ) {
    return navigator.locks.request(AUTH_LOCK_NAME, callback);
  }
  return callback();
};

// Response interceptor to handle errors and transparent token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Only process 401 Unauthorized responses
    if (error.response?.status !== 401) {
      return Promise.reject(error);
    }

    // Exclude auth endpoints from automatic refresh and generic redirect
    if (!originalRequest || isAuthEndpoint(originalRequest.url)) {
      return Promise.reject(error);
    }

    // Prevent infinite retry loops if this request has already been retried
    if (originalRequest._retry) {
      clearLocalAuthState();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      return Promise.reject(error);
    }

    // If a refresh is already in flight within this tab, queue this request
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject, config: originalRequest });
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    const startSessionGeneration = currentSessionGeneration;
    const startSessionId = getActiveSessionId();
    const startRefreshSeq = getSharedRefreshSeq();

    return runWithLock(async () => {
      // 1. Check if session was invalidated while waiting for the lock
      if (
        startSessionGeneration !== currentSessionGeneration ||
        (startSessionId !== null && startSessionId !== getActiveSessionId())
      ) {
        const sessionError = new Error('Session invalidated');
        sessionError.isSessionTerminated = true;
        processQueue(sessionError);
        return Promise.reject(sessionError);
      }

      // 2. Check if another tab refreshed the session while waiting for lock
      const currentRefreshSeq = getSharedRefreshSeq();
      if (currentRefreshSeq > startRefreshSeq) {
        // Another tab refreshed! Retry original request directly with current cookies
        try {
          processQueue(null);
          return await api(originalRequest);
        } catch (retryErr) {
          return Promise.reject(retryErr);
        }
      }

      // 3. This tab performs the refresh
      return new Promise((resolve, reject) => {
        api
          .post('/api/auth/refresh')
          .then((res) => {
            if (
              startSessionGeneration !== currentSessionGeneration ||
              (startSessionId !== null && startSessionId !== getActiveSessionId())
            ) {
              const sessionError = new Error('Session invalidated');
              sessionError.isSessionTerminated = true;
              if (!getActiveSessionId()) {
                api.post('/api/auth/logout').catch(() => {
                  // Ignore background logout cleanup failure
                });
              }
              return reject(sessionError);
            }

            const nextSeq = currentRefreshSeq + 1;
            setSharedRefreshSeq(nextSeq);

            if (res.data?.data?.user) {
              localStorage.setItem('user', JSON.stringify(res.data.data.user));
            }

            broadcastAuthEvent({
              type: 'REFRESH_SUCCESS',
              sessionId: startSessionId,
              seq: nextSeq,
              timestamp: Date.now()
            });

            processQueue(null);
            resolve(api(originalRequest));
          })
          .catch(async (refreshErr) => {
            // Check if another tab refreshed concurrently while our request was in transit
            const latestSeq = getSharedRefreshSeq();
            if (latestSeq > startRefreshSeq) {
              try {
                processQueue(null);
                const retried = await api(originalRequest);
                return resolve(retried);
              } catch (retryErr) {
                // fall through to reject
              }
            }

            if (
              startSessionGeneration !== currentSessionGeneration ||
              (startSessionId !== null && startSessionId !== getActiveSessionId())
            ) {
              const sessionError = new Error('Session invalidated');
              sessionError.isSessionTerminated = true;
              if (!getActiveSessionId()) {
                api.post('/api/auth/logout').catch(() => {
                  // Ignore background logout cleanup failure
                });
              }
              return reject(sessionError);
            }

            processQueue(refreshErr);
            clearLocalAuthState();
            broadcastAuthLogout();
            if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
              window.location.href = '/login';
            }
            reject(refreshErr);
          })
          .finally(() => {
            if (startSessionGeneration === currentSessionGeneration) {
              isRefreshing = false;
            }
          });
      });
    }).finally(() => {
      if (startSessionGeneration === currentSessionGeneration) {
        isRefreshing = false;
      }
    });
  }
);

api.invalidateAuthSession = invalidateAuthSession;
api.broadcastAuthLogout = broadcastAuthLogout;
api.notifyAuthLogin = notifyAuthLogin;
api.onAuthSessionChange = onAuthSessionChange;

export default api;
