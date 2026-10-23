import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, readToken } from '../src/api/client.ts';

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

describe('readToken', () => {
  it('reads ?token=, stores it and strips it from the address bar', () => {
    history.replaceState(null, '', '/board?token=abc123&x=1#top');
    expect(readToken()).toBe('abc123');
    expect(sessionStorage.getItem('agent-kanban.token')).toBe('abc123');
    expect(location.search).toBe('?x=1');
    expect(location.pathname).toBe('/board');
    expect(location.hash).toBe('#top');
    expect(location.href).not.toContain('abc123');
  });

  it('falls back to sessionStorage', () => {
    sessionStorage.setItem('agent-kanban.token', 'stored');
    expect(readToken()).toBe('stored');
  });

  it('returns null with no token anywhere', () => {
    expect(readToken()).toBeNull();
  });
});

describe('api', () => {
  function mockFetch(res: Response) {
    const f = vi.fn().mockImplementation(async () => res.clone());
    vi.stubGlobal('fetch', f);
    return f;
  }

  it('sends the bearer header and parses JSON', async () => {
    sessionStorage.setItem('agent-kanban.token', 'tok');
    const f = mockFetch(Response.json([{ id: 'c1' }]));
    expect(await api.listChats()).toEqual([{ id: 'c1' }]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/chats');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('archive can be sent with keepalive, still with the bearer header and no token in the URL', async () => {
    sessionStorage.setItem('agent-kanban.token', 'tok');
    const f = mockFetch(Response.json({ id: 'c1' }));
    await api.archive('c1', { keepalive: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/chats/c1/archive');
    expect(init.keepalive).toBe(true);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
    await api.archive('c1');
    expect(f.mock.calls[1]![1].keepalive).toBeUndefined();
  });

  it('posts JSON bodies', async () => {
    sessionStorage.setItem('agent-kanban.token', 'tok');
    const f = mockFetch(Response.json({ id: 'c1' }, { status: 201 }));
    await api.startChat({ provider: 'claude', cwd: '/p', prompt: 'hi' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/chats');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ provider: 'claude', cwd: '/p', prompt: 'hi' });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('handles 204 with no body', async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(api.send('c1', 'hello')).resolves.toBeUndefined();
  });

  it('throws ApiError with the server error text and status', async () => {
    mockFetch(Response.json({ error: 'That folder does not exist.' }, { status: 400 }));
    const err = await api.startChat({ provider: 'claude', cwd: '/x', prompt: 'p' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('That folder does not exist.');
    expect(err.status).toBe(400);
  });

  it('falls back to a plain message when the body is not JSON', async () => {
    mockFetch(new Response('boom', { status: 502 }));
    const err = await api.listChats().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBeTruthy();
  });

  it('encodes ids and query values', async () => {
    const f = mockFetch(Response.json({}));
    await api.projectInfo('/a b/c');
    expect(f.mock.calls[0]![0]).toBe('/api/projects/info?path=%2Fa%20b%2Fc');
    await api.checkConnections('codex');
    expect(JSON.parse(f.mock.calls[1]![1].body)).toEqual({ provider: 'codex' });
  });
});
