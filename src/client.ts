export type Currency = 'USD' | 'CDF';
export type PaymentMode = 'fomapay_direct' | 'mobile_money';
export type MobileOperator = 'mpesa' | 'orange_money' | 'airtel_money';
export type PaymentStatus = 'pending' | 'processing' | 'success' | 'failed' | 'expired';

export interface Customer {
  name?: string;
  phone?: string;
  email?: string;
}

export interface Payment {
  id: string;
  /** Référence lisible (FP-…). */
  reference: string;
  status: PaymentStatus;
  amount: number;
  fee: number;
  net: number;
  currency: Currency;
  /** Canal réellement utilisé (fomapay_direct, mpesa…). */
  channel: string | null;
  orderId: string | null;
  description: string | null;
  customer: Customer | null;
  metadata: Record<string, unknown> | null;
  paymentModes: PaymentMode[];
  callbackUrl: string | null;
  payerPhone: string | null;
  /** Contenu du QR code à afficher au client (FomaPay Direct). */
  qrCode: string | null;
  livemode: boolean;
  storeId: string;
  failureCode: string | null;
  failureReason: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Boutique liée à la clé, avec les modes que son niveau KYC autorise. */
export interface StoreInfo {
  id: string;
  name: string;
  shortCode: string;
  logoUrl: string | null;
  livemode: boolean;
  kycLevel: number;
  paymentModes: PaymentMode[];
}

export interface PaymentParams {
  /** Montant en unités de la devise (12.5 = 12,50 USD). */
  amount: number;
  currency: Currency;
  /** Votre identifiant de commande, renvoyé tel quel dans les webhooks. */
  orderId?: string;
  description?: string;
  customer?: Customer;
  /** Par défaut, tous les modes que le niveau KYC de la boutique autorise. */
  paymentModes?: PaymentMode[];
  /** Page de votre site vers laquelle renvoyer le client une fois le paiement terminé. */
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  /** Ex. l'identifiant de commande : un appel répété renvoie le même paiement. */
  idempotencyKey?: string;
}

/**
 * Erreur FomaPay : `code` est stable et exploitable par le programme
 * (ex. ERROR_LEVEL_0_LIMIT_REACHED), `message` est lisible par un humain.
 */
export class FomaPayError extends Error {
  readonly code: string;
  /** Statut HTTP (0 quand il n'y a pas eu de réponse). */
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 0, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FomaPayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** L'API a répondu avec une erreur. */
export class FomaPayApiError extends FomaPayError {
  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(code, message, status, details);
    this.name = 'FomaPayApiError';
  }
}

/** Aucune réponse : connexion impossible (ERROR_NETWORK) ou délai dépassé (ERROR_TIMEOUT). */
export class FomaPayNetworkError extends FomaPayError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'FomaPayNetworkError';
  }
}

export const DEFAULT_API_URL = 'https://api.fomapay.cd';
const MAX_BACKOFF_MS = 8_000;

export interface FomaPayOptions {
  /** Clé publique de la boutique (pk_test_… ou pk_live_…). La clé secrète reste sur votre serveur. */
  publicKey: string;
  /** À surcharger pour pointer vers un backend local en développement. */
  apiUrl?: string;
  /** Délai maximal d'une requête, en millisecondes (30 000 par défaut). */
  timeoutMs?: number;
  /** Nouvelles tentatives après un échec rejouable (2 par défaut). */
  maxRetries?: number;
  /** Implémentation de fetch à utiliser (tests). */
  fetch?: typeof fetch;
}

/** Clé unique : rejouer la requête ne crée pas de doublon. */
export const newIdempotencyKey = (): string => {
  let key = 'rn-';
  for (let i = 0; i < 32; i++) key += Math.floor(Math.random() * 16).toString(16);
  return key + Date.now().toString(36);
};

/** 0,5 s, 1 s, 2 s… plafonné à 8 s, avec un aléa pour désynchroniser les clients. */
const backoff = (attempt: number): number => {
  const delay = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
  return delay / 2 + Math.random() * (delay / 2);
};

/** Client FomaPay pour une application. N'utilise que la clé publique. */
export class FomaPay {
  readonly publicKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl?: typeof fetch;
  private storeInfo?: Promise<StoreInfo>;
  /** Remplaçable dans les tests. */
  sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(options: FomaPayOptions) {
    if (!/^pk_(test|live)_/.test(options?.publicKey ?? '')) {
      throw new FomaPayError(
        'ERROR_INVALID_API_KEY',
        'Clé publique absente ou mal formée : elle commence par pk_test_ ou pk_live_ (FomaPay Business › Développeurs).',
      );
    }
    this.publicKey = options.publicKey;
    this.baseUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.fetchImpl = options.fetch;
  }

