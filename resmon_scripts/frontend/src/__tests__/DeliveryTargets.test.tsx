/**
 * The routine's Delivery list, with the two destinations PR two adds.
 *
 * What these establish is the part a screen can get wrong on its own: that all
 * four channels the backend says it ships are offered (the list is the
 * backend's, not a copy of it here), that a webhook's inline choice is written
 * into the target text in the form the backend reads back, and that a webhook
 * secret leaves through the credentials route and never through the target.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import DeliveryTargets from '../components/Routines/DeliveryTargets';
import { callsTo, mockRoutedFetch, renderWithProviders } from './testUtils';

const SHIPPED = ['email', 'folder', 'webhook', 'feed'];

const TARGETS = {
  routine_id: 1,
  shipped_channels: SHIPPED,
  targets: [
    { id: 7, channel: 'webhook', target: 'https://example.org/hook', enabled: 1, mode: 'automatic' },
    { id: 8, channel: 'feed', target: '/Users/you/Sites', enabled: 1, mode: 'automatic' },
  ],
};

const ROUTES = {
  '/api/routines/1/delivery-targets': TARGETS,
  '/api/credentials': { credentials: { webhook_secret_7: { present: true, status: 'present' } } },
};

describe('DeliveryTargets', () => {
  test('offers every channel the backend says it ships, and no others', async () => {
    mockRoutedFetch(ROUTES);
    await renderWithProviders(<DeliveryTargets routineId={1} />);

    const picker = screen.getByLabelText('Destination type') as HTMLSelectElement;
    const offered = Array.from(picker.options).map((o) => o.value);
    expect(offered).toEqual(SHIPPED);
    expect(offered).toHaveLength(4);
    expect(picker.options[2].text).toBe('Webhook (https)');
    expect(picker.options[3].text).toBe('Feed file (Atom)');
  });

  test('shows a webhook by its URL and whether a secret is saved, never the secret', async () => {
    mockRoutedFetch(ROUTES);
    await renderWithProviders(<DeliveryTargets routineId={1} />);

    expect(screen.getByText('https://example.org/hook')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('delivery-secret-state-7')).toHaveTextContent('secret saved'));
    // Presence only: nothing on this screen ever holds the value.
    const box = screen.getByLabelText('Shared secret for this webhook') as HTMLInputElement;
    expect(box.type).toBe('password');
    expect(box.value).toBe('');
  });

  test('a webhook secret is sent to the credentials route, not to the target', async () => {
    const mock = mockRoutedFetch({
      ...ROUTES,
      '/api/credentials/webhook_secret_7': { success: true },
    });
    await renderWithProviders(<DeliveryTargets routineId={1} />);

    fireEvent.change(screen.getByLabelText('Shared secret for this webhook'),
                     { target: { value: 'shared-not-real' } });
    fireEvent.click(screen.getByTestId('delivery-secret-save-7'));

    await waitFor(() => expect(callsTo(mock, '/api/credentials/webhook_secret_7')).toHaveLength(1));
    const call = callsTo(mock, '/api/credentials/webhook_secret_7')[0];
    expect(call.init?.method).toBe('PUT');
    expect(JSON.parse(String(call.init?.body))).toEqual({ value: 'shared-not-real' });
    // And nowhere else.
    const others = mock.mock.calls
      .map(([, init]: [unknown, RequestInit?]) => String(init?.body || ''))
      .filter((body) => body.includes('shared-not-real'));
    expect(others).toHaveLength(1);
  });

  test('the inline choice is written into the webhook target the backend reads', async () => {
    const mock = mockRoutedFetch(ROUTES);
    await renderWithProviders(<DeliveryTargets routineId={1} />);

    fireEvent.change(screen.getByLabelText('Destination type'), { target: { value: 'webhook' } });
    fireEvent.change(screen.getByLabelText('Address or folder'),
                     { target: { value: 'https://example.org/second' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('delivery-target-add'));

    await waitFor(() => {
      const posts = callsTo(mock, '/api/routines/1/delivery-targets')
        .filter((c) => c.init?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0].init?.body))).toEqual({
        channel: 'webhook',
        target: JSON.stringify({ url: 'https://example.org/second', inline: true }),
        mode: 'automatic',
      });
    });
  });

  test('a plain webhook is stored as the bare URL', async () => {
    const mock = mockRoutedFetch(ROUTES);
    await renderWithProviders(<DeliveryTargets routineId={1} />);

    fireEvent.change(screen.getByLabelText('Destination type'), { target: { value: 'webhook' } });
    fireEvent.change(screen.getByLabelText('Address or folder'),
                     { target: { value: 'https://example.org/plain' } });
    fireEvent.click(screen.getByTestId('delivery-target-add'));

    await waitFor(() => {
      const posts = callsTo(mock, '/api/routines/1/delivery-targets')
        .filter((c) => c.init?.method === 'POST');
      expect(JSON.parse(String(posts[0].init?.body)).target).toBe('https://example.org/plain');
    });
  });
});
