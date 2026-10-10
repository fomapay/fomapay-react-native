import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  useColorScheme,
} from 'react-native';
import { FomaPay, MobileOperator, Payment, PaymentMode, PaymentParams, formatAmount, normalizePhone } from './client';
import { CheckoutController, CheckoutState } from './controller';
import { QrCode } from './QrCode';

export interface CheckoutCustomization {
  /** Nom affiché en tête (par défaut : celui de la boutique). */
  title?: string;
  /** Sous-titre (par défaut : la description du paiement, ou le numéro de commande). */
  description?: string;
  /** Couleur du bouton principal (par défaut : le bleu FomaPay). */
  accentColor?: string;
}

export interface FomaPayCheckoutProps {
  fomapay: FomaPay;
  /** Paiement à encaisser ; `null` ferme la fenêtre. */
  params: PaymentParams | null;
  customization?: CheckoutCustomization;
  /**
   * Appelée à la fermeture, avec le paiement confirmé ou `null` si le client a abandonné.
   * L'écran du client n'est jamais une preuve de paiement : confirmez la commande côté serveur.
   */
  onClose: (payment: Payment | null) => void;
  /** Intervalle de suivi du paiement, en millisecondes (2 500 par défaut). */
  pollIntervalMs?: number;
}

const NAVY = '#032B56';
const TEAL = '#00C4B4';
const SUCCESS = '#12A150';
const DANGER = '#D92D20';

const OPERATORS: { id: MobileOperator; label: string; color: string }[] = [
  { id: 'mpesa', label: 'M-Pesa', color: '#E60000' },
  { id: 'orange_money', label: 'Orange Money', color: '#FF7900' },
  { id: 'airtel_money', label: 'Airtel Money', color: '#ED1C24' },
];
const MODE_LABELS: Record<PaymentMode, string> = { fomapay_direct: 'FomaPay', mobile_money: 'Mobile Money' };

const palettes = {
  light: { surface: '#FFFFFF', card: '#F5F7FA', text: '#0B1B33', muted: '#64748B', border: '#E2E8F0', accent: NAVY },
  dark: { surface: '#0E1726', card: '#172236', text: '#F2F5F9', muted: '#94A3B8', border: '#26344D', accent: '#2B7BD6' },
};
type Palette = (typeof palettes)['light'];

/** Fenêtre de paiement FomaPay, présentée en feuille modale au bas de l'écran. */
export function FomaPayCheckout({ fomapay, params, customization, onClose, pollIntervalMs }: FomaPayCheckoutProps) {
  return (
    <Modal visible={params !== null} transparent animationType="slide" statusBarTranslucent onRequestClose={() => onClose(null)}>
      {params && (
        <Sheet fomapay={fomapay} params={params} customization={customization} onClose={onClose} pollIntervalMs={pollIntervalMs} />
      )}
    </Modal>
  );
}

