// Test-only child: reports the shape of the model configuration it received over IPC,
// never the secret values, so a test can prove what a Bedrock run hands its child.
process.on('message', message => {
  if (message?.type !== 'run') return;
  const config = message.modelConfig;
  const auth = config.bedrockAuth;
  const summary = {
    provider: config.provider, model: config.model, region: config.region, baseURL: config.baseURL, protocol: config.protocol,
    apiKey: config.apiKey, authKinds: auth ? Object.keys(auth) : [],
    credentialFields: auth?.credentials ? Object.keys(auth.credentials).sort() : [],
    ...(config.promptCache !== undefined ? { promptCache: config.promptCache } : {}),
    ...(config.fallbackModel !== undefined ? { fallbackModel: config.fallbackModel } : {}),
  };
  // A model with a second profile reports a fallback to it, as the bridge would, for the parent's log.
  if (config.fallbackModel) process.send({ type: 'bedrock_fact', fact: { event: 'fallback', from: config.model, to: config.fallbackModel, after: 'ServiceUnavailableException' } });
  process.send({ type: 'completed', text: JSON.stringify(summary) }, () => process.disconnect());
});
