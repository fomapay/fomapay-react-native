import qrcode from 'qrcode-generator';
import React, { useMemo } from 'react';
import { View } from 'react-native';

interface Props {
  value: string;
  /** Côté du QR code, en points. */
  size: number;
  color?: string;
}

/**
 * QR code dessiné avec de simples `View` : aucun module natif, donc compatible Expo Go.
 * Les modules sombres contigus d'une même ligne sont fusionnés pour limiter le nombre de vues.
 */
export function QrCode({ value, size, color = '#032B56' }: Props) {
  const rows = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const result: { start: number; length: number }[][] = [];
    for (let row = 0; row < count; row++) {
      const runs: { start: number; length: number }[] = [];
      for (let col = 0; col < count; col++) {
        if (!qr.isDark(row, col)) continue;
        const last = runs[runs.length - 1];
        if (last && last.start + last.length === col) last.length++;
        else runs.push({ start: col, length: 1 });
      }
      result.push(runs);
    }
    return result;
  }, [value]);

  // Taille de module entière : pas de liseré entre les modules sur les écrans à faible densité.
  const module = Math.max(1, Math.floor(size / rows.length));
  const side = module * rows.length;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel="QR code de paiement" style={{ width: side, height: side }}>
      {rows.map((runs, row) => (
        <View key={row} style={{ height: module, width: side }}>
          {runs.map((run) => (
            <View
              key={run.start}
              style={{ position: 'absolute', left: run.start * module, width: run.length * module, height: module, backgroundColor: color }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
