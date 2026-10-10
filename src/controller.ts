import { FomaPay, FomaPayError, MobileOperator, Payment, PaymentMode, PaymentParams, StoreInfo } from './client';

/**
 * Étapes de la fenêtre de paiement :
 * - `loading` : création du paiement ;
 * - `ready` : le client choisit son mode et paie ;
 * - `processing` : demande Mobile Money envoyée, le client valide sur son téléphone ;
 * - `success` / `failed` ;
 * - `error` : le paiement n'a pas pu être créé (réseau, plafond KYC…).
 */
export type CheckoutPhase = 'loading' | 'ready' | 'processing' | 'success' | 'failed' | 'error';

export interface CheckoutState {
  phase: CheckoutPhase;
  store: StoreInfo | null;
  payment: Payment | null;
  /** Modes proposés : ceux du paiement que la boutique a le droit d'utiliser. */
  modes: PaymentMode[];
  mode: PaymentMode | null;
  /** Dernière erreur, à afficher au client. */
  error: FomaPayError | null;
  /** Une action (envoi Mobile Money, simulation) est en cours. */
  busy: boolean;
  /** Vrai en sandbox : la fenêtre propose alors de simuler l'issue. */
  isTest: boolean;
}

const ALL_MODES: PaymentMode[] = ['fomapay_direct', 'mobile_money'];
const asError = (e: unknown): FomaPayError =>
  e instanceof FomaPayError ? e : new FomaPayError('ERROR_UNKNOWN', e instanceof Error ? e.message : 'Une erreur est survenue.');

/**
 * Logique de la fenêtre de paiement, sans aucune interface : crée le paiement, suit son état
 * et publie ce qu'il faut afficher. Utilisable seule pour une interface sur mesure.
 */
export class CheckoutController {
  private current: CheckoutState;
  private readonly listeners = new Set<(state: CheckoutState) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private firstAttempt = true;

  constructor(
    private readonly fomapay: FomaPay,
    private readonly params: PaymentParams,
    private readonly pollIntervalMs = 2500,
  ) {
    this.current = {
      phase: 'loading', store: null, payment: null, modes: [], mode: null, error: null, busy: false, isTest: !fomapay.livemode,
    };
  }

  get state(): CheckoutState {
    return this.current;
  }

  /** S'abonne aux changements d'état ; renvoie la fonction de désabonnement. */
  subscribe(listener: (state: CheckoutState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Crée le paiement. Rappelée par « Réessayer » : un paiement échoué ne se rejoue pas, on en crée un autre. */
  async start(): Promise<void> {
    this.stopPolling();
    this.set({ phase: 'loading', error: null, payment: null });
    try {
      // La clé d'idempotence du marchand ne vaut que pour la première tentative.
      const params = this.firstAttempt ? this.params : { ...this.params, idempotencyKey: undefined };
      this.firstAttempt = false;
      const [store, payment] = await Promise.all([this.fomapay.store(), this.fomapay.createPayment(params)]);
      if (this.disposed) return;
      const modes = ALL_MODES.filter(
        (mode) => store.paymentModes.includes(mode) && (!payment.paymentModes?.length || payment.paymentModes.includes(mode)),
      );
      const mode = this.current.mode && modes.includes(this.current.mode) ? this.current.mode : (modes[0] ?? null);
      this.set({ store, modes, mode });
      this.apply(payment);
      this.startPolling();
    } catch (e) {
      this.set({ phase: 'error', error: asError(e) });
    }
  }

  selectMode(mode: PaymentMode): void {
    if (this.current.phase === 'ready' && this.current.modes.includes(mode)) this.set({ mode, error: null });
  }

  /** Envoie la demande de débit sur le téléphone du client. */
  payWithMobileMoney(operator: MobileOperator, phone: string): Promise<void> {
    return this.act((id) => this.fomapay.payWithMobileMoney(id, operator, phone));
  }

  /** Force l'issue du paiement (sandbox). */
  simulate(outcome: 'success' | 'failed'): Promise<void> {
    return this.act((id) => this.fomapay.simulatePayment(id, outcome));
  }

  /** Arrête le suivi. À appeler quand la fenêtre se ferme. */
  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  private async act(action: (paymentId: string) => Promise<Payment>): Promise<void> {
    const payment = this.current.payment;
    if (this.current.busy || !payment) return;
    this.set({ busy: true, error: null });
    try {
      const updated = await action(payment.id);
      if (this.disposed) return;
      this.apply(updated);
      this.set({ busy: false });
    } catch (e) {
      this.set({ busy: false, error: asError(e) });
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.timer = setInterval(async () => {
      const payment = this.current.payment;
      if (!payment || this.current.busy || (payment.status !== 'pending' && payment.status !== 'processing')) return;
      try {
        const updated = await this.fomapay.getPayment(payment.id);
        if (!this.disposed && this.current.payment?.id === updated.id) this.apply(updated);
      } catch {
        // Coupure passagère : la prochaine interrogation réessaiera.
      }
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private apply(payment: Payment): void {
    const phase: CheckoutPhase =
      payment.status === 'pending' ? 'ready'
      : payment.status === 'processing' ? 'processing'
      : payment.status === 'success' ? 'success'
      : 'failed';
    if (phase === 'success' || phase === 'failed') this.stopPolling();
    this.set({ payment, phase });
  }

  private set(patch: Partial<CheckoutState>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch };
    this.listeners.forEach((listener) => listener(this.current));
  }
}
