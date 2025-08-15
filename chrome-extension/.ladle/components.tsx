import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import type { GlobalProvider } from '@ladle/react';

const theme = createTheme({
  shape: {
    borderRadius: 12
  },
  typography: {
    fontFamily: '"Segoe UI", "Helvetica Neue", sans-serif'
  },
  palette: {
    background: {
      default: '#f6f7fb'
    }
  }
});

export const Provider: GlobalProvider = ({ children }) => (
  <ThemeProvider theme={theme}>
    <CssBaseline />
    {children}
  </ThemeProvider>
);
