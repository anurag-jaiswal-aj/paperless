/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Responses from './Responses';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import api from '../utils/api';

vi.mock('../utils/api');

const createMockStore = (initialState) => {
  return {
    getState: () => initialState,
    dispatch: vi.fn(),
    subscribe: vi.fn()
  };
};

describe('Responses Phase 7 AI Features', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      auth: { user: { id: 'user1' } },
      theme: { theme: 'light' }
    });
    vi.clearAllMocks();

    // Mock initial data load
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({ data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } } });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({ data: { success: true, data: [{ _id: 'r1', answers: [] }, { _id: 'r2', answers: [] }], pagination: { pages: 1, page: 1 } } });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({ data: { success: true, data: { totalResponses: 2, analytics: [] } } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  const renderComponent = () => {
    return render(
      <Provider store={store}>
        <BrowserRouter>
          <Responses />
        </BrowserRouter>
      </Provider>
    );
  };

  it('renders AI Summary and handles summary generation', async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('AI Summary')).toBeTruthy();
    });

    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          overview: 'Overall summary',
          keyInsights: [{ title: 'Insight 1', explanation: 'Detail', sentiment: 'positive' }],
          caveats: ['Small sample size']
        }
      }
    });

    const generateBtn = screen.getByRole('button', { name: /Generate Summary/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(screen.getByText('Overall summary')).toBeTruthy();
      expect(screen.getByText('Insight 1:')).toBeTruthy();
      expect(screen.getByText('Small sample size')).toBeTruthy();
    });
  });

  it('handles Theme Extraction', async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Theme Extraction')).toBeTruthy();
    });

    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          themes: [{
            name: 'Theme 1',
            description: 'Theme desc',
            supportingResponses: ['Response 1'],
            sentiment: 'neutral'
          }]
        }
      }
    });

    const extractBtn = screen.getByRole('button', { name: /Extract Themes/i });
    fireEvent.click(extractBtn);

    await waitFor(() => {
      expect(screen.getByText('Theme 1')).toBeTruthy();
      expect(screen.getByText('Theme desc')).toBeTruthy();
      expect(screen.getByText('"Response 1"')).toBeTruthy();
      expect(screen.getByText('neutral')).toBeTruthy();
    });
  });

  it('handles Categorization and handles malformed index gracefully', async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Response Categorization')).toBeTruthy();
    });

    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          categories: [{
            name: 'Category 1',
            description: 'Cat desc',
            responseIndexes: [0, 999] // 999 is out of bounds malformed index
          }],
          uncategorizedResponseIndexes: [1]
        }
      }
    });

    const categorizeBtn = screen.getByRole('button', { name: /Categorize/i });
    fireEvent.click(categorizeBtn);

    await waitFor(() => {
      expect(screen.getByText(/Category 1/i)).toBeTruthy();
      expect(screen.getByText('Cat desc')).toBeTruthy();
      expect(screen.getByText(/Includes Response IDs: #2, #Unknown/i)).toBeTruthy();
      expect(screen.getByText(/Response IDs: #1/i)).toBeTruthy();
    });
  });
});