  /** Faux avec une clé pk_test_… : aucun argent ne circule. */
  get livemode(): boolean {
    return this.publicKey.startsWith('pk_live_');
  }

  /** Boutique liée à la clé (mise en cache). */
  store(): Promise<StoreInfo> {
    if (!this.storeInfo) {
      this.storeInfo = this.request<StoreInfo>('GET', '/v1/store').catch((error) => {
        this.storeInfo = undefined;
        throw error;
      });
    }
    return this.storeInfo;
  }

  /** Crée une demande de paiement. Porte toujours une clé d'idempotence : rejouable sans doublon. */
  createPayment({ idempotencyKey, ...params }: PaymentParams): Promise<Payment> {
    return this.request('POST', '/v1/payments', params, idempotencyKey ?? newIdempotencyKey());
  }

  /** Relit un paiement par son identifiant ou sa référence (FP-…). */
  getPayment(id: string): Promise<Payment> {
    return this.request('GET', `/v1/payments/${encodeURIComponent(id)}`);
  }

  /** Envoie la demande de débit (push USSD) sur le téléphone du client. */
  payWithMobileMoney(id: string, operator: MobileOperator, phone: string): Promise<Payment> {
    return this.request('POST', `/v1/payments/${encodeURIComponent(id)}/mobile-money`, { operator, phone });
  }

  /** Force l'issue d'un paiement. Sandbox uniquement. */
  simulatePayment(id: string, outcome: 'success' | 'failed' = 'success'): Promise<Payment> {
    return this.request('POST', `/v1/payments/${encodeURIComponent(id)}/simulate`, { outcome });
  }

  /** Attend l'issue d'un paiement (succès, échec ou expiration). */
  async waitForPayment(id: string, { intervalMs = 2500, timeoutMs = 10 * 60_000 } = {}): Promise<Payment> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const payment = await this.getPayment(id);
      if (payment.status !== 'pending' && payment.status !== 'processing') return payment;
      if (Date.now() > deadline) throw new FomaPayError('ERROR_PAYMENT_TIMEOUT', "Le paiement n'a pas été confirmé à temps.");
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Exécute une requête, avec nouvelles tentatives quand elle est rejouable sans risque
   * (lecture, ou POST accompagné d'une clé d'idempotence).
   */
  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const replayable = method === 'GET' || idempotencyKey !== undefined;
    for (let attempt = 0; ; attempt++) {
      const { data, error, retry, waitMs } = await this.attempt<T>(method, path, body, idempotencyKey, replayable);
      if (!error) return data as T;
      if (!retry || attempt >= this.maxRetries) throw error;
      await this.sleep(waitMs ?? backoff(attempt));
    }
  }

  private async attempt<T>(
    method: string, path: string, body: unknown, idempotencyKey: string | undefined, replayable: boolean,
  ): Promise<{ data?: T; error?: FomaPayError; retry?: boolean; waitMs?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let data: any;
    try {
      res = await (this.fetchImpl ?? fetch)(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.publicKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      data = await res.json().catch(() => null);
    } catch {
      const error = controller.signal.aborted
        ? new FomaPayNetworkError('ERROR_TIMEOUT', "FomaPay n'a pas répondu dans le délai imparti.")
        : new FomaPayNetworkError('ERROR_NETWORK', 'Impossible de joindre FomaPay. Vérifiez votre connexion Internet.');
      return { error, retry: replayable };
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return { data: data as T };

    const err = data?.error ?? {};
    const error = new FomaPayApiError(err.code ?? 'ERROR_UNKNOWN', err.message ?? `Erreur HTTP ${res.status}`, res.status, err.details);
    if (res.status === 429) {
      // La gateway a refusé la requête avant tout traitement : toujours rejouable.
      const retryAfter = Number(res.headers.get('Retry-After'));
      return { error, retry: true, waitMs: retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS) : undefined };
    }
    return { error, retry: res.status >= 500 && replayable };
  }
}

/** « 1 000 CDF », « 12,50 USD ». Écrit à la main : Intl est incomplet sur Hermes. */
export function formatAmount(amount: number, currency: Currency): string {
  const decimals = currency === 'CDF' && Number.isInteger(amount) ? 0 : 2;
  const [whole, fraction] = Math.abs(amount).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${amount < 0 ? '-' : ''}${grouped}${fraction ? `,${fraction}` : ''} ${currency}`;
}

/**
 * Met un numéro congolais au format international : « 081 234 5678 », « 812345678 » ou
 * « +243 81… » deviennent « +243812345678 ». Renvoie null si le numéro est incomplet.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('243')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.length === 9 ? `+243${digits}` : null;
}
