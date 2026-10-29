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
            { _id: 'q-rating', type: 'rating', label: 'Satisfaction Score', required: false, order: 0 },
            { _id: 'q-date', type: 'date', label: 'Preferred Date', required: false, order: 1 },
            { _id: 'q-single', type: 'single_choice', label: 'Delivery Speed', options: ['Fast', 'Standard'], required: false, order: 2 },
            { _id: 'q-multi', type: 'multiple_choice', label: 'Interests', options: ['Tech', 'Art', 'Sports'], required: false, order: 3 },
            { _id: 'q-check', type: 'checkbox', label: 'Perks', options: ['Free Shipping', 'Discounts'], required: false, order: 4 }
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
    const ratingButtons = screen.getAllByRole('button').filter(b => ['1', '2', '3', '4', '5'].includes(b.textContent));
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
});
