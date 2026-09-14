// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Spinner,
  StatusIndicator,
  Switch,
} from './index';

afterEach(() => cleanup());

describe('Button', () => {
  it('invokes onClick and defaults to type=button', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire onClick while disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disables and announces while loading', () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole('button', { name: /Save/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeDefined();
  });
});

describe('Checkbox', () => {
  it('toggles via keyboard and associates its label', () => {
    render(<Checkbox label="Accept terms" />);
    const box = screen.getByLabelText('Accept terms') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it('supports disabled state', () => {
    render(<Checkbox label="Locked" disabled />);
    const box = screen.getByLabelText('Locked') as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });
});

describe('Switch', () => {
  it('exposes role=switch and toggles aria-checked', () => {
    const onChange = vi.fn();
    render(<Switch label="Dark mode" checked={false} onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Dark mode' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('fires false when switched off from checked', () => {
    const onChange = vi.fn();
    render(<Switch label="Sync" checked={true} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sync' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe('Badge', () => {
  it('renders its content with the requested tone', () => {
    render(<Badge tone="success">Active</Badge>);
    expect(screen.getByText('Active').className).toContain('v-badge--success');
  });
});

describe('StatusIndicator', () => {
  it('renders the label with its status dot', () => {
    render(<StatusIndicator tone="online" label="Connected" />);
    expect(screen.getByText('Connected')).toBeDefined();
  });
});

describe('Spinner', () => {
  it('renders an accessible status role', () => {
    render(<Spinner />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeDefined();
  });
});

describe('EmptyState', () => {
  it('renders title, description, and action', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No projects"
        description="Create one to begin."
        action={{ label: 'New project', onClick }}
      />,
    );
    expect(screen.getByText('No projects')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('ErrorState', () => {
  it('renders as an alert with a retry action', () => {
    const onClick = vi.fn();
    render(<ErrorState retry={{ onClick }} />);
    expect(screen.getByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
