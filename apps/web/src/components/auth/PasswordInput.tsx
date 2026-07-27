import { useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import {
  getPasswordRequirements,
  passwordMaxLength,
} from '../../auth/password-policy.ts'

type PasswordInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'type' | 'value'
> & {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  showRequirements?: boolean
}

export function PasswordInput({
  id,
  label,
  value,
  onChange,
  showRequirements = false,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  const requirements = getPasswordRequirements(value)

  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password-control">
        <input
          {...props}
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          maxLength={passwordMaxLength}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="auth-password-toggle"
          aria-label={visible ? `${label} 숨기기` : `${label} 보기`}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? '숨김' : '보기'}
        </button>
      </div>
      {showRequirements ? (
        <div
          className="auth-password-requirements"
          role="group"
          aria-label="비밀번호 요건"
        >
          <div className="auth-password-meter" aria-hidden="true">
            {requirements.map(({ id: requirementId, met }) => (
              <span
                className={met ? 'auth-password-meter__met' : undefined}
                key={requirementId}
              />
            ))}
          </div>
          <p>영문, 숫자, 특수문자를 조합해 8자 이상 입력</p>
          <span className="sr-only">
            {requirements
              .map(({ label: requirementLabel, met }) =>
                `${requirementLabel} ${met ? '충족' : '미충족'}`,
              )
              .join(', ')}
          </span>
        </div>
      ) : null}
    </div>
  )
}
