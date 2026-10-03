/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Loader from './Loader';

describe('Loader Component', () => {
  it('renders correctly with default props', () => {
    const { container } = render(<Loader />);
    // Check if the loader div is present and has the default size class
    const loaderDiv = container.querySelector('.h-8.w-8');
    expect(loaderDiv).not.toBeNull();
  });

  it('renders correctly with size "lg"', () => {
    const { container } = render(<Loader size="lg" />);
    // Check if the loader div has the large size class
    const loaderDiv = container.querySelector('.h-12.w-12');
    expect(loaderDiv).not.toBeNull();
  });
});
