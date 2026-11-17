/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import Navbar from './Navbar';
import Home from '../pages/Home';
import authReducer from '../store/authSlice';
import themeReducer from '../store/themeSlice';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    post: vi.fn()
  }
}));

beforeAll(() => {
  window.matchMedia = window.matchMedia || function (query) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    };
  };

  global.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const renderNavbar = (
  initialAuthState = { isAuthenticated: false, user: null },
  initialRoute = '/dashboard'
) => {
  const store = configureStore({
    reducer: {
      auth: authReducer,
      theme: themeReducer
    },
    preloadedState: {
      auth: initialAuthState,
      theme: { theme: 'light' }
    }
  });

  const renderResult = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Navbar />
      </MemoryRouter>
    </Provider>
  );

  return { ...renderResult, store };
};

describe('Navbar Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders unauthenticated navigation when logged out on app pages', () => {
    renderNavbar({ isAuthenticated: false, user: null }, '/dashboard');

    expect(screen.getByText('Login')).toBeTruthy();
    expect(screen.getByText('Sign Up')).toBeTruthy();
    expect(screen.queryByText('Logout')).toBeNull();
  });

  it('renders unauthenticated navigation when logged out on landing page', () => {
    renderNavbar({ isAuthenticated: false, user: null }, '/');

    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.getByText('Get Started')).toBeTruthy();
    expect(screen.queryByText('Logout')).toBeNull();
  });

  it('calls backend logout and clears local auth state on logout click', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true } });

    const { store } = renderNavbar({
      isAuthenticated: true,
      user: { id: 'u1', name: 'Test User' }
    });

    const logoutBtn = screen.getByRole('button', { name: /logout/i });
    expect(logoutBtn).toBeTruthy();

    fireEvent.click(logoutBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/auth/logout');
      expect(store.getState().auth.isAuthenticated).toBe(false);
      expect(store.getState().auth.user).toBeNull();
    });
  });

  it('clears local auth state even if backend logout fails', async () => {
    api.post.mockRejectedValueOnce(new Error('Network error'));

    const { store } = renderNavbar({
      isAuthenticated: true,
      user: { id: 'u1', name: 'Test User' }
    });

    const logoutBtn = screen.getByRole('button', { name: /logout/i });
    fireEvent.click(logoutBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/auth/logout');
      expect(store.getState().auth.isAuthenticated).toBe(false);
      expect(store.getState().auth.user).toBeNull();
    });
  });

  it('prevents duplicate logout requests while in progress', async () => {
    let resolveLogout;
    const logoutPromise = new Promise((resolve) => {
      resolveLogout = resolve;
    });
    api.post.mockReturnValueOnce(logoutPromise);

    renderNavbar({
      isAuthenticated: true,
      user: { id: 'u1', name: 'Test User' }
    });

    const logoutBtn = screen.getByRole('button', { name: /logout/i });
    fireEvent.click(logoutBtn);
    fireEvent.click(logoutBtn);

    expect(api.post).toHaveBeenCalledTimes(1);

    resolveLogout({ data: { success: true } });
    await waitFor(() => {
      expect(screen.getByText('Login')).toBeTruthy();
    });
  });

  describe('Landing Page Anchors & Navigation', () => {
    it('renders corrected anchor links pointing to valid section IDs', () => {
      renderNavbar({ isAuthenticated: false, user: null }, '/');

      const productLink = screen.getByRole('link', { name: 'Product' });
      const workflowLink = screen.getByRole('link', { name: 'Workflow' });
      const intelligenceLink = screen.getByRole('link', { name: 'Intelligence' });

      // Assert corrected target anchors
      expect(productLink.getAttribute('href')).toBe('/#landing-workflow');
      expect(workflowLink.getAttribute('href')).toBe('/#landing-overview');
      expect(intelligenceLink.getAttribute('href')).toBe('/#landing-creation');

      // Regression assertions: ensure dead anchors are never reintroduced
      expect(productLink.getAttribute('href')).not.toBe('/#product');
      expect(intelligenceLink.getAttribute('href')).not.toBe('/#intelligence');

      // Documentation label is displayed
      expect(screen.getByText('Documentation')).toBeTruthy();
    });

    it('renders authenticated navigation controls when logged in on landing page', () => {
      renderNavbar({
        isAuthenticated: true,
        user: { id: 'u1', name: 'Alice Smith' }
      }, '/');

      expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
      expect(screen.getByRole('button', { name: /logout/i })).toBeTruthy();
      expect(screen.getByText('A')).toBeTruthy();

      expect(screen.queryByText('Sign in')).toBeNull();
      expect(screen.queryByText('Get Started')).toBeNull();
    });

    it('toggles theme state in Redux store when theme button is clicked', () => {
      const { store } = renderNavbar({ isAuthenticated: false, user: null }, '/');

      expect(store.getState().theme.theme).toBe('light');

      const themeToggleBtn = screen.getByRole('button', { name: /toggle theme/i });
      fireEvent.click(themeToggleBtn);
      expect(store.getState().theme.theme).toBe('dark');

      fireEvent.click(themeToggleBtn);
      expect(store.getState().theme.theme).toBe('light');
    });
  });

  describe('Navbar & Home Section Contract Integration', () => {
    it('ensures every landing page anchor in Navbar corresponds to an existing DOM section id in Home', () => {
      const store = configureStore({
        reducer: {
          auth: authReducer,
          theme: themeReducer
        },
        preloadedState: {
          auth: { isAuthenticated: false, user: null },
          theme: { theme: 'light' }
        }
      });

      const { container } = render(
        <Provider store={store}>
          <MemoryRouter initialEntries={['/']}>
            <Navbar />
            <Home />
          </MemoryRouter>
        </Provider>
      );

      // Find all anchor links inside the landing header nav
      const navAnchors = Array.from(container.querySelectorAll('header nav a[href*="#"]'));
      expect(navAnchors.length).toBeGreaterThanOrEqual(3);

      navAnchors.forEach((link) => {
        const href = link.getAttribute('href');
        const targetId = href.split('#')[1];
        expect(targetId).toBeTruthy();

        const targetEl = container.querySelector(`#${targetId}`);
        expect(
          targetEl,
          `Expected element with id="#${targetId}" for link "${link.textContent}" to exist in Home`
        ).not.toBeNull();
      });
    });
  });
});
