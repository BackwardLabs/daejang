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
  it('reviews a valid PDF, saves the source, and never persists the file or filename', async () => {
    const pdf = new File(['%PDF-1.7\ntransaction'], 'upbit-2027.pdf', {
      type: 'application/pdf',
    })
    let submittedFile: File | null = null
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = async ({
      file,
      onStageChange,
    }) => {
      registrationCalls += 1
      submittedFile = file
      onStageChange('DOCUMENT_UPLOADING')
      onStageChange('SOURCE_SUBMITTING')

      return {
        ok: true,
        sourceId: 'source-upbit-2027',
        sourceStatus: 'UPLOADED',
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
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(
      screen.queryByLabelText(/PDF 비밀번호|파일 암호|비밀번호/),
    ).not.toBeInTheDocument()
    expect(storedText(window.localStorage)).not.toContain(pdf.name)
    expect(storedText(window.sessionStorage)).not.toContain(pdf.name)

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
    expect(screen.getByText('UPLOADED')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '조회 기간 설정' }),
    ).toBeDisabled()
    expect(registrationCalls).toBe(1)
    expect(submittedFile).toBe(pdf)
    expect(storedText(window.localStorage)).not.toContain(pdf.name)
    expect(storedText(window.sessionStorage)).not.toContain(pdf.name)
  })

  it('rejects a non-PDF before registration', () => {
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = async () => {
      registrationCalls += 1
      return {
        ok: true,
        sourceId: 'unexpected-source',
        sourceStatus: 'UPLOADED',
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

  it('renders the fixed encrypted-document recovery without asking for a password', async () => {
    const registerPdf: RegisterUpbitPdf = async () => ({
      error: {
        code: 'ENCRYPTED_OR_DAMAGED_DOCUMENT',
        requestId: 'request-safe-2',
      },
      ok: false,
    })

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)
    selectFile(
      new File(['%PDF-1.7'], 'encrypted-history.pdf', {
        type: 'application/pdf',
      }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Upbit PDF 등록' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('PDF를 열어 확인할 수 없어요')
    expect(alert).toHaveTextContent('request-safe-2')
    expect(
      screen.getByRole('button', { name: '다른 PDF 선택' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '다시 시도' }),
    ).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"]')).toBeNull()
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
        sourceStatus: 'UPLOADED',
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
    let registrationCalls = 0
    const registerPdf: RegisterUpbitPdf = ({
      intentKey,
      signal,
    }) => {
      registrationCalls += 1
      intentKeys.push(intentKey)

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
        sourceStatus: 'UPLOADED',
      })
    }

    render(<UpbitPdfRegistrationPage registerPdf={registerPdf} />)
    selectFile(
      new File(['%PDF-1.7'], 'upbit-history.pdf', {
        type: 'application/pdf',
      }),
    )
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

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))

    expect(
      await screen.findByRole('heading', {
        name: 'Upbit 데이터 소스를 등록했어요',
      }),
    ).toBeInTheDocument()
    expect(registrationCalls).toBe(2)
    expect(intentKeys[0]).toBe(intentKeys[1])
  })
})
