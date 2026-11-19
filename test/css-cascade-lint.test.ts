import { describe, expect, it } from 'vitest'

import { findImplicitFlexAxisLeaks } from '../scripts/lint-css-cascade.js'

describe('CSS cascade lint', () => {
  it('rejects a column-flex theme override that inherits old cross-axis alignment', () => {
    const findings = findImplicitFlexAxisLeaks(
      `
      .rail {
        display: grid;
        align-items: center;
      }

      .rail {
        display: flex;
        flex-direction: column;
      }
      `,
      'theme.css',
    )

    expect(findings).toEqual([
      'theme.css: .rail changes to column flex without resetting align-items (currently center)',
    ])
  })

  it('accepts an explicit cross-axis reset in the overriding rule', () => {
    expect(
      findImplicitFlexAxisLeaks(
        `
        .rail {
          display: grid;
          align-items: center;
        }

        .rail {
          display: flex;
          align-items: stretch;
          flex-direction: column;
        }
        `,
        'theme.css',
      ),
    ).toEqual([])
  })

  it('does not combine rules across an at-rule boundary', () => {
    expect(
      findImplicitFlexAxisLeaks(
        `
        .rail {
          align-items: center;
        }

        @media (max-width: 40rem) {
          .rail {
            display: flex;
            flex-direction: column;
          }
        }
        `,
        'theme.css',
      ),
    ).toEqual([])
  })
})
