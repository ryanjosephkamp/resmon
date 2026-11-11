import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CountField } from '../CountField';

function Holder({ start = 10, onValue }: { start?: number; onValue?: (n: number) => void }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <CountField min={1} max={1000} value={value} aria-label="Most papers per source"
        onValue={(n) => { setValue(n); onValue?.(n); }} />
      <output data-testid="stored">{value}</output>
    </>
  );
}

describe('a count typed freely', () => {
  test('emptied, it stays empty, and the number typed next is the one stored', () => {
    render(<Holder />);
    const field = screen.getByRole('spinbutton', { name: 'Most papers per source' });
    fireEvent.change(field, { target: { value: '' } });
    expect(field).toHaveValue(null);
    expect(screen.getByTestId('stored')).toHaveTextContent('10');
    fireEvent.change(field, { target: { value: '5' } });
    expect(field).toHaveValue(5);
    expect(screen.getByTestId('stored')).toHaveTextContent('5');
  });

  test('left empty, it shows what is stored; past either end, it is taken to that end', () => {
    render(<Holder />);
    const field = screen.getByRole('spinbutton', { name: 'Most papers per source' });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(field).toHaveValue(10);
    fireEvent.change(field, { target: { value: '5000' } });
    expect(screen.getByTestId('stored')).toHaveTextContent('10');
    fireEvent.blur(field);
    expect(field).toHaveValue(1000);
    expect(screen.getByTestId('stored')).toHaveTextContent('1000');
  });
});
