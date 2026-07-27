export type PasswordRequirement = {
  id: 'letter' | 'number' | 'special' | 'length'
  label: string
  met: boolean
}

export const passwordMaxLength = 128

export function getPasswordRequirements(password: string): PasswordRequirement[] {
  return [
    { id: 'letter', label: '영문 포함', met: /[A-Za-z]/.test(password) },
    { id: 'number', label: '숫자 포함', met: /\d/.test(password) },
    {
      id: 'special',
      label: '특수문자 포함',
      met: /[^A-Za-z0-9\s]/.test(password),
    },
    { id: 'length', label: '8자 이상', met: password.length >= 8 },
  ]
}

export function isPasswordValid(password: string) {
  return getPasswordRequirements(password).every(({ met }) => met)
}
