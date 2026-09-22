/**
 * An authored model provider on loopback, for the row where the assistant runs
 * on a key of the person's own rather than on a CLI they signed into.
 *
 * What this replaces is the model, and nothing else. The request is a real HTTP
 * request made by the shipped `ApiKeyRuntime` over a real socket; the settings
 * that point at it are written through the app's own settings API; the
 * credential is read out of the app's own credential store by the app's own
 * code at the moment it builds the request. Everything downstream of the reply
 * — the stream the panel renders, the conversation SQLite keeps — is the app's.
 *
 * It speaks the **openai** family, because that is the family the catalog gives
 * the `custom` provider and `custom` is the only provider whose base URL the
 * app lets a person set. The shape is exactly what `assistant_api_runtime`
 * reads: `choices[0].message.content` and `usage`.
 *
 * **Every request is recorded, headers included.** The row's real question is
 * not whether an answer came back; it is whether the key went where it was
 * supposed to go and nowhere else. A journey can only ask that of something
 * that wrote down what it received.
 */
import * as http from 'http';

/** One request the app made of the provider. */
export interface ProviderCall {
  path: string;
  /** The `Authorization` header, verbatim, or null where there was none. */
  authorization: string | null;
  /** The model the app asked for. */
  model: string;
  /** Every header name the request carried, lower-cased. */
  headerNames: string[];
  /** The body, parsed. */
  body: Record<string, any>;
}

export interface ProviderEndpoint {
  /** What `ai_custom_base_url` is set to. */
  readonly url: string;
  /** Every call the app has made, in order. */
  calls(): ProviderCall[];
  close(): Promise<void>;
}

/**
 * Start it, and answer every completion with this sentence.
 *
 * Bound to `127.0.0.1` on a port the operating system chooses: the launch
 * guard refuses anything that is not loopback, and a fixed port would one day
 * be somebody's real service.
 */
export async function startProviderEndpoint(answer: string): Promise<ProviderEndpoint> {
  const calls: ProviderCall[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: Record<string, any> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
      calls.push({
        path: String(request.url ?? ''),
        authorization: (request.headers.authorization as string) ?? null,
        model: String(body.model ?? ''),
        headerNames: Object.keys(request.headers).map((name) => name.toLowerCase()),
        body,
      });
      const reply = {
        id: 'authored-completion',
        object: 'chat.completion',
        model: body.model ?? 'authored-model',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the authored provider did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => [...calls],
    // Closed through the session's own teardown list: a server nobody closed
    // keeps the worker's event loop alive after the last case, which this suite
    // has already paid for once.
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}