function Sheet({ fomapay, params, customization, onClose, pollIntervalMs }: FomaPayCheckoutProps & { params: PaymentParams }) {
  const scheme = useColorScheme();
  const palette: Palette = useMemo(
    () => ({ ...palettes[scheme === 'dark' ? 'dark' : 'light'], ...(customization?.accentColor ? { accent: customization.accentColor } : {}) }),
    [scheme, customization?.accentColor],
  );
  const controller = useMemo(() => new CheckoutController(fomapay, params, pollIntervalMs), [fomapay, params, pollIntervalMs]);
  const [state, setState] = useState<CheckoutState>(controller.state);
  const [operator, setOperator] = useState<MobileOperator>('mpesa');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.start();
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  const amount = formatAmount(params.amount, params.currency);
  const title = customization?.title ?? state.store?.name ?? 'Paiement';
  const subtitle = customization?.description ?? params.description ?? params.orderId;

  const submitMobileMoney = () => {
    const normalized = normalizePhone(phone);
    setPhoneError(normalized ? null : 'Entrez un numéro à 9 chiffres, ex. 81 234 5678');
    if (normalized) void controller.payWithMobileMoney(operator, normalized);
  };

  const primary = (label: string, onPress: () => void, loading = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => [styles.primary, { backgroundColor: palette.accent, opacity: pressed || loading ? 0.85 : 1 }]}
    >
      {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryLabel}>{label}</Text>}
    </Pressable>
  );

  const outcome = (symbol: string, color: string, heading: string, message: string, action?: React.ReactNode) => (
    <View style={styles.outcome}>
      <View style={[styles.outcomeIcon, { backgroundColor: color + '1F' }]}>
        <Text style={[styles.outcomeSymbol, { color }]}>{symbol}</Text>
      </View>
      <Text style={[styles.outcomeTitle, { color: palette.text }]}>{heading}</Text>
      <Text style={[styles.outcomeMessage, { color: palette.muted }]}>{message}</Text>
      {action}
    </View>
  );

  const body = () => {
    const payment = state.payment;
    switch (state.phase) {
      case 'loading':
        return <ActivityIndicator size="large" color={TEAL} style={styles.loading} />;
      case 'error':
        return outcome('!', DANGER, 'Paiement indisponible', state.error?.message ?? 'Une erreur est survenue.',
          primary('Réessayer', () => void controller.start()));
      case 'processing':
        return outcome('✆', palette.accent, 'Validez sur votre téléphone',
          `Une demande de paiement a été envoyée au ${payment?.payerPhone ?? 'numéro indiqué'}. Saisissez votre code secret pour confirmer.`,
          <ActivityIndicator color={TEAL} style={styles.spaced} />);
      case 'success':
        return outcome('✓', SUCCESS, 'Paiement réussi', `Référence ${payment!.reference}`, primary('Terminer', () => onClose(payment)));
      case 'failed':
        return outcome('✕', DANGER, payment?.status === 'expired' ? 'Paiement expiré' : 'Paiement refusé',
          payment?.failureReason ?? "Le paiement n'a pas abouti. Aucun montant n'a été débité.",
          primary('Réessayer', () => void controller.start()));
      case 'ready':
        if (!state.mode || !payment) {
          return outcome('!', DANGER, 'Aucun mode de paiement', 'Cette boutique ne peut pas encore accepter ce paiement.');
        }
        return (
          <View>
            {state.modes.length > 1 && (
              <View style={[styles.segments, { backgroundColor: palette.card }]}>
                {state.modes.map((mode) => {
                  const selected = mode === state.mode;
                  return (
                    <Pressable
                      key={mode}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      onPress={() => controller.selectMode(mode)}
                      style={[styles.segment, selected && { backgroundColor: palette.surface, borderColor: palette.border }]}
                    >
                      <Text style={[styles.segmentLabel, { color: selected ? palette.text : palette.muted }]}>{MODE_LABELS[mode]}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {state.mode === 'fomapay_direct' ? (
              <View style={styles.centered}>
                <View style={[styles.qrCard, { borderColor: palette.border }]}>
                  <QrCode value={payment.qrCode ?? payment.reference} size={196} />
                </View>
                <Text style={[styles.hint, { color: palette.text }]}>Scannez ce code avec l'application FomaPay</Text>
                <Text selectable style={[styles.reference, { color: palette.muted }]}>{payment.reference}</Text>
                <View style={styles.waiting}>
                  <ActivityIndicator size="small" color={TEAL} />
                  <Text style={[styles.waitingLabel, { color: palette.muted }]}>En attente du paiement…</Text>
                </View>
                {state.isTest && (
                  <View style={styles.simulate}>
                    {(['success', 'failed'] as const).map((result) => (
                      <Pressable
                        key={result}
                        accessibilityRole="button"
                        disabled={state.busy}
                        onPress={() => void controller.simulate(result)}
                        style={[styles.outlined, { borderColor: palette.border, opacity: state.busy ? 0.5 : 1 }]}
                      >
                        <Text style={[styles.outlinedLabel, { color: palette.text }]}>
                          {result === 'success' ? 'Simuler un succès' : 'Simuler un échec'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            ) : (
              <View>
                <View style={styles.operators}>
                  {OPERATORS.map((item) => {
                    const selected = item.id === operator;
                    return (
                      <Pressable
                        key={item.id}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        onPress={() => setOperator(item.id)}
                        style={[
                          styles.operator,
                          { backgroundColor: palette.card, borderColor: selected ? palette.accent : palette.border, borderWidth: selected ? 2 : 1 },
                        ]}
                      >
                        <View style={[styles.operatorDot, { backgroundColor: item.color }]} />
                        <Text numberOfLines={1} style={[styles.operatorLabel, { color: palette.text }]}>{item.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={[styles.phoneField, { backgroundColor: palette.card, borderColor: phoneError ? DANGER : 'transparent' }]}>
                  <Text style={[styles.phonePrefix, { color: palette.muted }]}>+243</Text>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    onSubmitEditing={submitMobileMoney}
                    keyboardType="phone-pad"
                    returnKeyType="done"
                    maxLength={17}
                    placeholder="81 234 5678"
                    placeholderTextColor={palette.muted}
                    accessibilityLabel={`Numéro ${OPERATORS.find((item) => item.id === operator)!.label}`}
                    style={[styles.phoneInput, { color: palette.text }]}
                  />
                </View>
                {phoneError && <Text style={styles.fieldError}>{phoneError}</Text>}
                {primary(`Payer ${amount}`, submitMobileMoney, state.busy)}
              </View>
            )}
            {state.error && <Text style={styles.actionError}>{state.error.message}</Text>}
          </View>
        );
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
      <Pressable accessibilityLabel="Fermer" style={StyleSheet.absoluteFill} onPress={() => onClose(null)} />
      <View style={[styles.sheet, { backgroundColor: palette.surface }]}>
        <View style={[styles.handle, { backgroundColor: palette.border }]} />
        <ScrollView keyboardShouldPersistTaps="handled" bounces={false} contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <View style={styles.avatar}>
              <Text style={styles.avatarLabel}>{(title[0] ?? 'F').toUpperCase()}</Text>
            </View>
            <View style={styles.headerText}>
              <View style={styles.titleRow}>
                <Text numberOfLines={1} style={[styles.title, { color: palette.text }]}>{title}</Text>
                {state.isTest && <Text style={styles.badge}>TEST</Text>}
              </View>
              {subtitle ? <Text numberOfLines={1} style={[styles.subtitle, { color: palette.muted }]}>{subtitle}</Text> : null}
            </View>
            <Text style={[styles.amount, { color: palette.text }]}>{amount}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Fermer" hitSlop={12} onPress={() => onClose(null)}>
              <Text style={[styles.close, { color: palette.muted }]}>✕</Text>
            </Pressable>
          </View>
          {body()}
          <Text style={[styles.footer, { color: palette.muted }]}>Paiement sécurisé par FomaPay</Text>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(5, 15, 30, 0.55)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '92%', width: '100%', maxWidth: 480, alignSelf: 'center' },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: 12 },
  content: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 28 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: NAVY, alignItems: 'center', justifyContent: 'center' },
  avatarLabel: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  headerText: { flex: 1, marginHorizontal: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  title: { flexShrink: 1, fontSize: 16, fontWeight: '700' },
  badge: {
    marginLeft: 8, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden',
    backgroundColor: '#FFF4D6', color: '#8A5A00', fontSize: 10, fontWeight: '800',
  },
  subtitle: { fontSize: 13, marginTop: 2 },
  amount: { fontSize: 18, fontWeight: '800', marginRight: 12 },
  close: { fontSize: 18 },
  loading: { marginVertical: 56 },
  spaced: { marginTop: 8 },
  centered: { alignItems: 'center' },
  segments: { flexDirection: 'row', borderRadius: 14, padding: 4, marginBottom: 18 },
  segment: { flex: 1, paddingVertical: 10, borderRadius: 11, alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  segmentLabel: { fontSize: 14, fontWeight: '700' },
  qrCard: { padding: 14, borderRadius: 20, borderWidth: 1, backgroundColor: '#FFFFFF' },
  hint: { marginTop: 14, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  reference: { marginTop: 6, fontSize: 13, letterSpacing: 0.4 },
  waiting: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  waitingLabel: { marginLeft: 10, fontSize: 13 },
  simulate: { flexDirection: 'row', marginTop: 16, alignSelf: 'stretch' },
  outlined: { flex: 1, marginHorizontal: 4, paddingVertical: 12, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  outlinedLabel: { fontSize: 13, fontWeight: '600' },
  operators: { flexDirection: 'row', marginHorizontal: -4, marginBottom: 14 },
  operator: { flex: 1, marginHorizontal: 4, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 14, alignItems: 'center' },
  operatorDot: { width: 10, height: 10, borderRadius: 5, marginBottom: 8 },
  operatorLabel: { fontSize: 12.5, fontWeight: '700' },
  phoneField: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, marginBottom: 14 },
  phonePrefix: { fontSize: 16, fontWeight: '600', marginRight: 10 },
  phoneInput: { flex: 1, fontSize: 16, fontWeight: '600', paddingVertical: 15 },
  fieldError: { color: DANGER, fontSize: 12.5, marginTop: -8, marginBottom: 12 },
  actionError: { color: DANGER, fontSize: 13, textAlign: 'center', marginTop: 12 },
  primary: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  primaryLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  outcome: { paddingTop: 8 },
  outcomeIcon: { alignSelf: 'center', width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  outcomeSymbol: { fontSize: 34, fontWeight: '700' },
  outcomeTitle: { marginTop: 16, fontSize: 19, fontWeight: '800', textAlign: 'center' },
  outcomeMessage: { marginTop: 6, marginBottom: 20, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  footer: { marginTop: 18, fontSize: 12, textAlign: 'center' },
});
