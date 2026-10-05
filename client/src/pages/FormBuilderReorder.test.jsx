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
  let state = initialState;
  return {
    getState: () => state,
    dispatch: vi.fn((action) => {
      if (action.type === 'forms/reorderQuestions') {
        state.forms.questions = action.payload;
      }
    }),
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

describe('FormBuilder Reordering', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      auth: { user: { id: 'user1' } },
      forms: {
        currentForm: { _id: '123', title: 'Test Form', description: 'Desc' },
        questions: [
          { _id: 'q1', label: 'Question 1', type: 'short_text', order: 0 },
          { _id: 'q2', label: 'Question 2', type: 'short_text', order: 1 },
          { _id: 'q3', label: 'Question 3', type: 'short_text', order: 2 },
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

  const triggerDragEnd = (sourceIndex, destinationIndex) => {
    const dndContext = screen.getByTestId('dnd-context');
    if (destinationIndex === null) {
      dndContext.setAttribute('data-ondragend', JSON.stringify({
        source: { index: sourceIndex },
        destination: null
      }));
    } else {
      dndContext.setAttribute('data-ondragend', JSON.stringify({
        source: { index: sourceIndex },
        destination: { index: destinationIndex }
      }));
    }
    fireEvent.click(dndContext);
  };

  it('preserves initial order', () => {
    renderComponent();
    expect(screen.getByDisplayValue('Question 1')).toBeTruthy();
    expect(screen.getByDisplayValue('Question 2')).toBeTruthy();
    expect(screen.getByDisplayValue('Question 3')).toBeTruthy();
  });

  it('dragging question A onto question B changes order correctly', async () => {
    renderComponent();
    api.put.mockResolvedValueOnce({ data: { success: true } });
    
    // Move Q1 (index 0) to Q2 (index 1)
    triggerDragEnd(0, 1);

    expect(store.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'forms/reorderQuestions',
        payload: [
          expect.objectContaining({ _id: 'q2' }),
          expect.objectContaining({ _id: 'q1' }),
          expect.objectContaining({ _id: 'q3' }),
        ]
      })
    );

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/reorder', {
        questionOrders: [
          { questionId: 'q2', order: 0 },
          { questionId: 'q1', order: 1 },
          { questionId: 'q3', order: 2 },
        ]
      });
    });
  });

  it('moving the last question to the first position works', async () => {
    renderComponent();
    api.put.mockResolvedValueOnce({ data: { success: true } });
    
    triggerDragEnd(2, 0);

    expect(store.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'forms/reorderQuestions',
        payload: [
          expect.objectContaining({ _id: 'q3' }),
          expect.objectContaining({ _id: 'q1' }),
          expect.objectContaining({ _id: 'q2' }),
        ]
      })
    );

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/forms/123/questions/reorder', {
        questionOrders: [
          { questionId: 'q3', order: 0 },
          { questionId: 'q1', order: 1 },
          { questionId: 'q2', order: 2 },
        ]
      });
    });
  });

  it('dropping onto itself does not change order', async () => {
    renderComponent();
    api.put.mockResolvedValueOnce({ data: { success: true } });
    
    triggerDragEnd(1, 1);

    expect(store.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'forms/reorderQuestions',
        payload: [
          expect.objectContaining({ _id: 'q1' }),
          expect.objectContaining({ _id: 'q2' }),
          expect.objectContaining({ _id: 'q3' }),
        ]
      })
    );
  });

  it('dropping outside does not corrupt array', async () => {
    renderComponent();
    
    triggerDragEnd(1, null);

    // handleDragEnd aborts early if !destination
    expect(store.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'forms/reorderQuestions' })
    );
  });
});
