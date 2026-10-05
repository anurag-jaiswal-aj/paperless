/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import CustomSelect from './CustomSelect';

describe('CustomSelect Component', () => {
  const options = [
    { value: 'draft', label: 'Draft' },
    { value: 'published', label: 'Published' },
    { value: 'closed', label: 'Closed' }
  ];

  it('updates visual selection when used with state', () => {
    const Wrapper = () => {
      const [val, setVal] = useState('draft');
      return <CustomSelect value={val} onChange={setVal} options={options} />;
    };
    render(<Wrapper />);
    expect(screen.getByText('Draft')).toBeTruthy();
    
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.pointerDown(screen.getByText('Published'));
    
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getAllByText('Published').length).toBe(1);
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('renders selected value', () => {
    render(<CustomSelect value="published" onChange={vi.fn()} options={options} />);
    expect(screen.getByText('Published')).toBeTruthy();
  });

  it('opens on click', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    const combobox = screen.getByRole('combobox');
    fireEvent.click(combobox);
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('displays all options', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByText('Draft').length).toBe(2);
    expect(screen.getByText('Published')).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
  });

  it('selecting an option calls onChange with correct value', () => {
    const onChangeMock = vi.fn();
    render(<CustomSelect value="draft" onChange={onChangeMock} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Published'));
    expect(onChangeMock).toHaveBeenCalledWith('published');
  });

  it('closes after selection', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Published'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('escape closes the dropdown', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    const combobox = screen.getByRole('combobox');
    fireEvent.click(combobox);
    fireEvent.keyDown(combobox, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ArrowDown moves the active option', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    const container = screen.getByRole('combobox').parentElement;
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.keyDown(container, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(container, { key: 'ArrowDown', code: 'ArrowDown' });
  });

  it('ArrowUp moves the active option', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    const container = screen.getByRole('combobox').parentElement;
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.keyDown(container, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(container, { key: 'ArrowUp', code: 'ArrowUp' });
  });

  it('Enter selects the active option', () => {
    const onChangeMock = vi.fn();
    render(<CustomSelect value="draft" onChange={onChangeMock} options={options} />);
    const container = screen.getByRole('combobox').parentElement;
    fireEvent.click(screen.getByRole('combobox'));
    // initially focused is index 0
    fireEvent.keyDown(container, { key: 'ArrowDown', code: 'ArrowDown' });
    // now index 1
    fireEvent.keyDown(container, { key: 'Enter', code: 'Enter' });
    expect(onChangeMock).toHaveBeenCalledWith('published');
  });

  it('clicking outside closes it', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selected option is marked correctly', () => {
    render(<CustomSelect value="published" onChange={vi.fn()} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    const optionsEl = screen.getAllByRole('option');
    expect(optionsEl[1].getAttribute('aria-selected')).toBe('true');
  });

  it('disabled state prevents interaction', () => {
    const onChangeMock = vi.fn();
    render(<CustomSelect value="draft" onChange={onChangeMock} options={options} disabled={true} />);
    const combobox = screen.getByRole('combobox');
    fireEvent.click(combobox);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('renders portal menu outside the component immediate parent hierarchy', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    const combobox = screen.getByRole('combobox');
    fireEvent.click(combobox);
    const listbox = screen.getByRole('listbox');
    expect(combobox.parentElement.contains(listbox)).toBe(false);
  });

  it('applies dynamic width styling to listbox', () => {
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 150,
      left: 10,
      top: 100,
      bottom: 120
    }));

    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    
    const listbox = screen.getByRole('listbox');
    expect(listbox.style.minWidth).toBe('150px');
    expect(listbox.style.width).toBe('max-content');
    
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it('option labels do not have truncation classes', () => {
    render(<CustomSelect value="draft" onChange={vi.fn()} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');
    const draftSpan = Array.from(listbox.querySelectorAll('span')).find(el => el.textContent === 'Draft');
    expect(draftSpan.className).not.toContain('truncate');
    expect(draftSpan.className).toContain('whitespace-nowrap');
    expect(draftSpan.className).toContain('overflow-visible');
    expect(draftSpan.className).toContain('text-clip');
  });

  it('selecting an option via pointerdown calls onChange and closes menu', () => {
    const onChangeMock = vi.fn();
    render(<CustomSelect value="draft" onChange={onChangeMock} options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    const option = screen.getByText('Published');
    
    fireEvent.pointerDown(option);
    
    expect(onChangeMock).toHaveBeenCalledWith('published');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
