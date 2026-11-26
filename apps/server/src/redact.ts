// Masks secrets in the process output.
//
// The SDK's RPC library prints the full URL (with the Blockfrost project_id)
// in its messages, and an error holding a `URL` object prints it inside
// `URLSearchParams { 'project_id' => '…' }`. Rather than guessing formats, the
// literal secret value (and its URL-encoded form) is replaced in everything
// written to stdout and stderr.

const MIN_SECRET_LENGTH = 8;

export function makeRedactor(secrets: string[]): (text: string) => string {
  const needles = [...new Set(secrets.flatMap((s) => [s, encodeURIComponent(s)]))]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return (text) => needles.reduce((t, n) => t.split(n).join('***'), text);
}

type Writable = { write: (...args: never[]) => boolean };

/** Wraps `write` on stdout and stderr to mask the secrets. Idempotent per stream. */
export function installOutputRedaction(secrets: string[], streams: Writable[] = [process.stdout, process.stderr]): void {
  const redact = makeRedactor(secrets);
  for (const stream of streams) {
    const original = (stream.write as (...args: unknown[]) => boolean).bind(stream);
    (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') return original(redact(chunk), ...rest);
      if (chunk instanceof Uint8Array) return original(redact(Buffer.from(chunk).toString('utf8')), ...rest);
      return original(chunk, ...rest);
    };
  }
}
