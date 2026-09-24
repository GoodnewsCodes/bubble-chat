import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colorScheme as nwColorScheme } from 'nativewind';

// App-wide theming for the Expo (mobile) app. The app mixes NativeWind classes with a lot of
// inline hex + StyleSheet colors, so the single source of truth is a resolved `colors` object
// from useTheme() that screens use for inline styles / lucide `color=` props. We also flip
// NativeWind's color scheme so any `dark:` utility classes respond too.

export type Scheme = 'light' | 'dark' | 'system';

export interface ThemeColors {
  bg: string;
  card: string;
  surface: string;
  text: string;
  textSoft: string;
  border: string;
  borderStrong: string;
  purple: string;
  purpleSoft: string;
  danger: string;
  isDark: boolean;
}

export const LIGHT: ThemeColors = {
  bg: '#f8f7ff',
  card: '#ffffff',
  surface: '#f5f4fb',
  text: '#1f2030',
  textSoft: '#9a9aab',
  border: 'rgba(0,0,0,0.06)',
  borderStrong: 'rgba(0,0,0,0.10)',
  purple: '#6c5ce7',
  purpleSoft: 'rgba(108,92,231,0.08)',
  danger: '#ef4444',
  isDark: false,
};

export const DARK: ThemeColors = {
  bg: '#0f1018',
  card: '#1a1b28',
  surface: '#23243a',
  text: '#f4f5fb',
  textSoft: '#9a9bb6',
  border: 'rgba(255,255,255,0.09)',
  borderStrong: 'rgba(255,255,255,0.16)',
  purple: '#8b7cf0',
  purpleSoft: 'rgba(139,124,240,0.14)',
  danger: '#f87171',
  isDark: true,
};

const STORAGE_KEY = 'bubble_theme';

interface ThemeCtx {
  scheme: Scheme;
  isDark: boolean;
  colors: ThemeColors;
  setScheme: (s: Scheme) => void;
}

const ThemeContext = createContext<ThemeCtx>({
  scheme: 'light',
  isDark: false,
  colors: LIGHT,
  setScheme: () => {},
});

const resolveDark = (s: Scheme): boolean =>
  s === 'system' ? Appearance.getColorScheme() === 'dark' : s === 'dark';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [scheme, setSchemeState] = useState<Scheme>('light');
  const [isDark, setIsDark] = useState(false);

  const apply = useCallback((s: Scheme) => {
    const dark = resolveDark(s);
    setIsDark(dark);
    nwColorScheme.set(dark ? 'dark' : 'light');
  }, []);

  // Load the saved preference once at startup.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        const s = (saved as Scheme) || 'light';
        setSchemeState(s);
        apply(s);
      })
      .catch(() => apply('light'));
  }, [apply]);

  // When following the system, react to OS appearance changes.
  useEffect(() => {
    const sub = Appearance.addChangeListener(() => {
      if (scheme === 'system') apply('system');
    });
    return () => sub.remove();
  }, [scheme, apply]);

  const setScheme = useCallback(
    (s: Scheme) => {
      setSchemeState(s);
      apply(s);
      AsyncStorage.setItem(STORAGE_KEY, s).catch(() => {});
    },
    [apply]
  );

  return (
    <ThemeContext.Provider value={{ scheme, isDark, colors: isDark ? DARK : LIGHT, setScheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
