import { VELTRAVIA_NAME, VELTRAVIA_VERSION } from '@veltravia/types';

export function App() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        margin: '0 auto',
        maxWidth: 720,
        padding: '4rem 1.5rem',
      }}
    >
      <h1>{VELTRAVIA_NAME}</h1>
      <p>An advanced AI software-development platform.</p>
      <p>
        <strong>Development stage:</strong> Step 1 &mdash; Foundation (v{VELTRAVIA_VERSION})
      </p>
    </main>
  );
}
