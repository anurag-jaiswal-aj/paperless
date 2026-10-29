/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Responses from './Responses';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import api from '../utils/api';

vi.mock('../utils/api');

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      if (this.callback) {
        this.callback([{ target, contentRect: { width: 500, height: 300 } }]);
      }
    }
    unobserve() {}
    disconnect() {}
  };
});

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

  it('renders choice question analytics using distribution structure without crashing', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({ data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } } });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({ data: { success: true, data: [{ _id: 'r1', answers: [] }], pagination: { pages: 1, page: 1 } } });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              totalResponses: 2,
              analytics: [
                {
                  questionId: 'q-choice',
                  label: 'Preferred Platform',
                  type: 'single_choice',
                  totalAnswers: 2,
                  data: {
                    type: 'options',
                    distribution: [
                      { option: 'Web', count: 2, percentage: 100 },
                      { option: 'Mobile', count: 0, percentage: 0 }
                    ],
                    totalSelections: 2
                  }
                }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Preferred Platform')).toBeTruthy();
      expect(screen.getByText('2 answers')).toBeTruthy();
    });
  });

  it('handles empty choice distribution safely', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({ data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } } });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({ data: { success: true, data: [{ _id: 'r1', answers: [] }], pagination: { pages: 1, page: 1 } } });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              totalResponses: 0,
              analytics: [
                {
                  questionId: 'q-choice-empty',
                  label: 'Empty Choice Question',
                  type: 'single_choice',
                  totalAnswers: 0,
                  data: {
                    type: 'options',
                    distribution: [],
                    totalSelections: 0
                  }
                }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Empty Choice Question')).toBeTruthy();
      expect(screen.getByText('No options data available')).toBeTruthy();
    });
  });

  it('renders numeric question analytics with min, max, and average', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({ data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } } });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({ data: { success: true, data: [{ _id: 'r1', answers: [] }], pagination: { pages: 1, page: 1 } } });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              totalResponses: 3,
              analytics: [
                {
                  questionId: 'q-number',
                  label: 'Rate your team size',
                  type: 'number',
                  totalAnswers: 3,
                  data: {
                    type: 'number',
                    min: 5,
                    max: 25,
                    average: 15
                  }
                }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Rate your team size')).toBeTruthy();
      expect(screen.getByText('Average')).toBeTruthy();
      expect(screen.getByText('15')).toBeTruthy();
      expect(screen.getByText('Min')).toBeTruthy();
      expect(screen.getByText('5')).toBeTruthy();
      expect(screen.getByText('Max')).toBeTruthy();
      expect(screen.getByText('25')).toBeTruthy();
    });
  });
});
