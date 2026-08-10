import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BRAND, BRAND_TAGLINE } from '@loom/shared'
import App from './App'
import { LoomCanvas } from './components/LoomCanvas'
import { Toasts, TooltipProvider } from './components/overlay'
import { AuthProvider } from './state/auth'
import './index.css'

// the browser-tab title is driven by BRAND too (index.html holds a static
// placeholder that this overrides on load)
document.title = `${BRAND} — ${BRAND_TAGLINE}`

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LoomCanvas />
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
    <Toasts />
  </React.StrictMode>,
)
