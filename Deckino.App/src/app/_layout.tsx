import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#208AEF',
          tabBarInactiveTintColor: '#6E6E76',
          tabBarStyle: {
            backgroundColor: '#000000',
            borderTopColor: '#1A1A1E',
          },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="scan" options={{ title: 'Scan' }} />
      </Tabs>
    </>
  );
}
