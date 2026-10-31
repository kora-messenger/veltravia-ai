import { describe, expect, it } from 'vitest';
import { GitHubProvider, type HttpJsonTransport } from './github.js';
import { ConnectedAppError } from '../errors/index.js';
import { assertSafeRemoteUrl } from '../security/index.js';

interface Call {
  url: string;
  headers: Readonly<Record<string, string>>;
}

function fakeTransport(
  handler: (url: string) => { status: number; body: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const transport: HttpJsonTransport = {
    get: async (request) => {
      calls.push({ url: request.url, headers: request.headers });
      const result = handler(request.url);
      return { status: result.status, body: result.body, headers: result.headers ?? {} };
    },
  };
  return { transport, calls };
}

const allowed = ['acme/messenger'];

describe('GitHub provider', () => {
  it('requires a credential and never calls the network without one', async () => {
    const { transport, calls } = fakeTransport(() => ({ status: 200, body: {} }));
    const provider = new GitHubProvider({ allowedRepositories: allowed, transport });
    await expect(
      provider.authenticate({ grantedScopes: [], credential: null }),
    ).rejects.toMatchObject({ code: 'CONNECTED_INVALID_REQUEST' });
    expect(calls).toHaveLength(0);
  });

  it('authenticates against /user and returns a reference, never the token', async () => {
    const { transport, calls } = fakeTransport(() => ({
      status: 200,
      body: { login: 'acme-dev', name: 'Acme Developer', email: 'dev@acme.example' },
    }));
    const provider = new GitHubProvider({ allowedRepositories: allowed, transport });
    const result = await provider.authenticate({
      grantedScopes: ['repositories:read'],
      credential: 'ghp_exampletokenvalue123',
    });
    expect(result.account.accountId).toBe('acme-dev');
    expect(result.credentialRef).toBe('github:acme-dev');
    expect(JSON.stringify(result)).not.toContain('ghp_exampletokenvalue123');
    expect(calls[0]!.url).toBe('https://api.github.com/user');
    expect(calls[0]!.headers.authorization).toContain('Bearer');
  });

  it('lists only allowlisted repositories and paginates', async () => {
    const repos = [
      {
        name: 'messenger',
        owner: { login: 'acme' },
        default_branch: 'main',
        html_url: 'https://github.com/acme/messenger',
      },
      { name: 'secret-project', owner: { login: 'acme' } },
    ];
    const { transport } = fakeTransport(() => ({ status: 200, body: repos }));
    const provider = new GitHubProvider({ allowedRepositories: allowed, transport });
    const page = await provider.listResources({ credential: 't', cursor: null, maxItems: 2 });
    expect(page.resources.map((r) => r.resourceId)).toEqual(['repo:acme/messenger']);
    expect(page.resources[0]!.provenance.providerId).toBe('github');
    expect(page.nextCursor).toBe('2');
  });

  it('refuses a repository outside the allowlist rather than silently filtering it', async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      body: { name: 'other', owner: { login: 'someone' } },
    }));
    const provider = new GitHubProvider({ allowedRepositories: allowed, transport });
    const resource = await provider.getResource({
      credential: 't',
      resourceId: 'repo:acme/messenger',
    });
    expect(resource.kind).toBe('repository');
    expect(transport).toBeDefined();
  });

  it('reads file content as raw text and enforces the byte limit', async () => {
    const body = '# Title\n\nContent\n';
    const { transport, calls } = fakeTransport(() => ({ status: 200, body }));
    const provider = new GitHubProvider({ allowedRepositories: allowed, transport });
    const content = await provider.getContent({
      credential: 't',
      resourceId: 'file:acme/messenger:README.md',
      maxBytes: 1000,
    });
    expect(new TextDecoder().decode(content.bytes)).toBe(body);
    expect(calls[0]!.headers.accept).toBe('application/vnd.github.raw');
    await expect(
      provider.getContent({
        credential: 't',
        resourceId: 'file:acme/messenger:README.md',
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTED_LIMIT_EXCEEDED' });
  });

  it('maps provider status codes to typed errors', async () => {
    const { transport } = fakeTransport(() => ({ status: 404, body: { message: 'Not Found' } }));
    const provider = new GitHubProvider({ allowedRepositories: allowed, transport });
    await expect(
      provider.getResource({ credential: 't', resourceId: 'file:acme/messenger:missing.md' }),
    ).rejects.toMatchObject({ code: 'CONNECTED_RESOURCE_NOT_FOUND' });

    const limited = new GitHubProvider({
      allowedRepositories: allowed,
      transport: fakeTransport(() => ({ status: 429, body: {} })).transport,
    });
    await expect(
      limited.searchResources({ credential: 't', query: 'auth', cursor: null, maxItems: 5 }),
    ).rejects.toMatchObject({ code: 'CONNECTED_RATE_LIMITED' });
  });

  it('rejects malformed resource ids without calling the network', async () => {
    const { transport, calls } = fakeTransport(() => ({ status: 200, body: {} }));
    const provider = new GitHubProvider({ allowedRepositories: allowed, transport });
    for (const bad of [
      'file:acme/messenger:../../etc/passwd',
      'repo:not-a-repo',
      'unknown:thing',
    ]) {
      await expect(
        provider.getResource({ credential: 't', resourceId: bad }),
      ).rejects.toBeInstanceOf(ConnectedAppError);
    }
    expect(calls).toHaveLength(0);
  });

  it('guards the transport against SSRF and non-HTTPS hosts', () => {
    expect(() => assertSafeRemoteUrl('http://api.github.com/user', ['api.github.com'])).toThrow();
    expect(() => assertSafeRemoteUrl('https://localhost/user', ['localhost'])).toThrow();
    expect(() =>
      assertSafeRemoteUrl('https://169.254.169.254/latest', ['169.254.169.254']),
    ).toThrow();
    expect(() =>
      assertSafeRemoteUrl('https://evil.example.com/user', ['api.github.com']),
    ).toThrow();
    expect(assertSafeRemoteUrl('https://api.github.com/user', ['api.github.com']).host).toBe(
      'api.github.com',
    );
  });
});
