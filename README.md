# @fomapay/react-native

SDK React Native officiel de **FomaPay** : une fenêtre de paiement prête à l'emploi pour encaisser en RDC par **FomaPay Direct** (QR code, dès le Niveau 0) et par **Mobile Money** (M-Pesa, Orange Money, Airtel Money, dès le Niveau 1).

- **Aucun module natif** : fonctionne avec Expo Go, Expo et React Native « bare », sans `pod install`
- Feuille modale soignée, thèmes clair et sombre, iOS et Android
- N'embarque que la clé **publique** `pk_…` : aucun secret dans l'application
- Nouvelles tentatives automatiques et délai d'attente
- Entièrement typé (TypeScript)

## Intégration en 3 étapes

### 1. Installer

```bash
npm install @fomapay/react-native
```

### 2. Placer le fournisseur à la racine

```tsx
import { FomaPayProvider } from '@fomapay/react-native';

export default function App() {
  return (
    <FomaPayProvider publicKey="pk_test_…">{/* FomaPay Business › Développeurs */}
      <Navigation />
    </FomaPayProvider>
  );
}
```

### 3. Encaisser

```tsx
import { useFomaPay } from '@fomapay/react-native';

function PayButton() {
  const { checkout } = useFomaPay();

  const pay = async () => {
    const payment = await checkout({
      amount: 1000,
      currency: 'CDF',
      orderId: 'CMD-2026-001',
      customer: { name: 'Jean Marc', phone: '+243810000000', email: 'jean@example.com' },
      paymentModes: ['fomapay_direct', 'mobile_money'],
      callbackUrl: 'https://marchand.cd/api/callback',
      metadata: { custom_field: 'valeur' },
    });
    if (payment) {
      // Paiement confirmé à l'écran : affichez la suite de la commande.
    }
  };

  return <Button title="Payer 1 000 CDF" onPress={pay} />;
}
```

`checkout` se résout avec le paiement confirmé, ou `null` si le client a fermé la fenêtre. Seuls les modes que le niveau KYC de la boutique autorise sont proposés.

> L'écran du client n'est jamais une preuve de paiement. Votre serveur reçoit le webhook `payment.succeeded`, signé, et valide la commande : voyez les SDKs serveur (`@fomapay/sdk-js/server`, `fomapay-php`, `fomapay-python`, `fomapay-go`, `fomapay-java`).

## Personnaliser

```tsx
await checkout(params, { title: 'Dzoket Store', description: 'Commande #CMD-8921', accentColor: '#7A1FA2' });
```

Pour une interface entièrement sur mesure, trois niveaux sont disponibles :

| Niveau | Rôle |
| --- | --- |
| `<FomaPayCheckout fomapay params onClose />` | La fenêtre, pilotée par vos propres états (sans fournisseur) |
| `CheckoutController` | Toute la logique — création, choix du mode, suivi, nouvelle tentative — sans aucun composant : `subscribe`, `start`, `selectMode`, `payWithMobileMoney`, `simulate`, `dispose` |
| `FomaPay` (via `useFomaPay().fomapay`) | Les appels bruts : `createPayment`, `payWithMobileMoney`, `getPayment`, `waitForPayment`, `store`, `simulatePayment` (sandbox) |

Le composant `QrCode` (dessiné avec de simples `View`) et les utilitaires `formatAmount` / `normalizePhone` sont également exportés.

## Erreurs

```ts
import { FomaPayApiError, FomaPayNetworkError } from '@fomapay/react-native';

try {
  await fomapay.createPayment(params);
} catch (e) {
  if (e instanceof FomaPayApiError) console.log(e.code, e.status, e.message); // ex. ERROR_LEVEL_0_LIMIT_REACHED
  if (e instanceof FomaPayNetworkError) console.log(e.code);                  // ERROR_NETWORK ou ERROR_TIMEOUT
}
```

La fenêtre de paiement gère elle-même ces erreurs et propose « Réessayer ».

## Fiabilité

```tsx
<FomaPayProvider publicKey="pk_live_…" timeoutMs={15000} maxRetries={3}>
```

- **Nouvelles tentatives** (2 par défaut) avec attente exponentielle (0,5 s, 1 s… plafonnée à 8 s). Ne sont rejouées que les requêtes sans risque : les lectures, et les créations de paiement, qui portent toujours un en-tête `Idempotency-Key`. Un `429` est toujours rejoué en respectant `Retry-After`.
- **Idempotence** : `idempotencyKey: 'CMD-2026-001'` pour qu'un double appui ne crée qu'un paiement.
- **Réseau instable** : pendant l'attente, une coupure passagère n'interrompt pas la fenêtre ; le suivi reprend à l'interrogation suivante.

## Sandbox

Avec une clé `pk_test_…`, aucun argent ne circule ; la fenêtre affiche le badge « TEST » et propose « Simuler un succès / un échec ». Numéros Mobile Money de test : terminé par `0001` → refusé, par `0002` → jamais validé, sinon confirmé après ~3 s.

En développement, pointez vers votre backend local avec `apiUrl="http://10.0.2.2:8080"` (émulateur Android) ou l'adresse de votre machine sur le réseau.

## Développement

```bash
npm install
npm run typecheck
npm test          # tests unitaires du client et de la logique de la fenêtre
```

Tests d'intégration contre le sandbox (ignorés si la variable est absente) :

```bash
FOMAPAY_API_URL=http://localhost:8080 FOMAPAY_TEST_PUBLIC_KEY=pk_test_… npm test
```

Un exemple d'écran se trouve dans [example/App.tsx](example/App.tsx).

Licence MIT.
