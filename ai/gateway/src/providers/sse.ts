import { GatewayError } from '../errors/index.js';
import type { TransportStreamEvent } from './transport.js';

/**
 * Server-Sent Events parsing shared by the streaming adapters (Step 29).
 *
 * The transport hands over raw bytes; this turns them into `{event, data}`
 * blocks correctly across chunk boundaries, so a frame split mid-JSON does not
 * become a parse failure. Every adapter gets the same buffering rules, and
 * status handling is one callback rather than three copies.
 */

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

export interface SseOptions {
  /** Maps a non-2xx status onto the adapter's normalized error. */
  readonly errorForStatus: (status: number) => GatewayError;
  readonly signal?: AbortSignal;
}

/**
 * Consumes a transport stream and yields SSE frames.
 *
 * Stops cleanly on `[DONE]` (OpenAI's sentinel), on abort, and when the stream
 * ends. A stream that ends without any data is not an error here - the adapter
 * decides whether an empty answer is acceptable.
 */
export async function* readSseEvents(
  events: AsyncIterable<TransportStreamEvent>,
  options: SseOptions,
): AsyncGenerator<SseEvent> {
  let buffer = '';
  let sawHead = false;
  for await (const event of events) {
    if (options.signal?.aborted === true) {
      throw new GatewayError('GATEWAY_ABORTED', 'The request was cancelled.');
    }
    if (event.type === 'head') {
      sawHead = true;
      if (event.status < 200 || event.status >= 300) {
        throw options.errorForStatus(event.status);
      }
      continue;
    }
    buffer += event.text;
    let boundary = findBoundary(buffer);
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary.start);
      buffer = buffer.slice(boundary.end);
      const frame = parseBlock(block);
      if (frame !== null) {
        if (frame.data === '[DONE]') return;
        yield frame;
      }
      boundary = findBoundary(buffer);
    }
  }
  if (!sawHead) {
    throw new GatewayError('GATEWAY_PROVIDER_ERROR', 'The provider stream never started.');
  }
  const trailing = parseBlock(buffer);
  if (trailing !== null && trailing.data !== '[DONE]') yield trailing;
}

function findBoundary(buffer: string): { readonly start: number; readonly end: number } | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { start: crlf, end: crlf + 4 };
  return { start: lf, end: lf + 2 };
}

function parseBlock(block: string): SseEvent | null {
  const dataLines: string[] = [];
  let eventName: string | null = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join('\n') };
}

export function parseJsonFrame(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
