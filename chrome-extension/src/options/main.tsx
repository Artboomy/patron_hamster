import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { App } from './App';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

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

createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
