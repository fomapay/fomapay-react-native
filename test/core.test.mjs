import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CheckoutController, FomaPay, FomaPayApiError, FomaPayNetworkError, formatAmount, normalizePhone,
} from '../dist/core.mjs';

const PAYMENT = { id: 'pay_1', reference: 'FP-1', status: 'pending', amount: 25, currency: 'USD', paymentModes: ['fomapay_direct', 'mobile_money'] };
const STORE = { id: 's1', name: 'Chez Foma', paymentModes: ['fomapay_direct', 'mobile_money'] };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const failure = (status, code, headers) => json(status, { error: { code, message: 'oups', details: { champ: 'amount' } } }, headers);

/** Client branché sur un faux fetch ; `waits` reçoit les attentes entre deux tentatives. */
function makeClient(handler, options = {}) {
  const calls = [];
  const waits = [];
  const fomapay = new FomaPay({
    publicKey: 'pk_test_unit',
    apiUrl: 'https://api.test/',
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      return handler(calls.length, { url, ...init });
    },
    ...options,
  });
  fomapay.sleep = async (ms) => void waits.push(ms);
  return { fomapay, calls, waits };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('refuse une clé secrète ou mal formée', () => {
  assert.throws(() => new FomaPay({ publicKey: 'sk_test_abc' }), (e) => e.code === 'ERROR_INVALID_API_KEY');
});

test('createPayment envoie le format standard et une clé d’idempotence', async () => {
  const { fomapay, calls } = makeClient(() => json(201, PAYMENT));
  await fomapay.createPayment({
    amount: 25,
    currency: 'USD',
    orderId: 'CMD-1',
    customer: { name: 'Jean Marc', phone: '+243810000000' },
    paymentModes: ['fomapay_direct', 'mobile_money'],
    callbackUrl: 'https://marchand.cd/api/callback',
    metadata: { custom_field: 'valeur' },
  });
  assert.equal(calls[0].url, 'https://api.test/v1/payments');
  assert.equal(calls[0].headers.Authorization, 'Bearer pk_test_unit');
  assert.match(calls[0].headers['Idempotency-Key'], /^rn-/);
  assert.deepEqual(JSON.parse(calls[0].body), {
    amount: 25,
    currency: 'USD',
    orderId: 'CMD-1',
    customer: { name: 'Jean Marc', phone: '+243810000000' },
    paymentModes: ['fomapay_direct', 'mobile_money'],
    callbackUrl: 'https://marchand.cd/api/callback',
    metadata: { custom_field: 'valeur' },
  });
});

