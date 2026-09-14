export class ProxyError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
  toJSON() {
    return { error: { message: this.message, type: this.status < 500 ? 'invalid_request_error' : 'server_error', param: this.param, code: this.code } };
  }
}
export const invalid = (message, param = null) => new ProxyError(400, 'invalid_request', message, param);
export const contractError = (message) => new ProxyError(502, 'tool_contract_error', message);
export function publicError(error) {
  if (error instanceof ProxyError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new ProxyError(504, 'request_aborted', 'The request was cancelled or timed out. No automatic replay was made by this adapter.');
  }
  // Never send raw upstream exceptions: they can contain a credential-bearing URL.
  return new ProxyError(502, 'upstream_error', 'Copilot transport failed. Check the browser session and /health. Raw upstream details are intentionally not exposed.');
}
