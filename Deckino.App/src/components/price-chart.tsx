import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import type { PricePoint } from '@/api/cards';
import { formatPrice } from '@/components/card-visuals';
import { colors, type } from '@/theme';

const HEIGHT = 120;

/** Up to the last 90 days of one price (USD non-foil, else foil), as a line with its low and high. */
export function PriceChart({ points }: { points: PricePoint[] }) {
  const [width, setWidth] = useState(0);
  const key = points.some((p) => p.usd !== null) ? 'usd' : 'usdFoil';
  const values = points.flatMap((p) => (p[key] === null ? [] : [{ date: p.date, value: p[key]! }]));
  if (values.length < 2) {
    return <Text style={type.label}>Price history starts once Deckino has seen two days of prices.</Text>;
  }
  const low = Math.min(...values.map((v) => v.value));
  const high = Math.max(...values.map((v) => v.value));
  const span = high - low || 1;
  const x = (index: number) => (index / (values.length - 1)) * width;
  const y = (value: number) => 8 + (1 - (value - low) / span) * (HEIGHT - 16);
  const line = values.map((v, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(v.value).toFixed(1)}`).join(' ');
  const first = values[0].value;
  const last = values[values.length - 1].value;
  const change = first === 0 ? 0 : ((last - first) / first) * 100;
  return (
    <View
      accessible
      accessibilityLabel={`Price over ${values.length} days: from ${formatPrice(first, 'usd')} to ${formatPrice(last, 'usd')}, low ${formatPrice(low, 'usd')}, high ${formatPrice(high, 'usd')}`}
    >
      <View style={styles.header}>
        <Text style={type.label}>{values.length} days{key === 'usd' ? '' : ', foil'}</Text>
        <Text style={[type.label, { color: change >= 0 ? colors.success : colors.danger }]}>
          {change >= 0 ? '+' : ''}
          {change.toFixed(1)}%
        </Text>
      </View>
      <View style={{ height: HEIGHT }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            <Defs>
              <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.violet} stopOpacity={0.35} />
                <Stop offset="1" stopColor={colors.violet} stopOpacity={0} />
              </LinearGradient>
              <LinearGradient id="stroke" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={colors.purple} />
                <Stop offset="1" stopColor={colors.violet} />
              </LinearGradient>
            </Defs>
            <Path d={`${line} L${width},${HEIGHT} L0,${HEIGHT} Z`} fill="url(#fill)" />
            <Path d={line} stroke="url(#stroke)" strokeWidth={2.5} fill="none" strokeLinejoin="round" />
          </Svg>
        ) : null}
      </View>
      <View style={styles.header}>
        <Text style={type.caption}>Low {formatPrice(low, 'usd')}</Text>
        <Text style={type.caption}>High {formatPrice(high, 'usd')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 4 },
});
