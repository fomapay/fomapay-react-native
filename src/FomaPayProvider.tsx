import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { FomaPay, FomaPayError, FomaPayOptions, Payment, PaymentParams } from './client';
import { CheckoutCustomization, FomaPayCheckout } from './FomaPayCheckout';

export interface FomaPayContextValue {
  /** Client bas niveau, pour construire sa propre interface. */
  fomapay: FomaPay;
  /**
   * Ouvre la fenêtre de paiement. La promesse se résout avec le paiement confirmé,
   * ou `null` si le client a fermé la fenêtre avant la fin.
   */
  checkout: (params: PaymentParams, customization?: CheckoutCustomization) => Promise<Payment | null>;
}

const FomaPayContext = createContext<FomaPayContextValue | null>(null);

export interface FomaPayProviderProps extends FomaPayOptions {
  children: React.ReactNode;
}

/** À placer à la racine de l'application : fournit `useFomaPay()` et héberge la fenêtre de paiement. */
export function FomaPayProvider({ children, publicKey, apiUrl, timeoutMs, maxRetries, fetch }: FomaPayProviderProps) {
  const fomapay = useMemo(
    () => new FomaPay({ publicKey, apiUrl, timeoutMs, maxRetries, fetch }),
    [publicKey, apiUrl, timeoutMs, maxRetries, fetch],
  );
  const [active, setActive] = useState<{ params: PaymentParams; customization?: CheckoutCustomization } | null>(null);
  const resolver = useRef<((payment: Payment | null) => void) | null>(null);

  const checkout = useCallback((params: PaymentParams, customization?: CheckoutCustomization) => {
    // Une seule fenêtre à la fois : la précédente est considérée comme abandonnée.
    resolver.current?.(null);
    return new Promise<Payment | null>((resolve) => {
      resolver.current = resolve;
      setActive({ params, customization });
    });
  }, []);

  const close = useCallback((payment: Payment | null) => {
    resolver.current?.(payment);
    resolver.current = null;
    setActive(null);
  }, []);

  const value = useMemo(() => ({ fomapay, checkout }), [fomapay, checkout]);

  return (
    <FomaPayContext.Provider value={value}>
      {children}
      <FomaPayCheckout fomapay={fomapay} params={active?.params ?? null} customization={active?.customization} onClose={close} />
    </FomaPayContext.Provider>
  );
}

/** Accès au SDK depuis un composant placé sous `<FomaPayProvider>`. */
export function useFomaPay(): FomaPayContextValue {
  const value = useContext(FomaPayContext);
  if (!value) {
    throw new FomaPayError('ERROR_PROVIDER_MISSING', 'useFomaPay() doit être appelé sous <FomaPayProvider publicKey="pk_…">.');
  }
  return value;
}
