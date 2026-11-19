import { parseMcpJsonRpcPayload } from '@roomote/types';

const DEFAULT_MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_TOOL_CATALOG_PAGES = 50;

type JsonRpcRequest = Record<string, unknown>;
type JsonRpcHeaders = Record<string, string>;

export type RemoteMcpCatalogPage = {
  response: Response;
  responseBody: string;
};

type PostJsonRpc = (
  body: JsonRpcRequest,
  headers?: JsonRpcHeaders,
) => Promise<Response>;

type HandshakeStep = 'initialize' | 'initialize MCP session';

type ToolListPayload = {
  error?: { message?: unknown };
  result?: { tools?: unknown; nextCursor?: unknown; protocolVersion?: unknown };
};

function hasInitializationError(page: RemoteMcpCatalogPage): boolean {
  if (page.response.status === 401) {
    return false;
  }

  const payload = parseMcpJsonRpcPayload(
    page.responseBody,
    page.response.headers.get('content-type'),
  ) as ToolListPayload | null;

  // A successful tools/list response does not need a handshake.
  if (page.response.ok && !payload?.error) {
    return false;
  }

  const message =
    typeof payload?.error?.message === 'string'
      ? payload.error.message
      : page.responseBody;

  return /mcp[-\s]?session[-\s]?id|session id|initialize request|not initialized|initialization required|initialize first|must be initialized/i.test(
    message,
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
    (error instanceof Error &&
      error.message.includes('The operation was aborted due to timeout'))
  );
}

/**
 * Query tools on both stateless and session-based MCP servers.
 *
 * Stateless servers can respond directly to tools/list. Stateful servers
 * require initialize -> notifications/initialized before the same request.
 * Keep the negotiated protocol version and session ID for every cursor page.
 */
export async function requestRemoteMcpToolCatalog(options: {
  postJsonRpc: PostJsonRpc;
  protocolVersion?: string;
  onHandshakeError: (
    response: Response,
    responseBody: string,
    step: HandshakeStep,
  ) => Error;
}): Promise<RemoteMcpCatalogPage[]> {
  const { postJsonRpc, onHandshakeError } = options;
  const protocolVersion =
    options.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION;

  const send = async (
    body: JsonRpcRequest,
    headers: JsonRpcHeaders = {},
  ): Promise<RemoteMcpCatalogPage> => {
    const response = await postJsonRpc(body, headers);
    return { response, responseBody: await response.text() };
  };

  const initialize = async (): Promise<JsonRpcHeaders> => {
    const initialized = await send(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'roomote-admin', version: '0.0.0' },
        },
      },
      { 'mcp-protocol-version': protocolVersion },
    );

    if (!initialized.response.ok) {
      throw onHandshakeError(
        initialized.response,
        initialized.responseBody,
        'initialize',
      );
    }

    const payload = parseMcpJsonRpcPayload(
      initialized.responseBody,
      initialized.response.headers.get('content-type'),
    ) as ToolListPayload | null;

    if (payload?.error || !payload?.result) {
      throw onHandshakeError(
        initialized.response,
        initialized.responseBody,
        'initialize',
      );
    }

    const negotiatedVersion =
      typeof payload.result.protocolVersion === 'string'
        ? payload.result.protocolVersion
        : protocolVersion;

    const headers: JsonRpcHeaders = {
      'mcp-protocol-version': negotiatedVersion,
    };
    const sessionId = initialized.response.headers.get('mcp-session-id');
    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
    }

    const acknowledged = await send(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers,
    );
    if (!acknowledged.response.ok) {
      throw onHandshakeError(
        acknowledged.response,
        acknowledged.responseBody,
        'initialize MCP session',
      );
    }

    return headers;
  };

  const pages: RemoteMcpCatalogPage[] = [];
  let sessionHeaders: JsonRpcHeaders | null = null;
  let cursor: string | undefined;
  const cursors = new Set<string>();

  for (let pageIndex = 0; pageIndex < MAX_TOOL_CATALOG_PAGES; pageIndex++) {
    const listRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2 + pageIndex,
      method: 'tools/list',
      ...(cursor ? { params: { cursor } } : {}),
    };

    let page: RemoteMcpCatalogPage;
    try {
      page = await send(listRequest, sessionHeaders ?? {});
    } catch (error) {
      if (sessionHeaders || pages.length > 0 || !isTimeoutError(error)) {
        throw error;
      }
      sessionHeaders = await initialize();
      page = await send(listRequest, sessionHeaders);
    }

    if (!sessionHeaders && hasInitializationError(page)) {
      sessionHeaders = await initialize();
      page = await send(listRequest, sessionHeaders);
    }

    pages.push(page);

    if (!page.response.ok) {
      return pages;
    }

    const payload = parseMcpJsonRpcPayload(
      page.responseBody,
      page.response.headers.get('content-type'),
    ) as ToolListPayload | null;

    if (payload?.error || !Array.isArray(payload?.result?.tools)) {
      return pages;
    }

    const nextCursor = payload.result.nextCursor;
    if (typeof nextCursor !== 'string' || !nextCursor) {
      return pages;
    }
    if (cursors.has(nextCursor)) {
      throw new Error('MCP tools/list returned a repeated pagination cursor.');
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    `MCP tools/list exceeded the ${MAX_TOOL_CATALOG_PAGES}-page safety limit.`,
  );
}
