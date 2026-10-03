/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import Login from './Login';
import authReducer from '../store/authSlice';
import themeReducer from '../store/themeSlice';
import api from '../utils/api';

vi.mock('../utils/api', () => {
  return {
    default: {
      post: vi.fn()
    }
  };
});

const renderWithProviders = (ui, { preloadedState = {} } = {}) => {
  const store = configureStore({
    reducer: {
      auth: authReducer,
      theme: themeReducer
    },
    preloadedState
  });
  return render(
    <Provider store={store}>
      <BrowserRouter>{ui}</BrowserRouter>
    </Provider>
  );
};

describe('Login Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders login form elements', () => {
    renderWithProviders(<Login />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
    expect(screen.getByPlaceholderText('••••••••')).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
    expect(screen.getByText(/forgot password\?/i)).toBeTruthy();
  });

  it('handles successful login', async () => {
    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          user: { id: '1', name: 'Test User', email: 'test@example.com' }
        }
      }
    });

    renderWithProviders(<Login />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'test@example.com' }
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'password123' }
    });

    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/auth/login', {
        email: 'test@example.com',
        password: 'password123'
      });
    });
  });

  it('displays error on failed login', async () => {
    api.post.mockRejectedValueOnce({
      response: { data: { message: 'Invalid credentials' } }
    });

    renderWithProviders(<Login />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'test@example.com' }
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'wrongpassword' }
    });

    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeTruthy();
    });
  });
});
