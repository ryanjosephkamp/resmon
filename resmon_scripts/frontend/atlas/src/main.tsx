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
import './shell/windowFrame.css';
import { App } from './App';
import { COLLECTIONS_KEY, CollectionProvider, readCollections } from './collections/current';
import { keepBetweenVisits } from './screens/today/freshness';
import { TOP_BAR_KEY, readTopBar } from './shell/useTopBar';
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
  //
  // The top bar's arrangement and the collection the window shows are read
  // beside it, so a window opens on the start page with its own bar, and its
  // first screen reads its own collection rather than the default one first.
  let appearance = FALLBACK_APPEARANCE;
  const collections = queryClient.prefetchQuery({ queryKey: COLLECTIONS_KEY, queryFn: readCollections });
  const [look, bar] = await Promise.allSettled([readAppearance(), readTopBar()]);
  if (look.status === 'fulfilled') {
    appearance = look.value;
    queryClient.setQueryData(APPEARANCE_KEY, appearance);
  }
  // One that did not answer is left to its query, which will ask again and show what it was told.
  if (bar.status === 'fulfilled') queryClient.setQueryData(TOP_BAR_KEY, bar.value);
  await collections;
  applyAppearance(appearance);
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppearanceProvider>
          <CollectionProvider>
            <App />
          </CollectionProvider>
        </AppearanceProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

const root = document.getElementById('root');
if (root) void start(root);
