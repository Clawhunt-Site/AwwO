// OnboardingTour behavior contract: localized multi-step walkthrough that
// reports completion / skip through onClose (the host persists it in the kernel).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OnboardingTour } from '../src/OnboardingTour';

afterEach(() => {
  cleanup();
});

describe('OnboardingTour', () => {
  it('renders nothing when closed', () => {
    render(<OnboardingTour open={false} locale="en" onClose={() => {}} />);
    expect(screen.queryByText('Welcome to ClawHunt')).not.toBeInTheDocument();
  });

  it('renders the first step with locale-specific copy', () => {
    const { rerender } = render(<OnboardingTour open locale="en" onClose={() => {}} />);
    expect(screen.getByText('Welcome to ClawHunt')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();

    rerender(<OnboardingTour open locale="zh" onClose={() => {}} />);
    expect(screen.getByText('欢迎来到 ClawHunt')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 5 步')).toBeInTheDocument();
  });

  it('advances through every step and finishes with completed=true', () => {
    const onClose = vi.fn();
    render(<OnboardingTour open locale="en" onClose={onClose} />);

    // No Back affordance on the first step.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    }

    expect(screen.getByText("You're all set")).toBeInTheDocument();
    expect(screen.getByText('Step 5 of 5')).toBeInTheDocument();

    // The final primary action completes the tour.
    fireEvent.click(screen.getByRole('button', { name: /Get started/ }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('Back returns to the previous step', () => {
    render(<OnboardingTour open locale="en" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });

  it('skipping reports completed=false', () => {
    const onClose = vi.fn();
    render(<OnboardingTour open locale="en" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('Escape skips the tour (completed=false)', () => {
    const onClose = vi.fn();
    render(<OnboardingTour open locale="en" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
