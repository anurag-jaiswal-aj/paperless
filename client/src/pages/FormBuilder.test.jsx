/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FormBuilder from './FormBuilder';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import api from '../utils/api';

vi.mock('../utils/api');

let mockRouteId = '123';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: mockRouteId }),
    useNavigate: () => vi.fn()
  };
});

const createMockStore = (initialState) => {
  let state = { ...initialState };
  const listeners = [];
  const dispatch = vi.fn((action) => {
    if (typeof action === 'function') {
      return action(dispatch, () => state);
    }
    if (action.type === 'forms/updateQuestion') {
      const questions = state.forms.questions.map((q) =>
        q._id === action.payload._id ? { ...q, ...action.payload } : q
      );
      state = {
        ...state,
        forms: { ...state.forms, questions }
      };
    } else if (action.type === 'forms/addQuestion') {
      state = {
        ...state,
        forms: { ...state.forms, questions: [...state.forms.questions, action.payload] }
      };
    } else if (action.type === 'forms/removeQuestion') {
      const questions = state.forms.questions.filter((q) => q._id !== action.payload);
      state = {
        ...state,
        forms: { ...state.forms, questions }
      };
    } else if (action.type === 'forms/reorderQuestions') {
      state = {
        ...state,
        forms: { ...state.forms, questions: action.payload }
      };
    } else if (action.type === 'forms/setQuestions') {
      state = {
        ...state,
        forms: { ...state.forms, questions: action.payload }
      };
    } else if (action.type === 'forms/setCurrentForm') {
      state = {
        ...state,
        forms: { ...state.forms, currentForm: action.payload }
      };
    }
    listeners.forEach((l) => l());
    return action;
  });

  return {
    getState: () => state,
    dispatch,
    subscribe: vi.fn((listener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    })
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
    mockRouteId = '123';
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

    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              form: { _id: '123', title: 'Test Form', description: 'Desc', status: 'draft' },
              questions: [
                { _id: 'q1', label: 'Question 1', type: 'short_text', order: 0, required: false, options: [] },
                { _id: 'q2', label: 'Question 2', type: 'single_choice', order: 1, required: false, options: ['Opt 1', 'Opt 2'] }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: {} });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

describe('FormBuilder Persistence, Debouncing, and Race Condition Hardening', () => {
  let store;

  beforeEach(() => {
    mockRouteId = '123';
    store = createMockStore({
      auth: { user: { id: 'user1' } },
      forms: {
        currentForm: { _id: '123', title: 'Test Form', description: 'Desc', status: 'draft' },
        questions: [
          { _id: 'q1', label: 'Question 1', type: 'short_text', order: 0, required: false, options: [] },
          { _id: 'q2', label: 'Question 2', type: 'single_choice', order: 1, required: false, options: ['Opt 1', 'Opt 2'] }
        ],
        loading: false
      },
      theme: { theme: 'light' }
    });
    vi.clearAllMocks();

    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              form: { _id: '123', title: 'Test Form', description: 'Desc', status: 'draft' },
              questions: [
                { _id: 'q1', label: 'Question 1', type: 'short_text', order: 0, required: false, options: [] },
                { _id: 'q2', label: 'Question 2', type: 'single_choice', order: 1, required: false, options: ['Opt 1', 'Opt 2'] }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: {} });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('produces a bounded number of API calls during multiple rapid title edits and persists the final title', async () => {
    vi.useFakeTimers();
    api.put.mockResolvedValue({
      data: { success: true, data: { _id: '123', title: 'Final Form Title', description: 'Desc' } }
    });

    renderComponent();
    await vi.advanceTimersByTimeAsync(0);

    const titleInput = screen.getByPlaceholderText('Form Title');

    // Multiple rapid keystrokes within debounce window
    fireEvent.change(titleInput, { target: { value: 'T' } });
    fireEvent.change(titleInput, { target: { value: 'Ti' } });
    fireEvent.change(titleInput, { target: { value: 'Tit' } });
    fireEvent.change(titleInput, { target: { value: 'Title' } });
    fireEvent.change(titleInput, { target: { value: 'Final Form Title' } });

    // No API call should be sent immediately
    expect(api.put).not.toHaveBeenCalled();

    // Fast-forward debounce timer (400ms)
    await vi.advanceTimersByTimeAsync(400);

    // Exactly one bounded API call sent with the final title
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/api/forms/123', {
      title: 'Final Form Title',
      description: 'Desc'
    });
  });

  it('persists description edits correctly with debouncing', async () => {
    vi.useFakeTimers();
    api.put.mockResolvedValue({
      data: { success: true, data: { _id: '123', title: 'Test Form', description: 'Final Description' } }
    });

    renderComponent();
    await vi.advanceTimersByTimeAsync(0);

    const descInput = screen.getByPlaceholderText('Form description (optional)');

    fireEvent.change(descInput, { target: { value: 'Draft 1' } });
    fireEvent.change(descInput, { target: { value: 'Draft 2' } });
    fireEvent.change(descInput, { target: { value: 'Final Description' } });

    expect(api.put).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/api/forms/123', {
      title: 'Test Form',
      description: 'Final Description'
    });
  });

  it('keeps edits to separate questions isolated without overwriting each other', async () => {
    vi.useFakeTimers();
    api.put.mockResolvedValue({ data: { success: true, data: {} } });

    renderComponent();

    const q1Input = screen.getByDisplayValue('Question 1');
    const q2Input = screen.getByDisplayValue('Question 2');

    // Edit Question 1 and Question 2 independently
    fireEvent.change(q1Input, { target: { value: 'Question 1 Updated' } });
    fireEvent.change(q2Input, { target: { value: 'Question 2 Updated' } });

    // Optimistic UI updates immediately in both inputs
    expect(q1Input.value).toBe('Question 1 Updated');
    expect(q2Input.value).toBe('Question 2 Updated');

    // Debounce expires
    await vi.advanceTimersByTimeAsync(350);

    expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/q1', { label: 'Question 1 Updated' });
    expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/q2', { label: 'Question 2 Updated' });

    vi.useRealTimers();
  });

  it('prevents out-of-order responses from overwriting newer client state', async () => {
    let resolveOlderRequest;
    const olderPromise = new Promise((resolve) => {
      resolveOlderRequest = resolve;
    });

    api.put.mockImplementation((url, body) => {
      if (body.label === 'Older Label') {
        return olderPromise;
      }
      if (body.label === 'Newer Label') {
        return Promise.resolve({
          data: {
            success: true,
            data: { _id: 'q1', label: 'Newer Label', type: 'short_text', order: 0 }
          }
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    renderComponent();

    const q1Input = screen.getByDisplayValue('Question 1');

    // First edit: triggers older request
    fireEvent.change(q1Input, { target: { value: 'Older Label' } });

    // Wait for older request to be sent
    await new Promise((r) => setTimeout(r, 320));

    // Second edit: triggers newer request while older is still in flight
    fireEvent.change(q1Input, { target: { value: 'Newer Label' } });
    await new Promise((r) => setTimeout(r, 320));

    // Verify Newer Label is active
    expect(q1Input.value).toBe('Newer Label');

    // Now older delayed request resolves with stale 'Older Label'
    resolveOlderRequest({
      data: {
        success: true,
        data: { _id: 'q1', label: 'Older Label', type: 'short_text', order: 0 }
      }
    });

    await new Promise((r) => setTimeout(r, 50));

    // Stale response must be dropped: newer state preserved
    expect(q1Input.value).toBe('Newer Label');
    const q1InStore = store.getState().forms.questions.find((q) => q._id === 'q1');
    expect(q1InStore.label).toBe('Newer Label');
  });

  it('surfaces failed save and does not silently discard the latest edit', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    api.put.mockRejectedValueOnce({
      response: { data: { message: 'Database connection failed' } }
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'Important Unsaved Edit' } });

    // Wait for debounce and rejection
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Database connection failed');
    });

    // Client state is NOT discarded
    expect(q1Input.value).toBe('Important Unsaved Edit');
    const q1InStore = store.getState().forms.questions.find((q) => q._id === 'q1');
    expect(q1InStore.label).toBe('Important Unsaved Edit');

    alertSpy.mockRestore();
  });

  it('prevents question deletion from being undone by an older pending or in-flight update', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let resolveInFlightUpdate;
    const inFlightPromise = new Promise((resolve) => {
      resolveInFlightUpdate = resolve;
    });

    api.put.mockImplementation((url) => {
      if (url.includes('/questions/q1')) {
        return inFlightPromise;
      }
      return Promise.resolve({ data: { success: true } });
    });
    api.delete.mockResolvedValueOnce({ data: { success: true } });

    renderComponent();

    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'Edit before delete' } });

    // Trigger update request
    await new Promise((r) => setTimeout(r, 320));

    // Delete question while PUT is still in flight
    const deleteButtons = screen.getAllByRole('button').filter(
      (btn) => btn.querySelector('svg') && btn.className.includes('text-red-600')
    );
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith('/api/forms/123/questions/q1');
    });

    // In-flight PUT completes with 200 OK after question was already deleted
    resolveInFlightUpdate({
      data: {
        success: true,
        data: { _id: 'q1', label: 'Edit before delete', type: 'short_text', order: 0 }
      }
    });

    await new Promise((r) => setTimeout(r, 50));

    // Question must NOT be restored in Redux
    const q1InStore = store.getState().forms.questions.find((q) => q._id === 'q1');
    expect(q1InStore).toBeUndefined();

    confirmSpy.mockRestore();
  });

  it('preserves intended question order during reordering even if text edits were pending', async () => {
    api.put.mockResolvedValue({ data: { success: true } });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    // Type in Q1
    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'Q1 with pending text' } });

    // Trigger reorder before 300ms debounce completes
    const dndContext = screen.getByTestId('dnd-context');
    dndContext.setAttribute('data-ondragend', JSON.stringify({
      source: { index: 1 },
      destination: { index: 0 }
    }));
    fireEvent.click(dndContext);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/reorder', {
        questionOrders: [
          { questionId: 'q2', order: 0 },
          { questionId: 'q1', order: 1 }
        ]
      });
    });

    // Questions in Redux now have Q2 first and Q1 second
    const questionsInStore = store.getState().forms.questions;
    expect(questionsInStore[0]._id).toBe('q2');
    expect(questionsInStore[1]._id).toBe('q1');
  });

  it('does not leak pending updates when switching between forms', async () => {
    vi.useFakeTimers();
    api.put.mockResolvedValue({ data: { success: true } });

    const { unmount } = renderComponent();

    const titleInput = screen.getByPlaceholderText('Form Title');
    fireEvent.change(titleInput, { target: { value: 'Title for Form 123' } });

    // User switches to form 456 before timer fires
    unmount();
    mockRouteId = '456';

    const store2 = createMockStore({
      auth: { user: { id: 'user1' } },
      forms: {
        currentForm: { _id: '456', title: 'Form 456', description: '', status: 'draft' },
        questions: [],
        loading: false
      },
      theme: { theme: 'light' }
    });

    render(
      <Provider store={store2}>
        <BrowserRouter>
          <FormBuilder />
        </BrowserRouter>
      </Provider>
    );

    // Advance timers
    await vi.advanceTimersByTimeAsync(500);

    // Verify PUT /api/forms/456 was NEVER called with Form 123 title
    expect(api.put).not.toHaveBeenCalledWith('/api/forms/456', expect.objectContaining({
      title: 'Title for Form 123'
    }));

    vi.useRealTimers();
  });

  it('preserves immediate form-status persistence and question-type behavior', async () => {
    api.put.mockResolvedValue({
      data: {
        success: true,
        data: { _id: '123', title: 'Test Form', status: 'published' }
      }
    });

    renderComponent();

    // Changing status executes immediately without debouncing
    const statusCombobox = screen.getByText('Draft');
    fireEvent.click(statusCombobox);

    const publishedOption = screen.getByText('Published');
    fireEvent.click(publishedOption);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123', { status: 'published' });
    });

    // Changing question type executes immediately without debouncing
    api.put.mockResolvedValueOnce({
      data: {
        success: true,
        data: { _id: 'q1', type: 'rating', label: 'Question 1', order: 0 }
      }
    });

    const typeComboboxes = screen.getAllByText('Short Text');
    fireEvent.click(typeComboboxes[0]);

    const ratingOption = screen.getByText('Rating');
    fireEvent.click(ratingOption);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/q1', expect.objectContaining({
        type: 'rating'
      }));
    });
  });
});

