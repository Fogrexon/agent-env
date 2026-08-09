import { Theme } from '@carbon/react';
import type { ReactNode } from 'react';

/** Thin Carbon theme wrapper — g10 for content surfaces. */
export function AdminThemeProvider({ children }: { children: ReactNode }) {
  return <Theme theme="g10">{children}</Theme>;
}
