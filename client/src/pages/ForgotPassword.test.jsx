/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import ForgotPassword from './ForgotPassword';
import api from '../utils/api';

vi.mock('../utils/api', () => {
  return {
    default: {
      post: vi.fn()
    }
  };
});

describe('ForgotPassword Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders correctly', () => {
    render(
      <BrowserRouter>
        <ForgotPassword />
      </BrowserRouter>
    );
    expect(screen.getByText('Reset Password')).toBeTruthy();
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
  });

  it('handles successful forgot password request', async () => {
    api.post.mockResolvedValueOnce({
      data: { success: true, message: 'Reset link sent' }
    });

    render(
      <BrowserRouter>
        <ForgotPassword />
      </BrowserRouter>
    );

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'test@example.com' }
    });

    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/auth/forgotpassword', {
        email: 'test@example.com'
      });
      expect(screen.getByText('Reset link sent')).toBeTruthy();
    });
  });
});
