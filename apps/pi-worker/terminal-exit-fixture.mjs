// Test-only supervisor fixture. Production always forks pi-task.mjs.
// Send a valid result, then deliberately never exit: terminal delivery must wait
// for the supervisor to stop this child and release the isolated session.
process.once('message', () => {
  process.send({ type: 'text_delta', delta: 'Fixture response' });
  process.send({ type: 'completed', text: 'Fixture response' });
  setInterval(() => {}, 1000);
});
