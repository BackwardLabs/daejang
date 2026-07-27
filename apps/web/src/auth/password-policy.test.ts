import { describe, expect, it } from 'vitest'
import { getPasswordRequirements, isPasswordValid } from './password-policy.ts'

describe('password policy', () => {
  it('requires a letter, number, special character, and at least eight characters', () => {
    expect(isPasswordValid('Password1!')).toBe(true)
    expect(isPasswordValid('password1')).toBe(false)
    expect(isPasswordValid('Password!')).toBe(false)
    expect(isPasswordValid('1234567!')).toBe(false)
    expect(isPasswordValid('Pass1!')).toBe(false)
  })

  it('reports each requirement independently for the progress meter', () => {
    expect(
      getPasswordRequirements('Password1!').map(({ id, met }) => [id, met]),
    ).toEqual([
      ['letter', true],
      ['number', true],
      ['special', true],
      ['length', true],
    ])
  })
})
