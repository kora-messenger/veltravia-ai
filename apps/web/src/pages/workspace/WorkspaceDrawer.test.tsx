import { afterEach, describe, expect, it, vi } from 'vitest';

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceDrawer } from './WorkspaceDrawer';

afterEach(() => cleanup());

describe('WorkspaceDrawer', () => {
  it('renders nothing until opened', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <WorkspaceDrawer open={false} onClose={onClose} label="Context">
        <p>Panel body</p>
      </WorkspaceDrawer>,
    );
    expect(screen.queryByText('Panel body')).toBeNull();
    rerender(
      <WorkspaceDrawer open={true} onClose={onClose} label="Context">
        <p>Panel body</p>
      </WorkspaceDrawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Context' })).toBeDefined();
    expect(screen.getByText('Panel body')).toBeDefined();
  });

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn();
    render(
      <WorkspaceDrawer open={true} onClose={onClose} label="Context">
        <p>Body</p>
      </WorkspaceDrawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <WorkspaceDrawer open={true} onClose={onClose} label="Context">
        <p>Body</p>
      </WorkspaceDrawer>,
    );
    fireEvent.click(document.querySelector('.v-wdrawer__backdrop') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes an accessible dialog with a labelled title', () => {
    render(
      <WorkspaceDrawer open={true} onClose={() => undefined} label="Activity">
        <p>Body</p>
      </WorkspaceDrawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Activity' })).toBeDefined();
  });
});
