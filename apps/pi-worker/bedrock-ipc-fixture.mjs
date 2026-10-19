// Test-only child: reports the Bedrock settings of the model configuration it received over IPC,
// never the secret values, so a test can prove what a Bedrock run hands its child.
process.on('message', message => {
  if (message?.type !== 'run') return;
  const config = message.modelConfig;
  const summary = {
    provider: config.provider, model: config.model, region: config.region, apiKey: config.apiKey,
    thinkingBudget: config.thinkingBudget ?? null, promptCache: config.promptCache ?? null, fallbackModel: config.fallbackModel ?? null,
  };
  // A model with a second profile reports a fallback to it, as the bridge would, for the parent's log.
  if (config.fallbackModel) process.send({ type: 'bedrock_fact', fact: { event: 'fallback', from: config.model, to: config.fallbackModel, after: 'ThrottlingException' } });
  process.send({ type: 'completed', text: JSON.stringify(summary) }, () => process.disconnect());
});
