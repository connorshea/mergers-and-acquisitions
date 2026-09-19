// Small typed fetch wrapper that preserves the call signature of Void's
// `void/client` fetch, so the pages that used it (CandidatesList, CandidateDetail)
// only had to swap their import. Supports `:param` path placeholders, a query
// object, an optional JSON body, and throws `FetchError` (with `.status`) on a
// non-2xx response instead of returning it.

export class FetchError extends Error {
  status: number;
  /** The server's machine-readable `code`, when its JSON error body had one. */
  code?: string;
  constructor(status: number, message?: string, code?: string) {
    super(message ?? `Request failed (${status})`);
    this.name = "FetchError";
    this.status = status;
    this.code = code;
  }
}

export interface FetchOptions {
  /** Query-string params, appended as ?a=b. */
  query?: Record<string, string>;
  /** HTTP method; defaults to GET. */
  method?: string;
  /** Values for `:name` placeholders in the path. */
  params?: Record<string, string>;
  /** JSON request body; sets Content-Type and serializes. */
  body?: unknown;
}

/**
 * Fetch a same-origin API route. Resolves `:name` placeholders from `params`,
 * appends `query`, parses the JSON response, and throws `FetchError` on non-2xx.
 * Callers cast the returned `unknown` to the route's response type.
 */
export async function fetch(path: string, opts: FetchOptions = {}): Promise<unknown> {
  let url = path;
  if (opts.params) {
    for (const [key, value] of Object.entries(opts.params)) {
      url = url.replace(`:${key}`, encodeURIComponent(value));
    }
  }
  if (opts.query) {
    const qs = new URLSearchParams(opts.query).toString();
    if (qs) url += `?${qs}`;
  }

  const hasBody = opts.body !== undefined;
  const res = await globalThis.fetch(url, {
    method: opts.method ?? "GET",
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    // API errors are `{ error, code? }`; carry the message so the UI can show
    // what the server (or Wikidata, verbatim) said rather than just a status.
    let message: string | undefined;
    let code: string | undefined;
    try {
      const body = JSON.parse(text) as { error?: unknown; code?: unknown };
      if (typeof body.error === "string") message = body.error;
      if (typeof body.code === "string") code = body.code;
    } catch {
      // not JSON
    }
    throw new FetchError(res.status, message, code);
  }
  return text ? (JSON.parse(text) as unknown) : undefined;
}
