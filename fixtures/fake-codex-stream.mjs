#!/usr/bin/env node

process.stdout.write(
  `${JSON.stringify({
    type: 'turn.failed',
    error: { message: 'falha sintética do provider' },
  })}\n`,
);
