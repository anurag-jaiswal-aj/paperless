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

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: '123' }),
    useNavigate: () => vi.fn()
  };
});

const createMockStore = (initialState) => {
  return {
    getState: () => initialState,
    dispatch: vi.fn(),
    subscribe: vi.fn()
  };
};

vi.mock('react-beautiful-dnd', () => ({
  DragDropContext: ({ children, onDragEnd }) => (
    <div
      data-testid="dnd-context"
      data-ondragend={JSON.stringify({ source: null, destination: null })}
      onClick={(e) => {
        const val = e.currentTarget.getAttribute('data-ondragend');
        if (val) {
          const { source, destination } = JSON.parse(val);
          onDragEnd({ source, destination });
        }
      }}
    >
      {children}
    </div>
  ),
  Draggable: ({ children }) => children({ draggableProps: {}, dragHandleProps: {}, innerRef: vi.fn() }),
  Droppable: ({ children }) => children({ droppableProps: {}, innerRef: vi.fn(), placeholder: null }),
}));

vi.mock('../components/StrictModeDroppable', () => ({
  StrictModeDroppable: ({ children }) => children({ droppableProps: {}, innerRef: vi.fn(), placeholder: null })
}));

describe('FormBuilder Phase 6 AI Features', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      auth: { user: { id: 'user1' } },
      forms: {
        currentForm: { _id: '123', title: 'Test Form', description: 'Desc' },
        questions: [
          { _id: 'q1', label: 'What is your name?', type: 'short_text', order: 0 },
          { _id: 'q2', label: 'Untitled Question', type: 'short_text', order: 1 }
        ],
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

    expect(api.post).toHaveBeenCalledWith('/api/ai/questions/generate', { topic: 'Feedback', formId: '123' });

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

  it('updates question type correctly via CustomSelect', async () => {
    renderComponent();

    // The current type is 'short_text' so it displays 'Short Text'
    const typeComboboxes = screen.getAllByText('Short Text');
    fireEvent.click(typeComboboxes[0]);

    api.put.mockResolvedValueOnce({ data: { success: true, data: { _id: 'q1', type: 'long_text' } } });

    // Click 'Long Text'
    const longTextOption = screen.getByText('Long Text');
    fireEvent.click(longTextOption);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/q1', expect.objectContaining({ type: 'long_text' }));
    });
  });

  it('persists status change to published immediately via CustomSelect', async () => {
    api.put.mockResolvedValueOnce({
      data: { success: true, data: { _id: '123', title: 'Test Form', status: 'published' } }
    });

    renderComponent();

    const statusCombobox = screen.getByText('Draft');
    fireEvent.click(statusCombobox);

    const publishedOption = screen.getByText('Published');
    fireEvent.click(publishedOption);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123', { status: 'published' });
    });

    await waitFor(() => {
      expect(screen.getByText('Published')).toBeTruthy();
    });
  });

  it('persists status changes to closed and draft correctly', async () => {
    api.put.mockResolvedValueOnce({
      data: { success: true, data: { _id: '123', title: 'Test Form', status: 'closed' } }
    });

    renderComponent();

    const statusCombobox = screen.getByText('Draft');
    fireEvent.click(statusCombobox);

    const closedOption = screen.getByText('Closed');
    fireEvent.click(closedOption);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123', { status: 'closed' });
    });

    await waitFor(() => {
      expect(screen.getByText('Closed')).toBeTruthy();
    });

    // Switch back to draft
    api.put.mockResolvedValueOnce({
      data: { success: true, data: { _id: '123', title: 'Test Form', status: 'draft' } }
    });

    fireEvent.click(screen.getByText('Closed'));
    fireEvent.click(screen.getByText('Draft'));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123', { status: 'draft' });
    });

    await waitFor(() => {
      expect(screen.getByText('Draft')).toBeTruthy();
    });
  });

  it('reverts status and displays alert when status update API fails', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    api.put.mockRejectedValueOnce({
      response: { data: { message: 'Database failure' } }
    });

    renderComponent();

    const statusCombobox = screen.getByText('Draft');
    fireEvent.click(statusCombobox);

    const publishedOption = screen.getByText('Published');
    fireEvent.click(publishedOption);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123', { status: 'published' });
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Database failure');
      expect(screen.getByText('Draft')).toBeTruthy();
    });

    alertSpy.mockRestore();
  });

  it('guards against stale responses overwriting newer status during rapid changes', async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    api.put.mockImplementation((url, body) => {
      if (body.status === 'published') {
        return firstPromise;
      }
      if (body.status === 'closed') {
        return Promise.resolve({
          data: { success: true, data: { _id: '123', title: 'Test Form', status: 'closed' } }
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    renderComponent();

    // Select published first
    fireEvent.click(screen.getByText('Draft'));
    fireEvent.click(screen.getByText('Published'));

    // Rapidly select closed second
    fireEvent.click(screen.getByText('Published'));
    fireEvent.click(screen.getByText('Closed'));

    await waitFor(() => {
      expect(screen.getByText('Closed')).toBeTruthy();
    });

    // Now the slow first request completes with stale 'published'
    resolveFirst({
      data: { success: true, data: { _id: '123', title: 'Test Form', status: 'published' } }
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.queryByText('Published')).toBeNull();
  });

  it('updates conditional visibility correctly via CustomSelect', async () => {
    // Add a second question so visibility target appears
    store = createMockStore({
      auth: { user: { id: 'user1' } },
      forms: {
        currentForm: { _id: '123', title: 'Test Form', description: 'Desc' },
        questions: [
          { _id: 'q1', label: 'What is your name?', type: 'short_text', order: 0 },
          { _id: 'q2', label: 'Untitled Question', type: 'short_text', order: 1 }
        ],
        loading: false
      },
      theme: { theme: 'light' }
    });

    renderComponent();

    // Find the 'Always Visible' combobox for q2
    const visibilityComboboxes = screen.getAllByText('Always Visible');
    const q2VisibilityCombobox = visibilityComboboxes[1];

    fireEvent.click(q2VisibilityCombobox);

    // Select the 'What is your name?' option
    const option = screen.getByText("What is your name?");

    api.put.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          _id: 'q2',
          label: 'Untitled Question',
          type: 'short_text',
          order: 1,
          visibilityRule: { targetQuestionId: 'q1', operator: 'equals', value: '' }
        }
      }
    });

    fireEvent.pointerDown(option);

    await waitFor(() => {
      // Verify API payload contains the selected condition
      expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/q2', expect.objectContaining({
        visibilityRule: { targetQuestionId: 'q1', operator: 'equals', value: '' }
      }));
    });

    // Verify Redux was updated with the returned data
    expect(store.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'forms/updateQuestion',
        payload: expect.objectContaining({
          visibilityRule: { targetQuestionId: 'q1', operator: 'equals', value: '' }
        })
      })
    );

    // The dropdown menu should be closed
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
