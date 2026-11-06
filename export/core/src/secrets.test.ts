import { describe, expect, it } from 'vitest';
import { scanForSecrets } from './secrets.js';

// Built at runtime so no real-looking credential sits in the repository.
const fake = {
  github: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3',
  openai: 'sk-' + 'proj-' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2',
  groq: 'gsk_' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn',
  openrouter: 'sk-or-' + 'v1-abcdef0123456789abcdef',
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  stripe: 'sk_' + 'live_' + '51Habcdefghij1234567890',
  google: 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  slack: 'xoxb-' + '123456789012-abcdefABCDEF',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36P',
};

describe('scanForSecrets: things that must be caught', () => {
  it.each([
    ['GitHub token', `const t = "${fake.github}";`],
    ['OpenAI-style key', `OPENAI=${fake.openai}`],
    ['Groq key', `headers: { key: '${fake.groq}' }`],
    ['OpenRouter key', `key = "${fake.openrouter}"`],
    ['AWS access key id', `aws_access_key_id = ${fake.aws}`],
    ['Stripe key', `stripe.setKey('${fake.stripe}')`],
    ['Google API key', `apiKey: "${fake.google}"`],
    ['Slack token', `SLACK=${fake.slack}`],
    ['JSON web token', `const jwt = "${fake.jwt}"`],
    [
      'private key block',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
    ],
    ['password in a URL', 'DATABASE_URL=postgres://app:hunter2pass@db.internal:5432/app'],
    ['bearer token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('finds a %s in the middle of a multi-line file', (kind, line) => {
    const file = `import x from 'y';\n\nfunction f() {\n  ${line}\n  return 1;\n}\n`;
    expect(scanForSecrets(file)?.kind).toBe(kind);
  });

  it('finds a long literal assigned to a secret-looking name', () => {
    expect(scanForSecrets('const client_secret = "k7Hq92LmXz04PaVbN3rT81wQd";')?.kind).toBe(
      'secret-looking assignment',
    );
    expect(scanForSecrets('API_KEY=Zq81LmXz04PaVbN3rTh7Hq92wQd')?.kind).toBe(
      'secret-looking assignment',
    );
  });

  it('never returns the matched text, only a fixed label', () => {
    const finding = scanForSecrets(`token = "${fake.github}"`);
    expect(JSON.stringify(finding)).not.toContain('ghp_');
    expect(JSON.stringify(finding)).not.toContain(fake.github.slice(4, 14));
  });
});

describe('scanForSecrets: ordinary code must not be flagged', () => {
  it.each([
    ['an env lookup', 'const key = process.env.OPENAI_API_KEY;'],
    ['a python env lookup', 'api_key = os.environ["OPENAI_API_KEY"]'],
    ['a placeholder', 'API_KEY=your_api_key_here'],
    ['a template', 'password: ${DB_PASSWORD}'],
    ['an empty value', 'SECRET='],
    ['a type annotation', 'interface Props { apiKey: string; token: string }'],
    ['a short value', 'password = "abc"'],
    ['a function call', 'const token = await getToken(user)'],
    ['a field name in prose', '// the access token expires after an hour'],
    ['a config reference', 'token: config.auth.token'],
    ['a hash-looking build id', 'const buildId = "3f2a9c1d8b7e";'],
    ['a plain import', "import { createToken } from './tokens';"],
    ['markdown', '# Setup\n\nSet your API key in the settings screen.\n'],
  ])('does not flag %s', (_name, text) => {
    expect(scanForSecrets(text)).toBeNull();
  });

  it('stays fast on a very long single line', () => {
    const started = Date.now();
    scanForSecrets('a'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