test('politique de nouvelles tentatives', async () => {
  const flaky = makeClient((n) => {
    if (n === 1) return failure(503, 'ERROR_UNAVAILABLE');
    if (n === 2) throw new TypeError('Network request failed');
    return json(201, PAYMENT);
  });
  await flaky.fomapay.createPayment({ amount: 25, currency: 'USD' });
  assert.equal(flaky.calls.length, 3);
  assert.equal(new Set(flaky.calls.map((c) => c.headers['Idempotency-Key'])).size, 1);
  assert.ok(flaky.waits[0] >= 250 && flaky.waits[0] <= 500 && flaky.waits[1] >= 500 && flaky.waits[1] <= 1000, String(flaky.waits));

  const down = makeClient(() => failure(500, 'ERROR_INTERNAL'), { maxRetries: 1 });
  await assert.rejects(down.fomapay.getPayment('FP-1'), (e) => e instanceof FomaPayApiError && e.status === 500);
  assert.equal(down.calls.length, 2);

  const refused = makeClient(() => failure(403, 'ERROR_LEVEL_0_LIMIT_REACHED'));
  await assert.rejects(refused.fomapay.createPayment({ amount: 900, currency: 'USD' }), (e) => e.details.champ === 'amount');
  assert.equal(refused.calls.length, 1);

  // Un POST sans clé d'idempotence n'est rejoué que sur un 429.
  const broken = makeClient(() => failure(502, 'ERROR_BAD_GATEWAY'));
  await assert.rejects(broken.fomapay.payWithMobileMoney('pay_1', 'mpesa', '+243810000000'), FomaPayApiError);
  assert.equal(broken.calls.length, 1);

  const limited = makeClient((n) => (n === 1 ? failure(429, 'ERROR_RATE_LIMITED', { 'Retry-After': '2' }) : json(200, PAYMENT)));
  await limited.fomapay.payWithMobileMoney('FP/1', 'airtel_money', '+243970000000');
  assert.deepEqual([limited.calls.length, limited.waits], [2, [2000]]);
  assert.equal(limited.calls[1].url, 'https://api.test/v1/payments/FP%2F1/mobile-money');

  const hang = (_n, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = makeClient(hang, { timeoutMs: 20, maxRetries: 1 });
  await assert.rejects(slow.fomapay.store(), (e) => e instanceof FomaPayNetworkError && e.code === 'ERROR_TIMEOUT');
  assert.equal(slow.calls.length, 2);
});

test('formatAmount et normalizePhone', () => {
  assert.equal(formatAmount(1000, 'CDF'), '1 000 CDF');
  assert.equal(formatAmount(1234567.5, 'USD'), '1 234 567,50 USD');
  assert.equal(formatAmount(12.5, 'CDF'), '12,50 CDF');
  for (const input of ['0812345678', '812345678', '+243 81 234 5678', '243812345678']) {
    assert.equal(normalizePhone(input), '+243812345678', input);
  }
  assert.equal(normalizePhone('81234'), null);
});

/** Faux backend : un paiement en mémoire, dont le test pilote l'état. */
function fakeApi({ storeModes = STORE.paymentModes, failCreation = 0 } = {}) {
  const api = { status: 'pending', created: 0, payerPhone: null, keys: [] };
  const payment = () => ({ ...PAYMENT, id: `pay_${api.created}`, reference: `FP-${api.created}`, status: api.status, payerPhone: api.payerPhone });
  const { fomapay } = makeClient((_n, { url, method, body, headers }) => {
    if (url.endsWith('/v1/store')) return json(200, { ...STORE, paymentModes: storeModes });
    if (url.endsWith('/v1/payments') && method === 'POST') {
      if (failCreation-- > 0) return failure(403, 'ERROR_LEVEL_0_LIMIT_REACHED');
      api.keys.push(headers['Idempotency-Key']);
      api.created++;
      api.status = 'pending';
    } else if (url.endsWith('/mobile-money')) {
      api.payerPhone = JSON.parse(body).phone;
      api.status = 'processing';
    } else if (url.endsWith('/simulate')) {
      api.status = JSON.parse(body).outcome === 'success' ? 'success' : 'failed';
    }
    return json(200, payment());
  }, { maxRetries: 0 });
  return { api, fomapay };
}

test('contrôleur : FomaPay Direct, simulation puis nouvelle tentative', async () => {
  const { api, fomapay } = fakeApi();
  const controller = new CheckoutController(fomapay, { amount: 25, currency: 'USD', idempotencyKey: 'CMD-1' }, 10);
  const phases = [];
  controller.subscribe((state) => phases.at(-1) !== state.phase && phases.push(state.phase));

  await controller.start();
  assert.deepEqual([controller.state.phase, controller.state.mode, controller.state.isTest], ['ready', 'fomapay_direct', true]);
  assert.deepEqual(controller.state.modes, ['fomapay_direct', 'mobile_money']);

  await controller.simulate('failed');
  assert.equal(controller.state.phase, 'failed');

  // « Réessayer » crée un autre paiement, sans réutiliser la clé d'idempotence du marchand.
  await controller.start();
  assert.equal(controller.state.payment.reference, 'FP-2');
  assert.equal(api.keys[0], 'CMD-1');
  assert.notEqual(api.keys[1], 'CMD-1');

  await controller.simulate('success');
  assert.deepEqual(phases, ['loading', 'ready', 'failed', 'loading', 'ready', 'success']);
  controller.dispose();
});

test('contrôleur : Mobile Money confirmé par interrogation', async () => {
  const { api, fomapay } = fakeApi();
  const controller = new CheckoutController(fomapay, { amount: 25, currency: 'USD' }, 10);
  await controller.start();
  controller.selectMode('mobile_money');
  assert.equal(controller.state.mode, 'mobile_money');

  await controller.payWithMobileMoney('airtel_money', '+243970000000');
  assert.equal(controller.state.phase, 'processing');
  assert.equal(controller.state.payment.payerPhone, '+243970000000');

  api.status = 'success'; // l'opérateur confirme : découvert à l'interrogation suivante
  await tick(60);
  assert.equal(controller.state.phase, 'success');
  controller.dispose();
});

test('contrôleur : modes limités par le KYC et erreur de création', async () => {
  const level0 = fakeApi({ storeModes: ['fomapay_direct'] });
  const restricted = new CheckoutController(level0.fomapay, { amount: 25, currency: 'USD' }, 10);
  await restricted.start();
  assert.deepEqual(restricted.state.modes, ['fomapay_direct']);
  restricted.selectMode('mobile_money');
  assert.equal(restricted.state.mode, 'fomapay_direct');
  restricted.dispose();

  const capped = fakeApi({ failCreation: 1 });
  const controller = new CheckoutController(capped.fomapay, { amount: 900, currency: 'USD' }, 10);
  await controller.start();
  assert.deepEqual([controller.state.phase, controller.state.error.code], ['error', 'ERROR_LEVEL_0_LIMIT_REACHED']);
  await controller.start();
  assert.equal(controller.state.phase, 'ready');
  controller.dispose();
});
