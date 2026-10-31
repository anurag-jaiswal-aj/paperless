/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import ResetPassword from './ResetPassword';
import authReducer from '../store/authSlice';
import api from '../utils/api';

vi.mock('../utils/api', () => {
  return {
    default: {
      put: vi.fn()
    }
  };
});

const renderWithProviders = (ui, initialPath = '/resetpassword/testtoken') => {
  const store = configureStore({
    reducer: {
      auth: authReducer
    }
  });
  window.history.pushState({}, 'Test', initialPath);
  return render(
    <Provider store={store}>
      <BrowserRouter>
        <Routes>
          <Route path="/resetpassword/:token" element={ui} />
          <Route path="/reset-password/:token" element={ui} />
          <Route path="/reset-password" element={ui} />
          <Route path="/resetpassword" element={ui} />
        </Routes>
      </BrowserRouter>
    </Provider>
  );
};

describe('ResetPassword Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, 'Test', '/resetpassword/testtoken');
  });

  it('renders correctly', () => {
    renderWithProviders(<ResetPassword />);
    expect(screen.getByText('Create New Password')).toBeTruthy();
  });

  it('shows error if passwords do not match', async () => {
    renderWithProviders(<ResetPassword />);

    const passwordInputs = screen.getAllByPlaceholderText('••••••••');

    fireEvent.change(passwordInputs[0], { target: { value: 'password123' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'password456' } });

    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    expect(screen.getByText('Passwords do not match')).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('handles successful reset password with route param token', async () => {
    api.put.mockResolvedValueOnce({
      data: { success: true, data: { user: { id: '1' } } }
    });

    renderWithProviders(<ResetPassword />);

    const passwordInputs = screen.getAllByPlaceholderText('••••••••');

    fireEvent.change(passwordInputs[0], { target: { value: 'password123' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'password123' } });

    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/auth/resetpassword', {
        token: 'testtoken',
        password: 'password123'
      });
      expect(screen.getByText('Password reset successfully! Logging you in...')).toBeTruthy();
    });
  });

  it('handles successful reset password with query param token', async () => {
    api.put.mockResolvedValueOnce({
      data: { success: true, data: { user: { id: '2' } } }
    });

    renderWithProviders(<ResetPassword />, '/reset-password?token=query_token_abc123');

    const passwordInputs = screen.getAllByPlaceholderText('••••••••');

    fireEvent.change(passwordInputs[0], { target: { value: 'newsecret987' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'newsecret987' } });

    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/auth/resetpassword', {
        token: 'query_token_abc123',
        password: 'newsecret987'
      });
      expect(screen.getByText('Password reset successfully! Logging you in...')).toBeTruthy();
    });
  });
});
