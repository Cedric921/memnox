import { describe, expect, it } from 'vitest';
import { enclosingNames, symbolsOfLines } from '../src/coordination/code-symbols';

const TS = [
  "import { Stripe } from 'stripe';", // 1
  '', // 2
  'export class PaymentService {', // 3
  '  private readonly retries = 3;', // 4
  '', // 5
  '  async retryCharge(', // 6
  '    id: string,', // 7
  '  ): Promise<void> {', // 8
  '    if (this.retries > 0) {', // 9
  '      await this.charge(id);', // 10
  '    }', // 11
  '  }', // 12
  '', // 13
  '  refund(id: string): void {', // 14
  '    this.charge(id);', // 15
  '  }', // 16
  '}', // 17
  '', // 18
  'export const retryLater = async (id: string) => {', // 19
  '  return id;', // 20
  '};', // 21
  '', // 22
  'export function audit(): void {', // 23
  '  // nothing yet', // 24
  '}', // 25
].join('\n');

describe('the declaration each line sits in', () => {
  const names = enclosingNames(TS);
  const at = (line: number) => names[line - 1];

  it('names a method by its class, including its signature and its closing brace', () => {
    expect(at(6)).toBe('PaymentService.retryCharge');
    expect(at(8)).toBe('PaymentService.retryCharge');
    expect(at(10)).toBe('PaymentService.retryCharge');
    expect(at(12)).toBe('PaymentService.retryCharge');
    expect(at(15)).toBe('PaymentService.refund');
  });

  it('names a field by its class, and never mistakes a call for a method', () => {
    expect(at(4)).toBe('PaymentService');
    expect(at(10)).not.toBe('PaymentService.retryCharge.charge');
  });

  it('names functions held in bindings, and plain functions', () => {
    expect(at(20)).toBe('retryLater');
    expect(at(24)).toBe('audit');
  });

  it('names nothing outside every declaration', () => {
    expect(at(1)).toBeNull();
    expect(at(18)).toBeNull();
  });

  it('reads Python by indentation', () => {
    const py = enclosingNames(
      [
        'class Billing:',
        '    def retry(self):',
        '        return 1',
        '',
        'def audit():',
        '    pass',
      ].join('\n'),
    );
    expect(py[2]).toBe('Billing.retry');
    expect(py[5]).toBe('audit');
  });

  it('reads Go and Rust', () => {
    const go = enclosingNames(
      ['func (s *Service) Retry() error {', '\treturn nil', '}'].join('\n'),
    );
    expect(go[1]).toBe('Retry');
    const rust = enclosingNames(
      [
        'impl Service {',
        '    pub fn retry(&self) {',
        '        todo!()',
        '    }',
        '}',
      ].join('\n'),
    );
    expect(rust[2]).toBe('Service.retry');
  });
});

describe('the names a set of changed lines touches', () => {
  it('names every declaration a range crosses', () => {
    expect(symbolsOfLines(TS, [{ from: 10, to: 15 }])).toEqual([
      'PaymentService.retryCharge',
      'PaymentService',
      'PaymentService.refund',
    ]);
  });

  it('names nothing where any changed line sits outside a declaration', () => {
    expect(symbolsOfLines(TS, [{ from: 1, to: 1 }])).toBeNull();
    expect(symbolsOfLines(TS, [{ from: 15, to: 18 }])).toBeNull();
  });
});
