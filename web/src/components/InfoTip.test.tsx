import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { InfoTip } from './InfoTip';

describe('InfoTip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an info button with an accessible name', () => {
    render(<InfoTip content="What this field means." label="Name" />);
    expect(screen.getByRole('button', { name: 'About Name' })).toBeTruthy();
  });

  it('opens the tooltip on hover', () => {
    vi.useFakeTimers();
    render(<InfoTip content="What this field means." label="Name" />);
    fireEvent.mouseOver(screen.getByRole('button', { name: 'About Name' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    expect(screen.getByText('What this field means.')).toBeTruthy();
  });

  it('opens the tooltip on keyboard focus', () => {
    vi.useFakeTimers();
    render(<InfoTip content="What this field means." label="Name" />);
    act(() => {
      screen.getByRole('button', { name: 'About Name' }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('closes the tooltip on Escape', () => {
    vi.useFakeTimers();
    render(<InfoTip content="What this field means." label="Name" />);
    fireEvent.mouseOver(screen.getByRole('button', { name: 'About Name' }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
