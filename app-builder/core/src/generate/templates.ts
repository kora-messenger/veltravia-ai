/**
 * Deterministic starter templates (Step 30).
 *
 * Each template is a PURE function of the specification: no network, no host
 * access, no randomness, no clock. The same spec always produces the same
 * bytes, so a plan can be reviewed and diffed before anything is written.
 *
 * A template exists only for technologies whose registry entry says
 * `supportLevel: 'scaffold'`. Everything else honestly has no template.
 */

import type { PlannedFile, ProjectSpecification } from '../types/index.js';

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'veltravia-app'
  );
}

function packageName(name: string): string {
  return slug(name).replace(/-/g, '_');
}

function pascal(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Escapes user text before it reaches generated HTML. */
function html(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escapes user text before it reaches generated string literals. */
function js(text: string): string {
  return JSON.stringify(text);
}

export type TemplateBuilder = (spec: ProjectSpecification) => readonly PlannedFile[];

const HTML_TEMPLATE: TemplateBuilder = (spec) => [
  {
    path: 'index.html',
    description: 'The page shell.',
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(spec.name)}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="app">
      <h1>${html(spec.name)}</h1>
      <p>${html(spec.description || 'Describe what this application does.')}</p>
      <button id="action" type="button">Get started</button>
      <p id="status" role="status" aria-live="polite"></p>
    </main>
    <script src="main.js" type="module"></script>
  </body>
</html>
`,
  },
  {
    path: 'styles.css',
    description: 'Base styling, no framework.',
    content: `:root {
  color-scheme: light dark;
  --surface: #0b1020;
  --text: #f5f6fa;
  --accent: #6c63ff;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--surface);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.app {
  max-width: 42rem;
  padding: 2rem;
  text-align: center;
}

button {
  margin-top: 1.5rem;
  padding: 0.75rem 1.25rem;
  border: 0;
  border-radius: 0.75rem;
  background: var(--accent);
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}
`,
  },
  {
    path: 'main.js',
    description: 'Minimal interaction wired to the page.',
    content: `const button = document.querySelector('#action');
const status = document.querySelector('#status');

button?.addEventListener('click', () => {
  if (status) status.textContent = ${js(`${spec.name} is ready for its first feature.`)};
});
`,
  },
];

const REACT_TEMPLATE: TemplateBuilder = (spec) => {
  const component = pascal(spec.name);
  return [
    {
      path: 'package.json',
      description: 'Vite + React project manifest.',
      content: `${JSON.stringify(
        {
          name: slug(spec.name),
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'vite build',
            preview: 'vite preview',
            test: 'vitest run',
          },
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
          devDependencies: {
            '@vitejs/plugin-react': '^4.3.0',
            typescript: '^5.6.0',
            vite: '^5.4.0',
            vitest: '^2.1.0',
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'index.html',
      description: 'Vite entry document.',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(spec.name)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: 'src/main.tsx',
      description: 'React bootstrap.',
      content: `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    },
    {
      path: 'src/App.tsx',
      description: `The ${component} root component.`,
      content: `import { useState } from 'react';

export function App() {
  const [message, setMessage] = useState<string>('');

  return (
    <main className="app">
      <h1>${js(spec.name).slice(1, -1)}</h1>
      <p>${js(spec.description || 'Describe what this application does.').slice(1, -1)}</p>
      <button type="button" onClick={() => setMessage('Ready for the first feature.')}>
        Get started
      </button>
      <p role="status" aria-live="polite">{message}</p>
    </main>
  );
}
`,
    },
    {
      path: 'src/styles.css',
      description: 'Base styling.',
      content: `:root {
  color-scheme: dark;
  --accent: #6c63ff;
}

body {
  margin: 0;
  background: #0b1020;
  color: #f5f6fa;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.app {
  display: grid;
  gap: 1rem;
  place-content: center;
  min-height: 100vh;
  text-align: center;
}

button {
  padding: 0.75rem 1.25rem;
  border: 0;
  border-radius: 0.75rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
`,
    },
    {
      path: 'tsconfig.json',
      description: 'TypeScript configuration for the browser build.',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ['src'],
        },
        null,
        2,
      )}\n`,
    },
  ];
};

const NODE_FASTIFY_TEMPLATE: TemplateBuilder = (spec) => [
  {
    path: 'package.json',
    description: 'Node service manifest.',
    content: `${JSON.stringify(
      {
        name: slug(spec.name),
        private: true,
        version: '0.1.0',
        type: 'module',
        main: 'dist/server.js',
        scripts: {
          dev: 'tsx watch src/server.ts',
          build: 'tsc -p tsconfig.json',
          start: 'node dist/server.js',
          test: 'vitest run',
        },
        dependencies: { fastify: '^5.0.0' },
        devDependencies: { tsx: '^4.19.0', typescript: '^5.6.0', vitest: '^2.1.0' },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: 'src/server.ts',
    description: 'Fastify entry point with a health route.',
    content: `import Fastify from 'fastify';

const app = Fastify({ logger: false });

app.get('/health', async () => ({ ok: true, service: ${js(spec.name)} }));

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    process.stdout.write(\`listening on \${port}\\n\`);
  })
  .catch((error: unknown) => {
    process.stderr.write(\`failed to start: \${String(error)}\\n\`);
    process.exitCode = 1;
  });
`,
  },
  {
    path: 'tsconfig.json',
    description: 'Node TypeScript configuration.',
    content: `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          outDir: 'dist',
          rootDir: 'src',
          declaration: true,
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  },
];

const PYTHON_TEMPLATE: TemplateBuilder = (spec) => [
  {
    path: 'requirements.txt',
    description: 'Runtime dependencies.',
    content: 'pytest==8.3.3\n',
  },
  {
    path: `${packageName(spec.name)}/__init__.py`,
    description: 'Package marker.',
    content: `"""${spec.name}."""\n\n__all__ = ["main"]\n`,
  },
  {
    path: `${packageName(spec.name)}/main.py`,
    description: 'Entry module with a small pure function.',
    content: `"""Entry point for ${spec.name.replace(/"/g, "'")}."""

from __future__ import annotations


def greet(name: str) -> str:
    """Return a greeting. Kept pure so it is testable without a server."""
    cleaned = name.strip() or "world"
    return f"Hello, {cleaned}!"


def main() -> int:
    print(greet("veltravia"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`,
  },
  {
    path: 'tests/test_main.py',
    description: 'A first test that actually asserts something.',
    content: `from ${packageName(spec.name)}.main import greet


def test_greet_defaults_to_world() -> None:
    assert greet("   ") == "Hello, world!"


def test_greet_uses_the_name() -> None:
    assert greet("Veltravia") == "Hello, Veltravia!"
`,
  },
];

const GO_TEMPLATE: TemplateBuilder = (spec) => [
  {
    path: 'go.mod',
    description: 'Module definition.',
    content: `module example.com/${slug(spec.name)}

go 1.22
`,
  },
  {
    path: 'main.go',
    description: 'HTTP entry point.',
    content: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

func health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "service": ${JSON.stringify(spec.name)}})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", health)

	addr := ":8080"
	log.Printf("listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
`,
  },
  {
    path: 'main_test.go',
    description: 'A handler test.',
    content: `package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealth(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/health", nil)

	health(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
}
`,
  },
];

const FLUTTER_TEMPLATE: TemplateBuilder = (spec) => [
  {
    path: 'pubspec.yaml',
    description: 'Flutter package manifest.',
    content: `name: ${packageName(spec.name)}
description: ${spec.description || 'A Veltravia mobile application.'}
publish_to: none
version: 0.1.0+1

environment:
  sdk: ">=3.4.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0
`,
  },
  {
    path: 'lib/main.dart',
    description: 'App entry with a single screen.',
    content: `import 'package:flutter/material.dart';

void main() => runApp(const VeltraviaApp());

class VeltraviaApp extends StatelessWidget {
  const VeltraviaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: ${JSON.stringify(spec.name)},
      theme: ThemeData(colorSchemeSeed: const Color(0xFF6C63FF), useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text(${JSON.stringify(spec.name)})),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            ${JSON.stringify(spec.description || 'Ready for the first feature.')},
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
`,
  },
  {
    path: 'test/widget_test.dart',
    description: 'Widget smoke test.',
    content: `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:${packageName(spec.name)}/main.dart';

void main() {
  testWidgets('renders the app title', (WidgetTester tester) async {
    await tester.pumpWidget(const VeltraviaApp());
    expect(find.text(${JSON.stringify(spec.name)}), findsOneWidget);
  });
}
`,
  },
];

const JAVASCRIPT_TEMPLATE: TemplateBuilder = (spec) => [
  {
    path: 'package.json',
    description: 'Plain Node package manifest.',
    content: `${JSON.stringify(
      {
        name: slug(spec.name),
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: { test: 'node --test', start: 'node src/index.js' },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: 'src/index.js',
    description: 'Entry module.',
    content: `export function greet(name) {
  const cleaned = String(name ?? '').trim() || 'world';
  return \`Hello, \${cleaned}!\`;
}

process.stdout.write(\`\${greet(${js(spec.name)})}\\n\`);
`,
  },
  {
    path: 'tests/greet.test.js',
    description: 'Node test-runner test.',
    content: `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from '../src/index.js';

test('greets a default when the name is blank', () => {
  assert.equal(greet('   '), 'Hello, world!');
});
`,
  },
];

const TYPESCRIPT_TEMPLATE: TemplateBuilder = (spec) => [
  {
    path: 'package.json',
    description: 'TypeScript package manifest.',
    content: `${JSON.stringify(
      {
        name: slug(spec.name),
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: { build: 'tsc -p tsconfig.json', test: 'vitest run', start: 'node dist/index.js' },
        devDependencies: { typescript: '^5.6.0', vitest: '^2.1.0' },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: 'src/index.ts',
    description: 'Typed entry module.',
    content: `export function greet(name: string): string {
  const cleaned = name.trim() || 'world';
  return \`Hello, \${cleaned}!\`;
}

process.stdout.write(\`\${greet(${js(spec.name)})}\\n\`);
`,
  },
  {
    path: 'tsconfig.json',
    description: 'Strict TypeScript configuration.',
    content: `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  },
];

/** Registry id -> template. Adding a language means adding a line here. */
export const TEMPLATES: Readonly<Record<string, TemplateBuilder>> = {
  html: HTML_TEMPLATE,
  javascript: JAVASCRIPT_TEMPLATE,
  typescript: TYPESCRIPT_TEMPLATE,
  react: REACT_TEMPLATE,
  'node-fastify': NODE_FASTIFY_TEMPLATE,
  python: PYTHON_TEMPLATE,
  go: GO_TEMPLATE,
  dart: FLUTTER_TEMPLATE,
  flutter: FLUTTER_TEMPLATE,
};

export function hasTemplate(id: string): boolean {
  return Object.hasOwn(TEMPLATES, id);
}
