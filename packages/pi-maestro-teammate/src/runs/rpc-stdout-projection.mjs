// The SDK serializes whole RPC events, including repeated tool-result images.
// Project only telemetry; the model and persisted session retain the originals.
function projectContent(value) {
  if (!value || !Array.isArray(value.content)) return value;
  let changed = false;
  const content = value.content.map((part) => {
    if (part?.type !== "image" || typeof part.data !== "string") return part;
    changed = true;
    return { type: "text", text: `[image omitted from teammate telemetry: ${Buffer.byteLength(part.data)} encoded bytes]` };
  });
  return changed ? { ...value, content } : value;
}

export function projectRpcEvent(event) {
  const projected = { ...event };
  for (const key of ["message", "result", "partialResult"]) {
    if (event[key]) projected[key] = projectContent(event[key]);
  }
  for (const key of ["messages", "toolResults"]) {
    if (Array.isArray(event[key])) projected[key] = event[key].map(projectContent);
  }
  return projected;
}

export function projectRpcWrite(chunk) {
  if (typeof chunk !== "string" || !chunk.endsWith("\n") || !chunk.includes('"image"')) return chunk;
  // RPC writes one complete JSONL event per write. Preserve malformed writes
  // verbatim so the parent remains the protocol-failure authority.
  let event;
  try {
    event = JSON.parse(chunk);
  } catch (error) {
    if (error instanceof SyntaxError) return chunk;
    throw error;
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") return chunk;
  return `${JSON.stringify(projectRpcEvent(event))}\n`;
}

export function installRpcStdoutProjection(stream) {
  const originalWrite = stream.write;
  stream.write = function (chunk, encodingOrCallback, callback) {
    return originalWrite.call(this, projectRpcWrite(chunk), encodingOrCallback, callback);
  };
}

// A child inherits NODE_OPTIONS into tools too; never intercept their stdout.
if (process.env.PI_TEAMMATE_CHILD === "1"
  && process.argv.some((arg, index, args) => arg === "--mode" && args[index + 1] === "rpc")) {
  installRpcStdoutProjection(process.stdout);
}
