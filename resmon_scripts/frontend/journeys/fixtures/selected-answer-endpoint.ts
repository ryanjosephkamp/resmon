/**
 * An authored model on loopback that answers a selected-evidence request.
 *
 * J36 and J37 need an answer the app has validated and saved, and nothing in
 * this suite may reach a real model. `provider-endpoint.ts` answers every
 * completion with one fixed sentence, which is right for J14 and wrong here:
 * the selected-evidence lane requires one strict JSON object whose citations
 * name the request's own source IDs and quote their exact codepoint ranges,
 * and those IDs and ranges only exist once the app has assembled the request.
 * So this one reads the request it is sent and answers from it, the way
 * `selectedEvidenceTransport` in `e2e/fixtures/resmon-app.ts` does for the
 * e2e spec — the same wire shape, rebuilt here because a journey launch cannot
 * swap the backend's interpreter for that fixture's wrapper.
 *
 * What it replaces is the model, and nothing else. The request is a real HTTP
 * request made by the shipped `ApiKeyRuntime` over a real socket, with the key
 * the app read out of its own credential store; the validation of the reply,
 * the saved row and everything the Evidence page draws are the app's.
 *
 * **It can be told to lie, and that is the point of it.** An authored model
 * that only ever cites what it was sent would make "the answer cites only the
 * selected evidence" true by construction, and a journey asserting it would be
 * measuring this file. `citeTextItWasNotSent` makes it do what a careless model
 * does: attribute to a selected source a sentence that is not in it. Whether
 * that reaches a person as a cited answer is then the app's decision, and that
 * decision is what J36 asserts.
 *
 * **Every request is recorded.** "Only the selected evidence left the machine"
 * is a claim about what a provider received, and only something that wrote down
 * what it received can be asked.
 */
import * as http from 'http';
import * as net from 'net';

/** One selected source, as the app's user prompt carries it — only the fields this reads. */
export interface PromptSource {
  source_id: string;
  /** Where the excerpt begins on its page, in codepoints. */
  start_codepoint: number;
  text: string;
}

/** The app's user prompt, `{request_sha256, payload}` — only the fields this suite reads. */
export interface SelectedPrompt {
  request_sha256: string;
  payload: { mode: string; sources: PromptSource[]; notes: { body: string }[] };
}

/** `JSON.parse`, or null where the text is not JSON. */
function parsed<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** One request the app made of the authored model. */
export interface SelectedAnswerCall {
  path: string;
  /** The `Authorization` header, verbatim, or null. */
  authorization: string | null;
  model: string;
  /** The raw body, exactly as it arrived, for a search no parse could hide from. */
  raw: string;
  /** `messages[1].content` parsed: the app's user prompt, or null where it was not JSON. */
  userPayload: SelectedPrompt | null;
}

export interface SelectedAnswerEndpoint {
  /** What `ai_custom_base_url` is set to. */
  readonly url: string;
  calls(): SelectedAnswerCall[];
  /**
   * Answer from now on by attributing this sentence to the first source it is
   * sent. Until this is called it cites the first codepoints of each source.
   */
  citeTextItWasNotSent(quote: string): void;
  close(): Promise<void>;
}

/** The first `count` codepoints of a string — the unit the contract counts in. */
function firstCodepoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join('');
}

export async function startSelectedAnswerEndpoint(): Promise<SelectedAnswerEndpoint> {
  const calls: SelectedAnswerCall[] = [];
  const sockets = new Set<net.Socket>();
  let lie: string | null = null;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = parsed<{ model?: string; messages?: { content?: string }[] }>(raw) ?? {};
      const userPayload = parsed<SelectedPrompt>(String(body.messages?.[1]?.content ?? ''));
      calls.push({
        path: String(request.url ?? ''),
        authorization: (request.headers.authorization as string) ?? null,
        model: String(body.model ?? ''),
        raw,
        userPayload,
      });

      const sources: PromptSource[] = Array.isArray(userPayload?.payload?.sources) ? userPayload!.payload.sources : [];
      // Codepoint offsets, as the contract counts them: a source's own
      // `start_codepoint` is where its excerpt begins on the page, and a
      // citation's range is on the page too.
      const cite = (source: PromptSource) => {
        const quote = firstCodepoints(String(source.text ?? ''), 12);
        const start = Number(source.start_codepoint ?? 0);
        return {
          source_id: source.source_id,
          start_codepoint: start,
          end_codepoint: start + Array.from(quote).length,
          quote,
        };
      };
      const items = lie === null
        ? sources.slice(0, 3).map((source) => ({
          kind: 'source_statement',
          text: `The selected excerpt ${source.source_id} opens with the cited words.`,
          citations: [cite(source)],
          note_ids: [] as string[],
        }))
        : [{
          kind: 'source_statement',
          text: 'An authored claim attributed to a source that does not contain it.',
          citations: sources.length ? [{
            source_id: sources[0].source_id,
            start_codepoint: Number(sources[0].start_codepoint ?? 0),
            end_codepoint: Number(sources[0].start_codepoint ?? 0) + Array.from(lie).length,
            quote: lie,
          }] : [],
          note_ids: [] as string[],
        }];
      const result = {
        version: 1,
        request_sha256: userPayload?.request_sha256 ?? '',
        mode: userPayload?.payload?.mode ?? 'question',
        status: 'answer',
        sections: [{ kind: 'summary', items }],
        limitations: ['An authored model on loopback answered this; no real model was called.'],
      };
      const reply = JSON.stringify({
        id: 'authored-selected-completion',
        object: 'chat.completion',
        model: 'authored-selected-model',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 12 },
      });
      // A length, not a chunked body: the lane refuses compression and bounds
      // what it reads, and a declared length is the plainest thing to bound.
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(reply),
      });
      response.end(reply);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as net.AddressInfo;
  if (address.port === 8742) throw new Error('the authored model was given the live daemon port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => [...calls],
    citeTextItWasNotSent: (quote: string) => { lie = quote; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    },
  };
}
