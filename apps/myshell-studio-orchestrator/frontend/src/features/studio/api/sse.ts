export async function readSse<TEvent>({
  response,
  onEvent,
}: {
  response: Response;
  onEvent: (event: TEvent, rawEventName: string) => void | Promise<void>;
}) {
  if (!response.ok) {
    throw new Error(`Studio ${response.status}: ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error('Studio endpoint did not return a readable stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const dispatch = async () => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const payload = dataLines.join('\n');
    dataLines = [];
    try {
      await onEvent(JSON.parse(payload) as TEvent, eventName);
    } catch {
      await onEvent({ type: eventName, message: payload } as TEvent, eventName);
    }
    eventName = 'message';
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line === '') {
        await dispatch();
      } else if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
  }

  if (buffer.trim()) {
    for (const rawLine of buffer.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
  }
  await dispatch();
}
