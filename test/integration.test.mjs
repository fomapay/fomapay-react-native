// Tests d'intégration contre le sandbox FomaPay. Ils ne s'exécutent que si
// FOMAPAY_TEST_PUBLIC_KEY (pk_test_…) est définie ; FOMAPAY_API_URL cible un backend local.
//
//   FOMAPAY_API_URL=http://localhost:8080 FOMAPAY_TEST_PUBLIC_KEY=pk_test_… npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckoutController, FomaPay } from '../dist/core.mjs';

const { FOMAPAY_TEST_PUBLIC_KEY: publicKey, FOMAPAY_API_URL: apiUrl } = process.env;
const skip = !publicKey && 'FOMAPAY_TEST_PUBLIC_KEY non définie';

test('sandbox : client', { skip }, async () => {
  const fomapay = new FomaPay({ publicKey, apiUrl });
  const store = await fomapay.store();
  assert.equal(store.livemode, false);
  assert.equal(store.paymentModes.length, 2);

  // Format standard d'une transaction, dans les deux modes.
  const payment = await fomapay.createPayment({
    amount: 1000,
    currency: 'CDF',
    orderId: 'CMD-2026-001',
    customer: { name: 'Jean Marc', phone: '+243810000000', email: 'jean@example.com' },
    paymentModes: ['fomapay_direct', 'mobile_money'],
    callbackUrl: 'https://marchand.cd/api/callback',
    metadata: { custom_field: 'valeur' },
  });
  assert.equal(payment.status, 'pending');
  assert.equal(payment.callbackUrl, 'https://marchand.cd/api/callback');
  assert.ok(payment.qrCode);

  // Numéro terminé par 0001 : refus de l'opérateur.
  await fomapay.payWithMobileMoney(payment.id, 'mpesa', '+243810000001');
  const refused = await fomapay.waitForPayment(payment.id, { intervalMs: 1000, timeoutMs: 15_000 });
  assert.equal(refused.status, 'failed');

  // Idempotence : la même clé renvoie le même paiement.
  const idempotencyKey = `rn-it-${payment.id}`;
  const first = await fomapay.createPayment({ amount: 3, currency: 'USD', idempotencyKey });
  const again = await fomapay.createPayment({ amount: 3, currency: 'USD', idempotencyKey });
  assert.equal(first.id, again.id);

  await assert.rejects(fomapay.createPayment({ amount: -1, currency: 'USD' }), (e) => e.code === 'ERROR_VALIDATION');
  await assert.rejects(fomapay.getPayment('FP-INEXISTANT'), (e) => e.status === 404);
});

test('sandbox : fenêtre de paiement (contrôleur) en Mobile Money', { skip }, async () => {
  const controller = new CheckoutController(new FomaPay({ publicKey, apiUrl }), { amount: 12.5, currency: 'USD' }, 1000);
  await controller.start();
  assert.equal(controller.state.phase, 'ready');
  assert.deepEqual(controller.state.modes, ['fomapay_direct', 'mobile_money']);

  await controller.payWithMobileMoney('airtel_money', '+243970000000');
  assert.equal(controller.state.phase, 'processing');

  // L'opérateur simulé confirme après ~3 s : le suivi automatique doit le voir.
  const done = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(controller.state), 12_000);
    controller.subscribe((state) => {
      if (state.phase === 'success' || state.phase === 'failed') {
        clearTimeout(timeout);
        resolve(state);
      }
    });
  });
  assert.equal(done.phase, 'success');
  assert.equal(done.payment.channel, 'airtel_money');
  controller.dispose();
});
