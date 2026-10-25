import { writeFileSync } from 'node:fs';
import { paymentOpenApi } from '../src/payments/openapi.js';
writeFileSync(new URL('../../../docs/payments.openapi.json', import.meta.url), JSON.stringify(paymentOpenApi, null, 2) + '\n');
