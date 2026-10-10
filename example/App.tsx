// Exemple minimal : à copier dans un projet Expo (`npx create-expo-app`) après `npm install @fomapay/react-native`.
import { FomaPayProvider, formatAmount, useFomaPay } from '@fomapay/react-native';
import React, { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text } from 'react-native';

export default function App() {
  return (
    <FomaPayProvider publicKey={process.env.EXPO_PUBLIC_FOMAPAY_PUBLIC_KEY ?? ''} apiUrl={process.env.EXPO_PUBLIC_FOMAPAY_API_URL}>
      <Shop />
    </FomaPayProvider>
  );
}

function Shop() {
  const { checkout } = useFomaPay();
  const [message, setMessage] = useState('');

  const pay = async () => {
    const payment = await checkout({ amount: 25000, currency: 'CDF', orderId: 'CMD-8921', description: 'Commande #CMD-8921' });
    // L'écran du client n'est pas une preuve : votre serveur confirme la commande par webhook.
    setMessage(payment ? `Payé : ${payment.reference}` : 'Paiement annulé');
  };

  return (
    <SafeAreaView style={styles.page}>
      <Text style={styles.title}>Dzoket Store</Text>
      <Pressable accessibilityRole="button" onPress={pay} style={styles.button}>
        <Text style={styles.buttonLabel}>Payer {formatAmount(25000, 'CDF')}</Text>
      </Pressable>
      <Text style={styles.message}>{message}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 24 },
  button: { backgroundColor: '#032B56', paddingHorizontal: 28, paddingVertical: 16, borderRadius: 14 },
  buttonLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  message: { marginTop: 20, fontSize: 15 },
});
