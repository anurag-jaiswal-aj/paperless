/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FormBuilder from './FormBuilder';
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

describe('FormBuilder Phase 6 AI Features', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      auth: { user: { id: 'user1' } },
      forms: {
        currentForm: { _id: '123', title: 'Test Form', description: 'Desc' },
        questions: [{ _id: 'q1', label: 'Q1', type: 'short_text' }],
        loading: false
      },
      theme: { theme: 'light' }
    });
    vi.clearAllMocks();
  });

  const renderComponent = () => {
    return render(
      <Provider store={store}>
        <BrowserRouter>
          <FormBuilder />
        </BrowserRouter>
      </Provider>
    );
  };

  it('renders AI Suggest Questions modal and allows generating questions', async () => {
    renderComponent();

    const suggestBtn = screen.getByText(/AI Suggest Questions/i);
    fireEvent.click(suggestBtn);

    expect(screen.getByText(/AI Question Generation/i)).toBeTruthy();

    const input = screen.getByPlaceholderText(/e.g., Customer Satisfaction/i);
    fireEvent.change(input, { target: { value: 'Feedback' } });

    api.post.mockResolvedValueOnce({
      data: { success: true, data: [{ label: 'New Q1', type: 'short_text', description: '' }] }
    });

    const generateBtn = screen.getByRole('button', { name: /Generate Questions/i });
    fireEvent.click(generateBtn);

    expect(api.post).toHaveBeenCalledWith('/api/ai/questions/generate', { topic: 'Feedback', formId: undefined });

    await waitFor(() => {
      expect(screen.getByText('Proposed Questions')).toBeTruthy();
      expect(screen.getByText('New Q1')).toBeTruthy();
    });

    const acceptBtn = screen.getByText('Accept All');
    api.post.mockResolvedValueOnce({ data: { success: true, data: { _id: 'q2', label: 'New Q1' } } });
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(screen.queryByText(/AI Question Generation/i)).not.toBeTruthy();
    });
  });

  it('allows rejecting proposed questions', async () => {
    renderComponent();

    fireEvent.click(screen.getByText(/AI Suggest Questions/i));
    fireEvent.change(screen.getByPlaceholderText(/e.g., Customer Satisfaction/i), { target: { value: 'Feedback' } });

    api.post.mockResolvedValueOnce({
      data: { success: true, data: [{ label: 'New Q1', type: 'short_text' }] }
    });

    fireEvent.click(screen.getByRole('button', { name: /Generate Questions/i }));

    await waitFor(() => {
      expect(screen.getByText('Proposed Questions')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Reject'));

    await waitFor(() => {
      expect(screen.queryByText(/AI Question Generation/i)).not.toBeTruthy();
    });
  });

  it('handles title writing improvement', async () => {
    renderComponent();

    const improveBtns = screen.getAllByTitle(/Improve title with AI/i);

    api.post.mockResolvedValueOnce({
      data: { success: true, data: { improvedText: 'Better Title', changesSummary: 'Fixed' } }
    });

    fireEvent.click(improveBtns[0]);

    await waitFor(() => {
      expect(screen.getByText('Better Title')).toBeTruthy();
    });

    api.put.mockResolvedValueOnce({ data: { success: true } });

    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      expect(screen.queryByText(/AI Writing Improvement/i)).not.toBeTruthy();
    });
  });

  it('handles description writing improvement', async () => {
    renderComponent();

    const improveBtns = screen.getAllByTitle(/Improve description with AI/i);

    api.post.mockResolvedValueOnce({
      data: { success: true, data: { improvedText: 'Better Desc', changesSummary: 'Fixed' } }
    });

    fireEvent.click(improveBtns[0]);

    await waitFor(() => {
      expect(screen.getByText('Better Desc')).toBeTruthy();
    });

    api.put.mockResolvedValueOnce({ data: { success: true } });

    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      expect(screen.queryByText(/AI Writing Improvement/i)).not.toBeTruthy();
    });
  });

  it('handles question writing improvement and cancel', async () => {
    renderComponent();

    const improveBtns = screen.getAllByTitle(/Improve question wording with AI/i);

    api.post.mockResolvedValueOnce({
      data: { success: true, data: { improvedText: 'Better Q1' } }
    });

    fireEvent.click(improveBtns[0]);

    await waitFor(() => {
      expect(screen.getByText('Better Q1')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText(/AI Writing Improvement/i)).not.toBeTruthy();
    });
  });
});
