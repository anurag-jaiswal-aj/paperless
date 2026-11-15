/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PublicForm from './PublicForm';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import api from '../utils/api';

vi.mock('../utils/api');

describe('PublicForm Component - Question Types & Visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderComponent = (formId = 'form-123') => {
    return render(
      <MemoryRouter initialEntries={[`/forms/${formId}`]}>
        <Routes>
          <Route path="/forms/:id" element={<PublicForm />} />
        </Routes>
      </MemoryRouter>
    );
  };

  it('renders rating, date, single_choice, and multiple_choice questions properly', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          form: { _id: 'form-123', title: 'Survey Form', description: 'Testing types' },
          questions: [
            {
              _id: 'q-rating',
              type: 'rating',
              label: 'Satisfaction Score',
              required: false,
              order: 0
            },
            { _id: 'q-date', type: 'date', label: 'Preferred Date', required: false, order: 1 },
            {
              _id: 'q-single',
              type: 'single_choice',
              label: 'Delivery Speed',
              options: ['Fast', 'Standard'],
              required: false,
              order: 2
            },
            {
              _id: 'q-multi',
              type: 'multiple_choice',
              label: 'Interests',
              options: ['Tech', 'Art', 'Sports'],
              required: false,
              order: 3
            },
            {
              _id: 'q-check',
              type: 'checkbox',
              label: 'Perks',
              options: ['Free Shipping', 'Discounts'],
              required: false,
              order: 4
            }
          ]
        }
      }
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Survey Form')).toBeTruthy();
      expect(screen.getByText('Satisfaction Score')).toBeTruthy();
      expect(screen.getByText('Preferred Date')).toBeTruthy();
      expect(screen.getByText('Delivery Speed')).toBeTruthy();
      expect(screen.getByText('Interests')).toBeTruthy();
      expect(screen.getByText('Perks')).toBeTruthy();
    });

    // Verify rating buttons (1 to 5)
    const ratingButtons = screen
      .getAllByRole('button')
      .filter((b) => ['1', '2', '3', '4', '5'].includes(b.textContent));
    expect(ratingButtons.length).toBe(5);

    // Click rating 4
    fireEvent.click(ratingButtons[3]); // Rating 4
    expect(ratingButtons[3].className).toContain('bg-gray-900');

    // Select date
    const dateInput = document.querySelector('input[type="date"]');
    expect(dateInput).toBeTruthy();
    fireEvent.change(dateInput, { target: { value: '2026-10-29' } });
    expect(dateInput.value).toBe('2026-10-29');

    // Select single choice
    const fastRadio = screen.getByLabelText('Fast');
    fireEvent.click(fastRadio);
    expect(fastRadio.checked).toBe(true);

    // Multi-select checkboxes
    const techCheck = screen.getByLabelText('Tech');
    const artCheck = screen.getByLabelText('Art');
    fireEvent.click(techCheck);
    fireEvent.click(artCheck);
    expect(techCheck.checked).toBe(true);
    expect(artCheck.checked).toBe(true);
  });

  it('validates required rating and required date on submission', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          form: { _id: 'form-123', title: 'Required Fields Form' },
          questions: [
            { _id: 'q-rating', type: 'rating', label: 'Required Rating', required: true, order: 0 },
            { _id: 'q-date', type: 'date', label: 'Required Date', required: true, order: 1 }
          ]
        }
      }
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Required Rating')).toBeTruthy();
    });

    const formElement = document.querySelector('form');

    // Attempt submission with rating missing
    fireEvent.submit(formElement);

    await waitFor(() => {
      expect(screen.getByText('Please answer: Required Rating')).toBeTruthy();
    });

    // Select rating 5
    const btn5 = screen.getByRole('button', { name: '5' });
    fireEvent.click(btn5);

    // Submit again with date missing
    fireEvent.submit(formElement);

    await waitFor(() => {
      expect(screen.getByText('Please answer: Required Date')).toBeTruthy();
    });

    // Fill date
    const dateInput = document.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2026-10-29' } });

    // Submit successfully
    api.post.mockResolvedValueOnce({ data: { success: true } });
    fireEvent.submit(formElement);

    await waitFor(() => {
      expect(screen.getByText('Thank You!')).toBeTruthy();
      expect(screen.getByText(/Your response has been recorded successfully/i)).toBeTruthy();
    });
  });

  it('evaluates conditional visibility when target question is a rating or multiple_choice', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          form: { _id: 'form-123', title: 'Conditional Form' },
          questions: [
            { _id: 'q-rating', type: 'rating', label: 'Rating', required: false, order: 0 },
            {
              _id: 'q-followup',
              type: 'short_text',
              label: 'Why the high score?',
              required: false,
              order: 1,
              visibilityRule: {
                targetQuestionId: 'q-rating',
                operator: 'equals',
                value: '5'
              }
            },
            {
              _id: 'q-multi',
              type: 'multiple_choice',
              label: 'Hobbies',
              options: ['Reading', 'Gaming'],
              required: false,
              order: 2
            },
            {
              _id: 'q-gamer-tag',
              type: 'short_text',
              label: 'What is your GamerTag?',
              required: false,
              order: 3,
              visibilityRule: {
                targetQuestionId: 'q-multi',
                operator: 'contains',
                value: 'Gaming'
              }
            }
          ]
        }
      }
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Rating')).toBeTruthy();
    });

    // Initially, dependent questions should NOT be visible
    expect(screen.queryByText('Why the high score?')).toBeNull();
    expect(screen.queryByText('What is your GamerTag?')).toBeNull();

    // Select Rating 4 -> followup still hidden
    const btn4 = screen.getByRole('button', { name: '4' });
    fireEvent.click(btn4);
    expect(screen.queryByText('Why the high score?')).toBeNull();

    // Select Rating 5 -> followup becomes visible
    const btn5 = screen.getByRole('button', { name: '5' });
    fireEvent.click(btn5);
    expect(screen.getByText('Why the high score?')).toBeTruthy();

    // Select 'Reading' -> gamer tag still hidden
    const readCheck = screen.getByLabelText('Reading');
    fireEvent.click(readCheck);
    expect(screen.queryByText('What is your GamerTag?')).toBeNull();

    // Select 'Gaming' -> gamer tag becomes visible
    const gameCheck = screen.getByLabelText('Gaming');
    fireEvent.click(gameCheck);
    expect(screen.getByText('What is your GamerTag?')).toBeTruthy();
  });

  describe('Stage 4.3.5 Batch D: Double Submission Guard & Client File Validation', () => {
    it('D2: guards against double submission via synchronous ref lock', async () => {
      let resolveApi;
      const apiPromise = new Promise((resolve) => {
        resolveApi = resolve;
      });
      api.post.mockReturnValue(apiPromise);

      api.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            form: { _id: 'form-submit-test', title: 'Submit Test' },
            questions: [
              { _id: 'q1', type: 'short_text', label: 'Feedback', required: false, order: 0 }
            ]
          }
        }
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText('Submit Test')).toBeTruthy();
      });

      const formElement = document.querySelector('form');

      // Dispatch rapid double submission
      fireEvent.submit(formElement);
      fireEvent.submit(formElement);

      // Verify api.post was called only once despite rapid multi-submission
      expect(api.post).toHaveBeenCalledTimes(1);

      // Resolve API
      resolveApi({ data: { success: true } });
      await waitFor(() => {
        expect(screen.getByText('Thank You!')).toBeTruthy();
      });
    });

    it('D5: validates file input accept attribute and enforces 5MB client-side limit', async () => {
      api.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            form: { _id: 'form-file-test', title: 'File Upload Form' },
            questions: [{ _id: 'q-file', type: 'file', label: 'Resume', required: false, order: 0 }]
          }
        }
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText('Resume')).toBeTruthy();
      });

      const fileInput = document.querySelector('input[type="file"]');
      expect(fileInput).toBeTruthy();
      expect(fileInput.getAttribute('accept')).toContain('image/jpeg');
      expect(fileInput.getAttribute('accept')).toContain('application/pdf');

      // Upload oversized file (> 5MB)
      const oversizedFile = new File(['x'.repeat(100)], 'huge.pdf', { type: 'application/pdf' });
      Object.defineProperty(oversizedFile, 'size', { value: 6 * 1024 * 1024 });

      fireEvent.change(fileInput, { target: { files: [oversizedFile] } });

      await waitFor(() => {
        expect(screen.getByText(/exceeds maximum allowed size of 5MB/i)).toBeTruthy();
      });

      // Submit form while oversized file error is active
      const formElement = document.querySelector('form');
      fireEvent.submit(formElement);

      // Verify api.post was NOT called
      expect(api.post).not.toHaveBeenCalled();
    });

    it('retains the same Idempotency-Key across retries of the same submission', async () => {
      api.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            form: { _id: 'form-idem-test', title: 'Idempotency Form' },
            questions: [{ _id: 'q1', type: 'short_text', label: 'Name', required: true, order: 0 }]
          }
        }
      });

      // First submit attempt fails with network error; retry succeeds
      api.post
        .mockRejectedValueOnce({ response: { data: { message: 'Network Timeout' } } })
        .mockResolvedValueOnce({ data: { success: true } });

      renderComponent('form-idem-test');

      await waitFor(() => {
        expect(screen.getByText('Idempotency Form')).toBeTruthy();
      });

      // Fill question
      const input = screen.getByPlaceholderText('Your answer');
      fireEvent.change(input, { target: { value: 'Jane Doe' } });

      const submitButton = screen.getByRole('button', { name: /submit response/i });

      // First submit attempt
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Network Timeout')).toBeTruthy();
      });

      expect(api.post).toHaveBeenCalledTimes(1);
      const firstCallHeaders = api.post.mock.calls[0][2]?.headers || {};
      const firstKey = firstCallHeaders['Idempotency-Key'];
      expect(firstKey).toBeTruthy();

      // User clicks Submit Response again without changing answer (retry)
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Thank You!')).toBeTruthy();
      });

      expect(api.post).toHaveBeenCalledTimes(2);
      const secondCallHeaders = api.post.mock.calls[1][2]?.headers || {};
      const secondKey = secondCallHeaders['Idempotency-Key'];

      // The same idempotency key was retained across retries
      expect(secondKey).toBe(firstKey);
    });
  });
});
