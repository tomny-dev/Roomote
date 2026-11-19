import { requestRemoteMcpToolCatalog } from './remote-mcp-tool-catalog';

function jsonRpcResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

const handshakeError = (
  _response: Response,
  responseBody: string,
  step: 'initialize' | 'initialize MCP session',
) => new Error(`Failed to ${step}: ${responseBody}`);

describe('requestRemoteMcpToolCatalog', () => {
  it('loads a stateless server directly without a handshake', async () => {
    const postJsonRpc = vi.fn(async () =>
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'one' }] },
      }),
    );

    const pages = await requestRemoteMcpToolCatalog({
      postJsonRpc,
      onHandshakeError: handshakeError,
    });

    expect(pages).toHaveLength(1);
    expect(postJsonRpc).toHaveBeenCalledTimes(1);
    expect(postJsonRpc.mock.calls[0]?.[0]).toMatchObject({
      method: 'tools/list',
    });
  });

  it('initializes Jira when the server rejects an uninitialized tools/list request', async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];

    const postJsonRpc = vi.fn(
      async (
        body: Record<string, unknown>,
        headers: Record<string, string> = {},
      ): Promise<Response> => {
        requests.push({ body, headers });
        if (requests.length === 1) {
          return new Response(
            'Request must be an initialize request if no session ID is provided.',
            { status: 400 },
          );
        }
        if (body.method === 'initialize') {
          return jsonRpcResponse(
            {
              jsonrpc: '2.0',
              id: 1,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                serverInfo: { name: 'jira', version: '1' },
              },
            },
            200,
            { 'mcp-session-id': 'jira-session' },
          );
        }
        if (body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        return jsonRpcResponse({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'getJiraIssue' }] },
        });
      },
    );

    const pages = await requestRemoteMcpToolCatalog({
      postJsonRpc,
      onHandshakeError: handshakeError,
    });

    expect(pages).toHaveLength(1);
    expect(requests.map(({ body }) => body.method)).toEqual([
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(requests[2]?.headers).toMatchObject({
      'mcp-session-id': 'jira-session',
      'mcp-protocol-version': '2025-03-26',
    });
    expect(requests[3]?.headers).toMatchObject({
      'mcp-session-id': 'jira-session',
      'mcp-protocol-version': '2025-03-26',
    });
  });

  it('handles initialization errors returned as JSON-RPC with HTTP 200', async () => {
    const methods: unknown[] = [];
    const postJsonRpc = vi.fn(async (body: Record<string, unknown>) => {
      methods.push(body.method);
      if (methods.length === 1) {
        return jsonRpcResponse({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32000, message: 'Session not initialized' },
        });
      }
      if (body.method === 'initialize') {
        return jsonRpcResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-06-18' },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      return jsonRpcResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'getJiraIssue' }] },
      });
    });

    const pages = await requestRemoteMcpToolCatalog({
      postJsonRpc,
      onHandshakeError: handshakeError,
    });

    expect(pages).toHaveLength(1);
    expect(methods).toEqual([
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('follows cursor pagination without dropping the MCP session', async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const postJsonRpc = vi.fn(
      async (
        body: Record<string, unknown>,
        headers: Record<string, string> = {},
      ): Promise<Response> => {
        requests.push({ body, headers });
        if (body.method === 'initialize') {
          return jsonRpcResponse(
            {
              jsonrpc: '2.0',
              id: 1,
              result: { protocolVersion: '2025-06-18' },
            },
            200,
            { 'mcp-session-id': 'session-one' },
          );
        }
        if (body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (!headers['mcp-session-id']) {
          return new Response('Mcp-Session-Id is required', { status: 400 });
        }
        return jsonRpcResponse({
          jsonrpc: '2.0',
          id: 2,
          result:
            requests.length === 4
              ? { tools: [{ name: 'first' }], nextCursor: 'page-two' }
              : { tools: [{ name: 'second' }] },
        });
      },
    );

    const pages = await requestRemoteMcpToolCatalog({
      postJsonRpc,
      onHandshakeError: handshakeError,
    });

    expect(pages).toHaveLength(2);
    expect(requests[4]?.body).toMatchObject({
      method: 'tools/list',
      params: { cursor: 'page-two' },
    });
    expect(requests[4]?.headers['mcp-session-id']).toBe('session-one');
  });

  it('does not try to initialize on an authorization failure', async () => {
    const postJsonRpc = vi.fn(async () =>
      jsonRpcResponse({ error: { message: 'invalid_token' } }, 401),
    );

    const pages = await requestRemoteMcpToolCatalog({
      postJsonRpc,
      onHandshakeError: handshakeError,
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.response.status).toBe(401);
    expect(postJsonRpc).toHaveBeenCalledTimes(1);
  });

  it('surfaces initialize failures without attempting tools/list again', async () => {
    const postJsonRpc = vi.fn(async (body: Record<string, unknown>) =>
      body.method === 'initialize'
        ? jsonRpcResponse(
            { error: { message: 'invalid handshake' } },
            400,
          )
        : new Response('Must be an initialize request', { status: 400 }),
    );

    await expect(
      requestRemoteMcpToolCatalog({
        postJsonRpc,
        onHandshakeError: handshakeError,
      }),
    ).rejects.toThrow('Failed to initialize');
    expect(postJsonRpc).toHaveBeenCalledTimes(2);
  });
});
