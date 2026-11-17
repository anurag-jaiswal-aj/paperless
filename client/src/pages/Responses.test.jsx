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
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              { _id: 'r1', answers: [] },
              { _id: 'r2', answers: [] }
            ],
            pagination: { pages: 1, page: 1 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 2, analytics: [] } }
        });
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
          themes: [
            {
              name: 'Theme 1',
              description: 'Theme desc',
              supportingResponses: ['Response 1'],
              sentiment: 'neutral'
            }
          ]
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
          categories: [
            {
              name: 'Category 1',
              description: 'Cat desc',
              responseIndexes: [0, 999] // 999 is out of bounds malformed index
            }
          ],
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

  it('correctly maps category response IDs across multiple pages without #Unknown and preserves numbering on page navigation', async () => {
    // 25 total responses: Page 1 (r1..r10), Page 2 (r11..r20), Page 3 (r21..r25)
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Multi-Page Survey' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('page=2')) {
        return Promise.resolve({
          data: {
            success: true,
            data: Array.from({ length: 10 }, (_, i) => ({
              _id: `r${i + 11}`,
              answers: [],
              createdAt: new Date(2026, 0, 15 - i).toISOString()
            })),
            pagination: { pages: 3, page: 2, total: 25, limit: 10 }
          }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: Array.from({ length: 10 }, (_, i) => ({
              _id: `r${i + 1}`,
              answers: [],
              createdAt: new Date(2026, 0, 25 - i).toISOString()
            })),
            pagination: { pages: 3, page: 1, total: 25, limit: 10 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 25, analytics: [] } }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Response Categorization')).toBeTruthy();
      // On Page 1, response cards display #25 down to #16
      expect(screen.getByText('Response #25')).toBeTruthy();
      expect(screen.getByText('Response #16')).toBeTruthy();
    });

    // Mock categorize response that references responses from Page 1 (r1, index 0), Page 2 (r16, index 15),
    // and uncategorized Page 3 (r25, index 24)
    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          categories: [
            {
              name: 'Multi-Page Category',
              description: 'Spans across page 1 and page 2',
              responseIndexes: [0, 15],
              responseIds: ['r1', 'r16']
            }
          ],
          uncategorizedResponseIndexes: [24],
          uncategorizedResponseIds: ['r25'],
          responseMap: {
            r1: { id: 'r1', index: 0, number: 25, displayId: '#25' },
            0: { id: 'r1', index: 0, number: 25, displayId: '#25' },
            r16: { id: 'r16', index: 15, number: 10, displayId: '#10' },
            15: { id: 'r16', index: 15, number: 10, displayId: '#10' },
            r25: { id: 'r25', index: 24, number: 1, displayId: '#1' },
            24: { id: 'r25', index: 24, number: 1, displayId: '#1' }
          }
        }
      }
    });

    const categorizeBtn = screen.getByRole('button', { name: /Categorize/i });
    fireEvent.click(categorizeBtn);

    // On Page 1: r16 is NOT in responses array (which only has r1..r10), but responseMap/responseIds
    // ensures it renders as #10 instead of #Unknown!
    await waitFor(() => {
      expect(screen.getByText(/Multi-Page Category/i)).toBeTruthy();
      expect(screen.getByText(/Includes Response IDs: #25, #10/i)).toBeTruthy();
      expect(screen.getByText(/Response IDs: #1/i)).toBeTruthy();
      // Ensure zero #Unknown labels are displayed
      expect(screen.queryByText(/#Unknown/)).toBeNull();
    });

    // Navigate to Page 2
    const nextBtn = screen.getByRole('button', { name: /Next/i });
    fireEvent.click(nextBtn);

    await waitFor(() => {
      // On Page 2, response cards display #15 down to #6 (preserving global sequence)
      expect(screen.getByText('Response #15')).toBeTruthy();
      expect(screen.getByText('Response #6')).toBeTruthy();
      // Category still correctly displays #25, #10 without resetting or showing #Unknown
      expect(screen.getByText(/Includes Response IDs: #25, #10/i)).toBeTruthy();
      expect(screen.getByText(/Response IDs: #1/i)).toBeTruthy();
      expect(screen.queryByText(/#Unknown/)).toBeNull();
    });
  });

  it('correctly handles custom pagination limit and dynamically numbers response cards across pages', async () => {
    // 15 total responses, limit = 5 across 3 pages
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Pagination Limit 5 Test' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('page=2')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              { _id: 'r6', answers: [], createdAt: '2026-01-10T00:00:00.000Z' },
              { _id: 'r7', answers: [], createdAt: '2026-01-09T00:00:00.000Z' },
              { _id: 'r8', answers: [], createdAt: '2026-01-08T00:00:00.000Z' },
              { _id: 'r9', answers: [], createdAt: '2026-01-07T00:00:00.000Z' },
              { _id: 'r10', answers: [], createdAt: '2026-01-06T00:00:00.000Z' }
            ],
            pagination: { pages: 3, page: 2, total: 15, limit: 5 }
          }
        });
      }
      if (url.includes('/api/responses/') && url.includes('page=3')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              { _id: 'r11', answers: [], createdAt: '2026-01-05T00:00:00.000Z' },
              { _id: 'r12', answers: [], createdAt: '2026-01-04T00:00:00.000Z' },
              { _id: 'r13', answers: [], createdAt: '2026-01-03T00:00:00.000Z' },
              { _id: 'r14', answers: [], createdAt: '2026-01-02T00:00:00.000Z' },
              { _id: 'r15', answers: [], createdAt: '2026-01-01T00:00:00.000Z' }
            ],
            pagination: { pages: 3, page: 3, total: 15, limit: 5 }
          }
        });
      }
      if (url.includes('/api/responses/')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              { _id: 'r1', answers: [], createdAt: '2026-01-15T00:00:00.000Z' },
              { _id: 'r2', answers: [], createdAt: '2026-01-14T00:00:00.000Z' },
              { _id: 'r3', answers: [], createdAt: '2026-01-13T00:00:00.000Z' },
              { _id: 'r4', answers: [], createdAt: '2026-01-12T00:00:00.000Z' },
              { _id: 'r5', answers: [], createdAt: '2026-01-11T00:00:00.000Z' }
            ],
            pagination: { pages: 3, page: 1, total: 15, limit: 5 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 15, analytics: [] } }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    // Page 1: cards #15 down to #11
    await waitFor(() => {
      expect(screen.getByText('Response #15')).toBeTruthy();
      expect(screen.getByText('Response #11')).toBeTruthy();
      expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    });

    // Navigate to Page 2
    const nextBtn = screen.getByRole('button', { name: /Next/i });
    fireEvent.click(nextBtn);

    // Page 2: with limit=5, globalOffset is (2 - 1) * 5 = 5.
    // Cards must render #10 down to #6
    await waitFor(() => {
      expect(screen.getByText('Response #10')).toBeTruthy();
      expect(screen.getByText('Response #6')).toBeTruthy();
      expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    });

    // Navigate to Page 3
    fireEvent.click(nextBtn);

    // Page 3: cards #5 down to #1
    await waitFor(() => {
      expect(screen.getByText('Response #5')).toBeTruthy();
      expect(screen.getByText('Response #1')).toBeTruthy();
      expect(screen.getByText('Page 3 of 3')).toBeTruthy();
    });
  });

  describe('Category and uncategorized legacy fallback precedence', () => {
    it('C1: prioritizes responseIds over responseIndexes when responseIds is non-empty', async () => {
      renderComponent();
      await waitFor(() => expect(screen.getByText('Response Categorization')).toBeTruthy());

      api.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            categories: [
              {
                name: 'Modern Category',
                description: 'Uses responseIds',
                responseIds: ['r1', 'r2'],
                responseIndexes: [99, 98] // Outdated indexes must be ignored
              }
            ],
            uncategorizedResponseIds: ['r3'],
            uncategorizedResponseIndexes: [97],
            responseMap: {
              r1: { number: 10, displayId: '#10' },
              r2: { number: 9, displayId: '#9' },
              r3: { number: 8, displayId: '#8' },
              99: { number: 99, displayId: '#LEGACY99' },
              98: { number: 98, displayId: '#LEGACY98' },
              97: { number: 97, displayId: '#LEGACY97' }
            }
          }
        }
      });

      fireEvent.click(screen.getByRole('button', { name: /Categorize/i }));

      await waitFor(() => {
        expect(screen.getAllByText(/2 responses/i).length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText(/Includes Response IDs: #10, #9/i)).toBeTruthy();
        expect(screen.getByText(/Response IDs: #8/i)).toBeTruthy();
        expect(screen.queryByText(/#LEGACY/)).toBeNull();
      });
    });

    it('C2: falls back to responseIndexes when responseIds is an empty array ([])', async () => {
      renderComponent();
      await waitFor(() => expect(screen.getByText('Response Categorization')).toBeTruthy());

      api.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            categories: [
              {
                name: 'Fallback Empty Array Category',
                description: 'responseIds is empty array',
                responseIds: [],
                responseIndexes: [0, 1]
              }
            ],
            uncategorizedResponseIds: [],
            uncategorizedResponseIndexes: [1],
            responseMap: {
              0: { number: 2, displayId: '#2' },
              1: { number: 1, displayId: '#1' }
            }
          }
        }
      });

      fireEvent.click(screen.getByRole('button', { name: /Categorize/i }));

      await waitFor(() => {
        // Must show 2 responses in category badge (and 2 in header), NOT 0 responses in category
        expect(screen.getAllByText(/2 responses/i).length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText(/Includes Response IDs: #2, #1/i)).toBeTruthy();
        expect(screen.getByText(/Response IDs: #1/i)).toBeTruthy();
      });
    });

    it('C3: falls back to responseIndexes when responseIds is undefined', async () => {
      renderComponent();
      await waitFor(() => expect(screen.getByText('Response Categorization')).toBeTruthy());

      api.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            categories: [
              {
                name: 'Legacy Payload Category',
                description: 'responseIds omitted',
                responseIndexes: [0, 1]
              }
            ],
            uncategorizedResponseIndexes: [1],
            responseMap: {
              0: { number: 2, displayId: '#2' },
              1: { number: 1, displayId: '#1' }
            }
          }
        }
      });

      fireEvent.click(screen.getByRole('button', { name: /Categorize/i }));

      await waitFor(() => {
        expect(screen.getAllByText(/2 responses/i).length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText(/Includes Response IDs: #2, #1/i)).toBeTruthy();
        expect(screen.getByText(/Response IDs: #1/i)).toBeTruthy();
      });
    });

    it('C4: handles both arrays empty safely without rendering empty inclusion or uncategorized blocks', async () => {
      renderComponent();
      await waitFor(() => expect(screen.getByText('Response Categorization')).toBeTruthy());

      api.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            categories: [
              {
                name: 'Empty Category',
                description: 'No items',
                responseIds: [],
                responseIndexes: []
              }
            ],
            uncategorizedResponseIds: [],
            uncategorizedResponseIndexes: []
          }
        }
      });

      fireEvent.click(screen.getByRole('button', { name: /Categorize/i }));

      await waitFor(() => {
        expect(screen.getByText('Empty Category')).toBeTruthy();
        expect(screen.getByText(/0 responses/i)).toBeTruthy();
        expect(screen.queryByText(/Includes Response IDs:/)).toBeNull();
        expect(screen.queryByText('Uncategorized')).toBeNull();
      });
    });
  });

  it('renders choice question analytics using distribution structure without crashing', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{ _id: 'r1', answers: [] }],
            pagination: { pages: 1, page: 1 }
          }
        });
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
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{ _id: 'r1', answers: [] }],
            pagination: { pages: 1, page: 1 }
          }
        });
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
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{ _id: 'r1', answers: [] }],
            pagination: { pages: 1, page: 1 }
          }
        });
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

  it('renders rating question analytics with average and star distribution', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Test Form' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{ _id: 'r1', answers: [] }],
            pagination: { pages: 1, page: 1 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              totalResponses: 5,
              analytics: [
                {
                  questionId: 'q-rating',
                  label: 'Customer Satisfaction',
                  type: 'rating',
                  totalAnswers: 5,
                  data: {
                    type: 'rating',
                    average: 4.6,
                    distribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 3 },
                    totalRatings: 5
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
      expect(screen.getByText('Customer Satisfaction')).toBeTruthy();
      expect(screen.getByText(/Average:\s*4\.6\s*\/\s*5/)).toBeTruthy();
      expect(screen.getByText('5 answers')).toBeTruthy();
    });
  });

  it('renders file-upload answers with original filename and semantic download link without crashing', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Job Application' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                _id: 'r1',
                createdAt: '2026-10-29T12:00:00.000Z',
                answers: [
                  {
                    _id: 'a1',
                    questionId: { _id: 'q-file', label: 'Upload Resume', type: 'file_upload' },
                    value: {
                      key: 'uploads/123/resume.pdf',
                      originalName: 'my-resume.pdf',
                      mimeType: 'application/pdf',
                      size: 1048576 // 1.0 MB
                    }
                  }
                ]
              }
            ],
            pagination: { pages: 1, page: 1 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 1, analytics: [] } }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Upload Resume')).toBeTruthy();
      expect(screen.getByText('my-resume.pdf')).toBeTruthy();
      expect(screen.getByText('(1.0 MB)')).toBeTruthy();
    });

    const downloadLink = screen.getByRole('link', { name: /Download my-resume\.pdf/i });
    expect(downloadLink).toBeTruthy();
    expect(downloadLink.getAttribute('href')).toBe('/api/responses/123/r1/file/q-file');
    expect(downloadLink.getAttribute('target')).toBe('_blank');
    expect(downloadLink.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('handles file answers with raw questionId string without crashing', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'File Form' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                _id: 'r2',
                createdAt: '2026-10-29T12:00:00.000Z',
                answers: [
                  {
                    _id: 'a2',
                    questionId: 'q-raw-file',
                    value: {
                      key: 'uploads/doc.pdf',
                      originalName: 'report.pdf',
                      size: 2048
                    }
                  }
                ]
              }
            ],
            pagination: { pages: 1, page: 1 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 1, analytics: [] } }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeTruthy();
      expect(screen.getByText('(2.0 KB)')).toBeTruthy();
    });

    const downloadLink = screen.getByRole('link', { name: /Download report\.pdf/i });
    expect(downloadLink.getAttribute('href')).toBe('/api/responses/123/r2/file/q-raw-file');
  });

  it('handles file answers with missing questionId or metadata gracefully without crashing', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Orphan File Form' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                _id: 'r3',
                createdAt: '2026-10-29T12:00:00.000Z',
                answers: [
                  {
                    _id: 'a3',
                    questionId: null,
                    value: {
                      originalName: 'orphan.png',
                      size: 512
                    }
                  }
                ]
              }
            ],
            pagination: { pages: 1, page: 1 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 1, analytics: [] } }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('orphan.png')).toBeTruthy();
      expect(screen.getByText('(512 B)')).toBeTruthy();
    });

    // Should not render a broken link when questionId is missing
    expect(screen.queryByRole('link', { name: /Download orphan\.png/i })).toBeNull();
  });

  it('preserves string, number, array, empty, and null answer rendering', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Survey' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                _id: 'r4',
                createdAt: '2026-10-29T12:00:00.000Z',
                answers: [
                  {
                    _id: 'a-str',
                    questionId: { _id: 'q-str', label: 'Candidate Name' },
                    value: 'Alice Smith'
                  },
                  {
                    _id: 'a-num',
                    questionId: { _id: 'q-num', label: 'Years of Experience' },
                    value: 7
                  },
                  {
                    _id: 'a-arr',
                    questionId: { _id: 'q-arr', label: 'Skills' },
                    value: ['TypeScript', 'Node.js', 'React']
                  },
                  {
                    _id: 'a-null',
                    questionId: { _id: 'q-null', label: 'Additional Comments' },
                    value: null
                  }
                ]
              }
            ],
            pagination: { pages: 1, page: 1 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 1, analytics: [] } }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Candidate Name')).toBeTruthy();
      expect(screen.getByText('Alice Smith')).toBeTruthy();
      expect(screen.getByText('Years of Experience')).toBeTruthy();
      expect(screen.getByText('7')).toBeTruthy();
      expect(screen.getByText('Skills')).toBeTruthy();
      expect(screen.getByText('TypeScript, Node.js, React')).toBeTruthy();
      expect(screen.getByText('Additional Comments')).toBeTruthy();
    });
  });

  it('handles unexpected plain objects without crashing the page', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: { success: true, data: { form: { _id: '123', title: 'Crash Test' } } }
        });
      }
      if (url.includes('/api/responses/') && url.includes('limit=10')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                _id: 'r5',
                createdAt: '2026-10-29T12:00:00.000Z',
                answers: [
                  {
                    _id: 'a-obj',
                    questionId: { _id: 'q-obj', label: 'Custom Metadata' },
                    value: { arbitraryKey: 'safeValue', count: 99 }
                  },
                  {
                    _id: 'a-empty-obj',
                    questionId: { _id: 'q-empty', label: 'Empty Object' },
                    value: {}
                  }
                ]
              }
            ],
            pagination: { pages: 1, page: 1 }
          }
        });
      }
      if (url.includes('/analytics')) {
        return Promise.resolve({
          data: { success: true, data: { totalResponses: 1, analytics: [] } }
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Custom Metadata')).toBeTruthy();
      expect(screen.getByText(/arbitraryKey/i)).toBeTruthy();
      expect(screen.getByText('Empty Object')).toBeTruthy();
    });
  });

  describe('Stage 4.3.5 Batch D: Frontend Crash Guards and Error Resilience', () => {
    it('D3: renders safely without crashing when analytics payload lacks inner analytics array', async () => {
      api.get.mockImplementation((url) => {
        if (url.includes('/api/forms/')) {
          return Promise.resolve({
            data: { success: true, data: { form: { _id: '123', title: 'Survey' } } }
          });
        }
        if (url.includes('/api/responses/') && url.includes('limit=10')) {
          return Promise.resolve({
            data: {
              success: true,
              data: [
                {
                  _id: 'r1',
                  createdAt: '2026-10-29T12:00:00.000Z',
                  answers: [{ _id: 'a1', questionId: { _id: 'q1', label: 'Q1' }, value: 'Ans' }]
                }
              ],
              pagination: { pages: 1, page: 1, total: 1 }
            }
          });
        }
        if (url.includes('/analytics')) {
          // Inner analytics property is undefined
          return Promise.resolve({ data: { success: true, data: { totalResponses: 1 } } });
        }
        return Promise.resolve({ data: {} });
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText('Survey')).toBeTruthy();
        expect(screen.getByText('Response #1')).toBeTruthy();
      });
    });

    it('D4: renders dedicated error card with retry button on fetch failure', async () => {
      let fail = true;
      api.get.mockImplementation((url) => {
        if (fail) {
          const err = new Error('Network error');
          err.response = { data: { message: 'Failed to connect to backend server' } };
          return Promise.reject(err);
        }
        if (url.includes('/api/forms/')) {
          return Promise.resolve({
            data: { success: true, data: { form: { _id: '123', title: 'Survey' } } }
          });
        }
        if (url.includes('/api/responses/') && url.includes('limit=10')) {
          return Promise.resolve({
            data: {
              success: true,
              data: [],
              pagination: { pages: 0, page: 1, total: 0 }
            }
          });
        }
        if (url.includes('/analytics')) {
          return Promise.resolve({
            data: { success: true, data: { totalResponses: 0, analytics: [] } }
          });
        }
        return Promise.resolve({ data: {} });
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText('Failed to load responses')).toBeTruthy();
        expect(screen.getByText('Failed to connect to backend server')).toBeTruthy();
        expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
      });

      // Does not show misleading "No responses yet" card
      expect(screen.queryByText('No responses yet')).toBeNull();

      // Click retry after fixing failure
      fail = false;
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      await waitFor(() => {
        expect(screen.getByText('No responses yet')).toBeTruthy();
      });
    });
  });
});
