// Guards stdout. Must be the first import of index.ts.
//
// stdout belongs to the JSON-RPC protocol. Anything a dependency writes to it
// (the SDK's console.log, WASM modules...) is diverted to stderr so it does
// not mix with the replies.

const realWrite = process.stdout.write.bind(process.stdout);

/** The only way to write to stdout: used only by the JSON-RPC server. */
export const protocolOut = {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    return realWrite(chunk, cb);
  },
};

process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) =>
  (process.stderr.write as (...args: unknown[]) => boolean)(chunk, encoding, cb)) as typeof process.stdout.write;
