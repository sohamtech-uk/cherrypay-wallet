// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { ApiReference } from './ApiReference';

const document = {
  openapi: '3.1.0',
  info: { title: 'Cherry Pay Wallet API', version: '0.1.0' },
  paths: {
    '/api/v1/network': { get: { summary: 'Check selected Stellar network', security: [] } },
    '/api/v1/wallets/{walletId}/attempts': {
      post: { summary: 'Create payment attempt', security: [{ WalletSession: [] }], description: 'Requires a durable idempotency key.' }
    },
    '/api/v1/wallets/{walletId}/invoices': {
      get: { summary: 'List invoices', security: [{ WalletSession: [] }] }
    },
    '/api/v1/payment-requests/{requestId}': {
      get: { summary: 'Read checkout terms', security: [] }
    },
  },
};
function stub(available = true) {
  const fetcher = vi.fn(async (url: string) =>
    url === '/health'
      ? new Response(JSON.stringify({ status: 'ok', network: 'TESTNET', walletDeploymentEnabled: true, walletPaymentsEnabled: false }), { status: 200 })
      : url === '/api/v1/openapi.json'
        ? new Response(JSON.stringify(document), { status: available ? 200 : 503 })
        : new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('renders the public reference without wallet authentication and distinguishes runtime from route availability', async () => {
  const fetcher = stub();
  render(<MemoryRouter initialEntries={['/developers']}><App/></MemoryRouter>);
  expect(await screen.findByRole('heading', {name: 'Cherry Wallet API'})).toBeTruthy();
  expect(screen.queryByRole('heading', {name: 'Welcome to Cherry Wallet'})).toBeNull();
  expect(await screen.findByText('Create payment attempt')).toBeTruthy();
  expect(screen.getByText('Not enabled')).toBeTruthy();
  expect(screen.getByLabelText('API base URL')).toHaveProperty('value', window.location.origin + '/api/v1');
  expect(screen.getByLabelText('OpenAPI 3.1 JSON')).toHaveProperty('value', window.location.origin + '/api/v1/openapi.json');
  expect(fetcher.mock.calls.some(([url]) => url === '/api/v1/openapi.json')).toBe(true);
  expect(screen.getByRole('link', {name: 'API reference'}).getAttribute('href')).toBe('/developers');
});

it('searches the generated endpoint catalog and filters business endpoints without triggering mutations', async () => {
  const fetcher = stub();
  const user = userEvent.setup();
  render(<MemoryRouter><ApiReference/></MemoryRouter>);
  expect(await screen.findByText('List invoices')).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('Category'), 'Invoices & checkout');
  expect(screen.queryByText('Create payment attempt')).toBeNull();
  expect(screen.getByText('List invoices')).toBeTruthy();
  await user.type(screen.getByLabelText('Search endpoints'), 'checkout');
  expect(screen.getByText('Read checkout terms')).toBeTruthy();
  expect(screen.queryByText('List invoices')).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/attempts'))).toHaveLength(0);
});

it('handles a missing or older backend without claiming to expose current endpoint data', async () => {
  stub(false);
  render(<MemoryRouter><ApiReference/></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Deploy the matching wallet API'));
  expect(screen.queryByText('Create payment attempt')).toBeNull();
});
