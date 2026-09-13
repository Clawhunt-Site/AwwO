// Deliberately hang after a terminal IPC event to exercise parent teardown.
process.once('message', () => {
  process.send({ type: 'text_delta', delta: 'Fixture response' });
  process.send({ type: 'completed', text: 'Fixture response' });
  setInterval(() => {}, 1000);
});
