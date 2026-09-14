// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog, Input, Menu, Select, Tabs, Textarea, Tooltip } from './index';

afterEach(() => cleanup());

describe('Input', () => {
  it('associates label, hint, and error with the control', () => {
    render(<Input label="Email" hint="Work address" error="Invalid format" />);
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Invalid format')).toBeDefined();
    expect(describedBy.length).toBeGreaterThan(0);
  });

  it('accepts typed values and marks required', () => {
    render(<Input label="Name" required />);
    const input = screen.getByLabelText(/Name/) as HTMLInputElement;
    expect(input.required).toBe(true);
    fireEvent.change(input, { target: { value: 'Veltravia' } });
    expect(input.value).toBe('Veltravia');
  });
});

describe('Textarea', () => {
  it('associates its label and error', () => {
    render(<Textarea label="Notes" error="Too long" />);
    const area = screen.getByLabelText('Notes') as HTMLTextAreaElement;
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Too long')).toBeDefined();
  });
});

describe('Select', () => {
  it('renders options and associates label + placeholder', () => {
    render(
      <Select
        label="Environment"
        placeholder="Choose…"
        options={[
          { value: 'dev', label: 'Development' },
          { value: 'prod', label: 'Production', disabled: true },
        ]}
      />,
    );
    const select = screen.getByLabelText('Environment') as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(screen.getByText('Choose…')).toBeDefined();
  });
});

describe('Dialog', () => {
  it('renders nothing until open', () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Confirm">
        body
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders an accessible modal when open and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose} title="Confirm" description="Are you sure?">
        <p>Contents</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Contents')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose} title="Confirm">
        body
      </Dialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('restores focus to the previously focused element on close', () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <Dialog open={true} onClose={() => {}} title="Confirm">
        body
      </Dialog>,
    );
    unmount();
    expect(document.activeElement).toBe(opener);
    document.body.removeChild(opener);
  });
});

describe('Menu', () => {
  const items = [
    { id: 'light', label: 'Light', onSelect: vi.fn() },
    { id: 'dark', label: 'Dark', onSelect: vi.fn() },
    { id: 'disabled', label: 'Unavailable', onSelect: vi.fn(), disabled: true },
  ];

  it('opens on click with aria-expanded and closes on Escape restoring focus', () => {
    render(<Menu triggerLabel="Theme menu" trigger={<span>Theme</span>} items={items} />);
    const trigger = screen.getByRole('button', { name: 'Theme menu' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Theme menu' })).toBeDefined();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('selects an item and closes', () => {
    render(<Menu triggerLabel="Theme menu" trigger={<span>Theme</span>} items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dark' }));
    expect(items[1]?.onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('navigates items with arrow keys', () => {
    render(<Menu triggerLabel="Theme menu" trigger={<span>Theme</span>} items={items} />);
    const trigger = screen.getByRole('button', { name: 'Theme menu' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    const menuitems = screen.getAllByRole('menuitem');
    expect(menuitems[1]?.className).toContain('v-menu__item--active');
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'a', label: 'Alpha', content: <p>Alpha panel</p> },
    { id: 'b', label: 'Beta', content: <p>Beta panel</p> },
  ];

  it('renders only the active tab panel with correct ARIA wiring', () => {
    render(<Tabs tabs={tabs} aria-label="Sections" />);
    expect(screen.getByRole('tab', { selected: true, name: 'Alpha' })).toBeDefined();
    expect(screen.getByText('Alpha panel')).toBeDefined();
    expect(screen.queryByText('Beta panel')).toBeNull();
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected.getAttribute('aria-controls')).toBe(
      screen.getByRole('tabpanel').getAttribute('id'),
    );
  });

  it('switches tabs via click and arrow keys', () => {
    render(<Tabs tabs={tabs} aria-label="Sections" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(screen.getByText('Beta panel')).toBeDefined();
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { selected: true, name: 'Alpha' })).toBeDefined();
  });
});

describe('Tooltip', () => {
  it('exposes its text via aria-describedby on a focusable target', () => {
    render(
      <Tooltip text="Extra context">
        <span>item</span>
      </Tooltip>,
    );
    const target = screen.getByText('item').parentElement;
    expect(target).not.toBeNull();
    const describedBy = target?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Extra context');
  });
});
