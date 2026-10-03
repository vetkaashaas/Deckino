import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { StatusBar } from 'expo-status-bar';

import { colors } from '@/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <NativeTabs
        backgroundColor={colors.background}
        indicatorColor={colors.purple}
        rippleColor="rgba(152, 29, 206, 0.24)"
        tintColor={colors.pink}
        iconColor={{ default: colors.textDim, selected: colors.text }}
        labelStyle={{
          default: { color: colors.textDim, fontSize: 12 },
          selected: { color: colors.text, fontSize: 12, fontWeight: '600' },
        }}
        labelVisibilityMode="labeled"
      >
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon
            sf={{ default: 'house', selected: 'house.fill' }}
            md="home"
          />
          <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="scan">
          <NativeTabs.Trigger.Icon sf="viewfinder" md="document_scanner" />
          <NativeTabs.Trigger.Label>Scan</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </>
  );
}
