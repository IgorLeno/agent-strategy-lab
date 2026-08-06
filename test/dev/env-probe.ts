const result = {
  agentlabNames: Object.keys(process.env)
    .filter((name) => name.startsWith('AGENTLAB_'))
    .sort(),
  devDir: process.env['AGENTLAB_DEV_DIR'] ?? null,
  lang: process.env['LANG'] ?? null,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
