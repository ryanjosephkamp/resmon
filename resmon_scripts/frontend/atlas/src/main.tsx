import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource/spectral/300-italic.css';
import '@fontsource/spectral/400-italic.css';
import '@fontsource/spectral/500-italic.css';
import './theme/tokens.css';
import './atlas.css';
import { App } from './App';
import { keepBetweenVisits } from './screens/today/freshness';
import {
  APPEARANCE_KEY, AppearanceProvider, FALLBACK_APPEARANCE, applyAppearance, readAppearance,
} from './theme/appearance';

// One cache for the window. A failed read is retried once and then shown as a
// failure; it is never replaced by an empty result.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
keepBetweenVisits(queryClient);

async function start(root: HTMLElement): Promise<void> {
  // The stored appearance is read before anything is drawn, so the page never
  // opens in the other theme and then switches. It is one loopback request.
  // If the engine does not answer, the system's theme and the default accent
  // stand in, and the appearance query reports the failure when it retries.
  let appearance = FALLBACK_APPEARANCE;
  try {
    appearance = await readAppearance();
    queryClient.setQueryData(APPEARANCE_KEY, appearance);
  } catch {
    // Left to the query, which will ask again and show what it was told.
  }
  applyAppearance(appearance);
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppearanceProvider>
          <App />
        </AppearanceProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

const root = document.getElementById('root');
if (root) void start(root);
