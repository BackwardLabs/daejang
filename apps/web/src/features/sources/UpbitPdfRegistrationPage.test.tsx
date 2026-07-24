import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UpbitPdfRegistrationPage } from './UpbitPdfRegistrationPage.tsx'
import type {
  RegisterUpbitPdf,
  UpbitPdfRegistrationResult,
} from './upbitPdfRegistration.ts'

function selectFile(file: File) {
  fireEvent.change(
    screen.getByLabelText('Upbit 거래내역서 PDF 선택'),
    {
      target: { files: [file] },
    },
  )
}

function storedText(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)
    return key ? `${key}:${storage.getItem(key)}` : ''
  }).join('|')
}

function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve: resolvePromise,
  }
}

describe('UpbitPdfRegistrationPage', () => {
  it('passes an optional password only to the adapter and never persists sensitive input', async () => {
    const pdf = new File(['%PDF-1.7\ntransaction'], 'upbit-2027.pdf', {
      type: 'application/pdf',
    })
    const pdfPassword = '  private pdf 암호  '
    let submittedFile: File | null = null
    let submittedPassword: string | null = null
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = async ({
      file,
      onStageChange,
      password,
    }) => {
      registrationCalls += 1
      submittedFile = file
      submittedPassword = password
      onStageChange('DOCUMENT_UPLOADING')
      onStageChange('SOURCE_SUBMITTING')

      return {
        ok: true,
        sourceId: 'source-upbit-2027',
        sourceStatus: 'SOURCE_SAVED',
      }
    }

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)

    expect(
      screen.getByRole('heading', { name: 'Upbit PDF 등록' }),
    ).toBeInTheDocument()

    selectFile(pdf)

    expect(
      screen.getByRole('heading', { name: '등록 정보 확인' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '선택한 파일을 확인하세요' }),
    ).toHaveFocus()
    expect(screen.getByText('upbit-2027.pdf')).toBeInTheDocument()
    const passwordInput = screen.getByLabelText(/PDF 비밀번호/)
    expect(passwordInput).toHaveAttribute('type', 'password')
    expect(passwordInput).toHaveAttribute('autocomplete', 'off')
    expect(passwordInput).toHaveValue('')

    fireEvent.change(passwordInput, {
      target: { value: pdfPassword },
    })

    expect(document.body).not.toHaveTextContent(pdfPassword)
    expect(storedText(window.localStorage)).not.toContain(pdf.name)
    expect(storedText(window.sessionStorage)).not.toContain(pdf.name)
    expect(storedText(window.localStorage)).not.toContain(pdfPassword)
    expect(storedText(window.sessionStorage)).not.toContain(pdfPassword)
    expect(window.location.href).not.toContain(encodeURIComponent(pdfPassword))

    fireEvent.click(
      screen.getByRole('button', { name: 'Upbit PDF 등록' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Upbit 데이터 소스를 등록했어요',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: 'Upbit 데이터 소스를 등록했어요',
      }),
    ).toHaveFocus()
    expect(screen.getByText('SOURCE_SAVED')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '조회 기간 설정' }),
    ).toHaveAttribute(
      'href',
      '/app/sources/source-upbit-2027/period',
    )
    expect(registrationCalls).toBe(1)
    expect(submittedFile).toBe(pdf)
    expect(submittedPassword).toBe(pdfPassword)
    expect(screen.queryByDisplayValue(pdfPassword)).not.toBeInTheDocument()
    expect(storedText(window.localStorage)).not.toContain(pdf.name)
    expect(storedText(window.sessionStorage)).not.toContain(pdf.name)
    expect(storedText(window.localStorage)).not.toContain(pdfPassword)
    expect(storedText(window.sessionStorage)).not.toContain(pdfPassword)
    expect(window.location.href).not.toContain(encodeURIComponent(pdfPassword))
  })

  it('submits null when the optional PDF password is blank', async () => {
    let submittedPassword: string | null | 'not-called' = 'not-called'
    const registerPdf: RegisterUpbitPdf = async ({ password }) => {
      submittedPassword = password
      return {
        ok: true,
        sourceId: 'source-upbit-no-password',
        sourceStatus: 'SOURCE_SAVED',
      }
    }

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)
    selectFile(
      new File(['%PDF-1.7'], 'upbit-history.pdf', {
        type: 'application/pdf',
      }),
    )

    expect(screen.getByLabelText(/PDF 비밀번호/)).toHaveValue('')
    fireEvent.click(
      screen.getByRole('button', { name: 'Upbit PDF 등록' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Upbit 데이터 소스를 등록했어요',
      }),
    ).toBeInTheDocument()
    expect(submittedPassword).toBeNull()
  })

  it('does not restore a password after returning to file selection', () => {
    render(<UpbitPdfRegistrationPage />)
    selectFile(
      new File(['%PDF-1.7'], 'upbit-history.pdf', {
        type: 'application/pdf',
      }),
    )

    fireEvent.change(screen.getByLabelText(/PDF 비밀번호/), {
      target: { value: 'discard-on-back' },
    })
    fireEvent.click(screen.getByRole('button', { name: '이전' }))
    fireEvent.click(
      screen.getByRole('button', { name: '등록 정보 확인' }),
    )

    expect(screen.getByLabelText(/PDF 비밀번호/)).toHaveValue('')
    expect(document.body).not.toHaveTextContent('discard-on-back')
    expect(storedText(window.localStorage)).not.toContain('discard-on-back')
    expect(storedText(window.sessionStorage)).not.toContain('discard-on-back')
  })

  it('rejects a non-PDF before registration', () => {
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = async () => {
      registrationCalls += 1
      return {
        ok: true,
        sourceId: 'unexpected-source',
        sourceStatus: 'SOURCE_SAVED',
      }
    }

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)
    selectFile(
      new File(['date,asset'], 'upbit-history.csv', {
        type: 'text/csv',
      }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'PDF 파일만 등록할 수 있어요',
    )
    expect(
      screen.getByRole('heading', { name: 'Upbit PDF 등록' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Upbit PDF 등록' }),
    ).not.toBeInTheDocument()
    expect(registrationCalls).toBe(0)
  })

  it('focuses an empty password field after PASSWORD_INVALID and retries the same intent', async () => {
    const passwords: Array<string | null> = []
    const intentKeys: string[] = []
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = async ({
      intentKey,
      password,
    }) => {
      registrationCalls += 1
      intentKeys.push(intentKey)
      passwords.push(password)

      if (registrationCalls === 1) {
        return {
          error: {
            code: 'PASSWORD_INVALID',
            requestId: 'request-safe-2',
          },
          ok: false,
        }
      }

      return {
        ok: true,
        sourceId: 'source-upbit-password-corrected',
        sourceStatus: 'SOURCE_SAVED',
      }
    }

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)
    selectFile(
      new File(['%PDF-1.7'], 'encrypted-history.pdf', {
        type: 'application/pdf',
      }),
    )
    const passwordInput = screen.getByLabelText(/PDF 비밀번호/)
    fireEvent.change(passwordInput, {
      target: { value: 'wrong-password' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Upbit PDF 등록' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('PDF 비밀번호가 올바르지 않아요')
    expect(alert).toHaveTextContent('request-safe-2')
    const retryPasswordInput = screen.getByLabelText(/PDF 비밀번호/)
    expect(retryPasswordInput).toHaveValue('')
    expect(retryPasswordInput).toHaveFocus()
    expect(retryPasswordInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('encrypted-history.pdf')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '다른 PDF 선택' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '비밀번호로 다시 등록' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('wrong-password')
    expect(storedText(window.localStorage)).not.toContain('wrong-password')
    expect(storedText(window.sessionStorage)).not.toContain('wrong-password')
    expect(window.location.href).not.toContain('wrong-password')

    fireEvent.change(retryPasswordInput, {
      target: { value: 'correct-password' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: '비밀번호로 다시 등록' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Upbit 데이터 소스를 등록했어요',
      }),
    ).toBeInTheDocument()
    expect(passwords).toEqual(['wrong-password', 'correct-password'])
    expect(intentKeys[0]).toBe(intentKeys[1])
  })

  it('prevents double submission while the registration request is pending', async () => {
    const deferred = createDeferred<UpbitPdfRegistrationResult>()
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = ({ onStageChange }) => {
      registrationCalls += 1
      onStageChange('DOCUMENT_UPLOADING')
      return deferred.promise
    }

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)
    selectFile(
      new File(['%PDF-1.7'], 'upbit-history.pdf', {
        type: 'application/pdf',
      }),
    )

    const submitButton = screen.getByRole('button', {
      name: 'Upbit PDF 등록',
    })
    fireEvent.click(submitButton)
    fireEvent.click(submitButton)

    expect(registrationCalls).toBe(1)
    expect(
      screen.getByRole('button', { name: '등록 중…' }),
    ).toBeDisabled()

    await act(async () => {
      deferred.resolve({
        ok: true,
        sourceId: 'source-upbit-once',
        sourceStatus: 'SOURCE_SAVED',
      })
      await deferred.promise
    })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Upbit 데이터 소스를 등록했어요',
        }),
      ).toBeInTheDocument()
    })
    expect(registrationCalls).toBe(1)
  })

  it('cancels an upload while preserving the file and intent for retry', async () => {
    const intentKeys: string[] = []
    const passwords: Array<string | null> = []
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = ({
      intentKey,
      password,
      signal,
    }) => {
      registrationCalls += 1
      intentKeys.push(intentKey)
      passwords.push(password)

      if (registrationCalls === 1) {
        return new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                error: { code: 'UPLOAD_FAILED' },
                ok: false,
              }),
            { once: true },
          )
        })
      }

      return Promise.resolve({
        ok: true,
        sourceId: 'source-upbit-after-retry',
        sourceStatus: 'SOURCE_SAVED',
      })
    }

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)
    selectFile(
      new File(['%PDF-1.7'], 'upbit-history.pdf', {
        type: 'application/pdf',
      }),
    )
    fireEvent.change(screen.getByLabelText(/PDF 비밀번호/), {
      target: { value: 'cancelled-password' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Upbit PDF 등록' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '업로드 취소' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PDF 업로드를 취소했어요',
    )
    expect(screen.getByText('upbit-history.pdf')).toBeInTheDocument()
    expect(screen.getByLabelText(/PDF 비밀번호/)).toHaveValue('')
    expect(document.body).not.toHaveTextContent('cancelled-password')

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))

    expect(
      await screen.findByRole('heading', {
        name: 'Upbit 데이터 소스를 등록했어요',
      }),
    ).toBeInTheDocument()
    expect(registrationCalls).toBe(2)
    expect(intentKeys[0]).toBe(intentKeys[1])
    expect(passwords).toEqual(['cancelled-password', null])
  })
})
