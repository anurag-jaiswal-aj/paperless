/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import Navbar from './Navbar';
import authReducer from '../store/authSlice';
import themeReducer from '../store/themeSlice';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    post: vi.fn()
  }
}));

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
});
