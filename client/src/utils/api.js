import axios from 'axios';

const configuredUrl =
  import.meta.env.VITE_BACKEND_URL || import.meta.env.VITE_API_URL;

const API_URL = import.meta.env.DEV
  ? ''
  : (configuredUrl !== undefined ? configuredUrl : 'http://localhost:5001');

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

let isRefreshing = false;
let failedQueue = [];
let currentSessionGeneration = 0;

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
      localStorage.removeItem('user');
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      return Promise.reject(error);
    }

    // If a refresh is already in flight, queue this request
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject, config: originalRequest });
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;
    const sessionGeneration = currentSessionGeneration;

    return new Promise((resolve, reject) => {
      api
        .post('/api/auth/refresh')
        .then((res) => {
          // If session was invalidated during in-flight refresh (e.g. user logged out),
          // discard the refresh result and do not restore user or process queue.
          if (sessionGeneration !== currentSessionGeneration) {
            const sessionError = new Error('Session invalidated');
            sessionError.isSessionTerminated = true;
            return reject(sessionError);
          }

          if (res.data?.data?.user) {
            localStorage.setItem('user', JSON.stringify(res.data.data.user));
          }
          processQueue(null);
          resolve(api(originalRequest));
        })
        .catch((refreshErr) => {
          if (sessionGeneration !== currentSessionGeneration) {
            const sessionError = new Error('Session invalidated');
            sessionError.isSessionTerminated = true;
            return reject(sessionError);
          }

          processQueue(refreshErr);
          localStorage.removeItem('user');
          if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
          reject(refreshErr);
        })
        .finally(() => {
          if (sessionGeneration === currentSessionGeneration) {
            isRefreshing = false;
          }
        });
    });
  }
);

api.invalidateAuthSession = invalidateAuthSession;

export default api;
