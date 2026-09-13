import { readIntEnv } from '@veltravia/config';
import { buildApp } from './server.js';

const port = readIntEnv('API_PORT', 3000);

const app = buildApp();

app
  .listen({ port, host: '0.0.0.0' })
  .then((address) => {
    console.log(`Veltravia AI API listening at ${address}`);
  })
  .catch((error) => {
    console.error('Failed to start Veltravia AI API:', error);
    process.exit(1);
  });