describe('FormBuilder Persistence Hardening, Blur Flushing, Retry, and Concurrency', () => {
  let store;

  beforeEach(() => {
    mockRouteId = '123';
    store = createMockStore({
      auth: { user: { id: 'user1' } },
      forms: {
        currentForm: { _id: '123', title: 'Test Form', description: 'Desc', status: 'draft', version: 0 },
        questions: [
          { _id: 'q1', label: 'Question 1', type: 'short_text', order: 0, required: false, options: [], version: 0 },
          {
            _id: 'q2',
            label: 'Question 2',
            type: 'single_choice',
            order: 1,
            required: false,
            options: ['Opt 1', 'Opt 2'],
            visibilityRule: { targetQuestionId: 'q1', operator: 'equals', value: '' },
            version: 0
          }
        ],
        loading: false
      },
      theme: { theme: 'light' }
    });
    vi.clearAllMocks();

    api.get.mockImplementation((url) => {
      if (url.includes('/api/forms/')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              form: { _id: '123', title: 'Test Form', description: 'Desc', status: 'draft', version: 0 },
              questions: [
                { _id: 'q1', label: 'Question 1', type: 'short_text', order: 0, required: false, options: [], version: 0 },
                {
                  _id: 'q2',
                  label: 'Question 2',
                  type: 'single_choice',
                  order: 1,
                  required: false,
                  options: ['Opt 1', 'Opt 2'],
                  visibilityRule: { targetQuestionId: 'q1', operator: 'equals', value: '' },
                  version: 0
                }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: {} });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('flushes a pending question label edit immediately on blur', async () => {
    api.put.mockResolvedValue({
      data: { success: true, data: { _id: 'q1', label: 'Flushed on Blur', version: 1 } }
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'Flushed on Blur' } });

    // Blur immediately before 300ms timer
    fireEvent.blur(q1Input);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q1',
        expect.objectContaining({ label: 'Flushed on Blur' })
      );
    });
  });

  it('flushes a pending option edit immediately on blur', async () => {
    api.put.mockResolvedValue({
      data: { success: true, data: { _id: 'q2', options: ['New Opt 1', 'Opt 2'], version: 1 } }
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Opt 1')).toBeTruthy();
    });

    const optInput = screen.getByDisplayValue('Opt 1');
    fireEvent.change(optInput, { target: { value: 'New Opt 1' } });

    // Blur immediately
    fireEvent.blur(optInput);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q2',
        expect.objectContaining({ options: ['New Opt 1', 'Opt 2'] })
      );
    });
  });

  it('flushes a pending conditional visibility value edit immediately on blur', async () => {
    api.put.mockResolvedValue({
      data: {
        success: true,
        data: {
          _id: 'q2',
          visibilityRule: { targetQuestionId: 'q1', operator: 'equals', value: 'secret' },
          version: 1
        }
      }
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Value')).toBeTruthy();
    });

    const valInput = screen.getByPlaceholderText('Value');
    fireEvent.change(valInput, { target: { value: 'secret' } });

    // Blur immediately
    fireEvent.blur(valInput);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q2',
        expect.objectContaining({
          visibilityRule: { targetQuestionId: 'q1', operator: 'equals', value: 'secret' }
        })
      );
    });
  });

  it('initiates best-effort flush for pending edits on unmount', async () => {
    api.put.mockResolvedValue({ data: { success: true, data: {} } });

    const { unmount } = renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'Save before leave' } });

    // Unmount while debounce timer is still pending
    unmount();

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q1',
        expect.objectContaining({ label: 'Save before leave' })
      );
    });
  });

  it('preserves failed question save and enables retry without re-editing the field', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    api.put.mockRejectedValueOnce({
      response: { data: { message: 'Network offline' } }
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'Unsaved Edit To Retry' } });
    fireEvent.blur(q1Input);

    // Save fails: UI preserves input and displays Save failed indicator
    await waitFor(() => {
      expect(screen.getByTestId('save-status-error')).toBeTruthy();
      expect(screen.getByText('Save failed')).toBeTruthy();
    });

    expect(q1Input.value).toBe('Unsaved Edit To Retry');

    // Setup successful resolution for retry
    api.put.mockResolvedValueOnce({
      data: { success: true, data: { _id: 'q1', label: 'Unsaved Edit To Retry', version: 1 } }
    });

    // Click Retry button
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q1',
        expect.objectContaining({ label: 'Unsaved Edit To Retry' })
      );
    });
  });

  it('retains newer edit typed during in-flight save and persists it', async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    api.put.mockImplementation((url, body) => {
      if (body.label === 'Edit 1') {
        return firstPromise;
      }
      return Promise.resolve({
        data: { success: true, data: { _id: 'q1', label: body.label, version: 2 } }
      });
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const q1Input = screen.getByDisplayValue('Question 1');

    // First edit initiates request
    fireEvent.change(q1Input, { target: { value: 'Edit 1' } });
    fireEvent.blur(q1Input);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q1',
        expect.objectContaining({ label: 'Edit 1' })
      );
    });

    // While first request is in flight, user types Edit 2
    fireEvent.change(q1Input, { target: { value: 'Edit 2' } });

    // First request completes with older Edit 1
    resolveFirst({
      data: { success: true, data: { _id: 'q1', label: 'Edit 1', version: 1 } }
    });

    // Edit 2 must not be overwritten by Edit 1 response
    await waitFor(() => {
      expect(q1Input.value).toBe('Edit 2');
    });

    // Edit 2 is flushed and persisted
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q1',
        expect.objectContaining({ label: 'Edit 2' })
      );
    });
  });

  it('reconciles HTTP 409 conflict by adopting updated server version and retrying user edit', async () => {
    api.put
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            success: false,
            message: 'Conflict: Question has been modified by another update',
            data: { _id: 'q1', label: 'Concurrent Label', version: 1 }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { _id: 'q1', label: 'My Local Edit', version: 2 }
        }
      });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'My Local Edit' } });
    fireEvent.blur(q1Input);

    // Initial attempt with version 0 receives 409
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q1',
        expect.objectContaining({ label: 'My Local Edit', version: 0 })
      );
    });

    // Automatically retries with updated version 1
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q1',
        expect.objectContaining({ label: 'My Local Edit', version: 1 })
      );
    });
  });

  it('does not mark save status as saved when newer edits are pending after an older save completes', async () => {
    let resolveSlow;
    const slowPromise = new Promise((resolve) => {
      resolveSlow = resolve;
    });

    api.put.mockImplementation((url, body) => {
      if (body.label === 'Initial Save') {
        return slowPromise;
      }
      return Promise.resolve({
        data: { success: true, data: { _id: 'q1', label: body.label, version: 2 } }
      });
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const q1Input = screen.getByDisplayValue('Question 1');
    fireEvent.change(q1Input, { target: { value: 'Initial Save' } });
    fireEvent.blur(q1Input);

    // Type a second edit while initial is saving
    fireEvent.change(q1Input, { target: { value: 'Second Save' } });

    // Initial save finishes
    resolveSlow({
      data: { success: true, data: { _id: 'q1', label: 'Initial Save', version: 1 } }
    });

    // Should not show "All changes saved" while Second Save is still pending
    await waitFor(() => {
      expect(screen.queryByTestId('save-status-saved')).toBeNull();
    });
  });

  it('includes current form version in AI title improvement and updates local version from response', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          form: { _id: '123', title: 'Test Form', description: 'Desc', status: 'draft', version: 5 },
          questions: [
            { _id: 'q1', label: 'Question 1', type: 'short_text', order: 0 }
          ]
        }
      }
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Form')).toBeTruthy();
    });

    const improveBtns = screen.getAllByTitle(/Improve title with AI/i);
    api.post.mockResolvedValueOnce({
      data: { success: true, data: { improvedText: 'AI Improved Title', changesSummary: 'Better wording' } }
    });

    fireEvent.click(improveBtns[0]);

    await waitFor(() => {
      expect(screen.getByText('AI Improved Title')).toBeTruthy();
    });

    api.put.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          _id: '123',
          title: 'AI Improved Title',
          description: 'Desc',
          status: 'draft',
          version: 6
        }
      }
    });

    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123',
        expect.objectContaining({
          title: 'AI Improved Title',
          description: 'Desc',
          version: 5
        })
      );
    });

    // Next edit to description should use updated version 6
    const descInput = screen.getByDisplayValue('Desc');
    fireEvent.change(descInput, { target: { value: 'New Manual Desc' } });
    fireEvent.blur(descInput);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123',
        expect.objectContaining({
          description: 'New Manual Desc',
          version: 6
        })
      );
    });
  });

  it('does not overwrite newer manual edits when applying AI description improvement', async () => {
    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    // User types manual edit to title
    const titleInput = screen.getByDisplayValue('Test Form');
    fireEvent.change(titleInput, { target: { value: 'Manual Form Title' } });

    // Open AI description improvement modal
    const improveBtns = screen.getAllByTitle(/Improve description with AI/i);
    api.post.mockResolvedValueOnce({
      data: { success: true, data: { improvedText: 'AI Improved Desc', changesSummary: 'Clearer' } }
    });

    fireEvent.click(improveBtns[0]);

    await waitFor(() => {
      expect(screen.getByText('AI Improved Desc')).toBeTruthy();
    });

    api.put.mockResolvedValue({
      data: {
        success: true,
        data: {
          _id: '123',
          title: 'Manual Form Title',
          description: 'AI Improved Desc',
          status: 'draft'
        }
      }
    });

    fireEvent.click(screen.getByText('Apply'));

    // Should include both the manual title edit and the improved description
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123',
        expect.objectContaining({
          title: 'Manual Form Title',
          description: 'AI Improved Desc'
        })
      );
    });
  });

  it('initializes version for newly created question and includes it on subsequent update', async () => {
    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    // Mock question creation returning version: 0
    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          _id: 'q_new_1',
          label: 'Untitled Question',
          type: 'short_text',
          order: 2,
          required: false,
          options: [],
          version: 0
        }
      }
    });

    const addBtn = screen.getByText('Add Question');
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Untitled Question')).toBeTruthy();
    });

    // Now edit the newly created question's label
    const newQInput = screen.getByDisplayValue('Untitled Question');
    fireEvent.change(newQInput, { target: { value: 'Brand New Question' } });
    fireEvent.blur(newQInput);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        '/api/forms/123/questions/q_new_1',
        expect.objectContaining({
          label: 'Brand New Question',
          version: 0
        })
      );
    });
  });

  it('stops automatic retrying when consecutive 409 conflict limit is reached', async () => {
    // Form update always rejects with 409
    api.put.mockImplementation(() =>
      Promise.reject({
        response: {
          status: 409,
          data: {
            success: false,
            message: 'Conflict: Form modified',
            data: { _id: '123', title: 'Remote Title', description: 'Desc', version: 99 }
          }
        }
      })
    );

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const titleInput = screen.getByDisplayValue('Test Form');
    fireEvent.change(titleInput, { target: { value: 'Attempt Conflict' } });
    fireEvent.blur(titleInput);

    // Initial attempt (1) + MAX_OCC_RETRIES (3) = 4 calls total
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledTimes(4);
    });

    // Wait a tick to ensure no further retries occur
    await new Promise((r) => setTimeout(r, 50));
    expect(api.put).toHaveBeenCalledTimes(4);

    // Error status and Retry button are displayed
    await waitFor(() => {
      expect(screen.getByText('Save failed')).toBeTruthy();
      expect(screen.getByText('Retry')).toBeTruthy();
    });
  });

  it('preserves unsaved edit after retry limit and allows manual retry to succeed and reset counter', async () => {
    let callCount = 0;
    api.put.mockImplementation((url, body) => {
      callCount++;
      if (callCount <= 4) {
        // Initial call + 3 retries reject with 409
        return Promise.reject({
          response: {
            status: 409,
            data: {
              success: false,
              message: 'Conflict',
              data: { _id: '123', title: 'Remote Title', description: 'Desc', version: callCount }
            }
          }
        });
      }
      // Manual retry call succeeds
      return Promise.resolve({
        data: {
          success: true,
          data: {
            _id: '123',
            title: body.title,
            description: body.description,
            version: 10
          }
        }
      });
    });

    renderComponent();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    });

    const titleInput = screen.getByDisplayValue('Test Form');
    fireEvent.change(titleInput, { target: { value: 'Preserved Unsaved Edit' } });
    fireEvent.blur(titleInput);

    await waitFor(() => {
      expect(screen.getByText('Save failed')).toBeTruthy();
      expect(screen.getByText('Retry')).toBeTruthy();
    });

    // Click Retry button
    const retryBtn = screen.getByText('Retry');
    fireEvent.click(retryBtn);

    // Should succeed and display "All changes saved"
    await waitFor(() => {
      expect(screen.getByText('All changes saved')).toBeTruthy();
    });

    // Check that the payload sent on manual retry was the preserved unsaved edit
    expect(api.put).toHaveBeenLastCalledWith(
      '/api/forms/123',
      expect.objectContaining({
        title: 'Preserved Unsaved Edit'
      })
    );
  });
});
