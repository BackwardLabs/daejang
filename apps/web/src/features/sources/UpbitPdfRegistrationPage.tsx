import {
  useEffect,
  useReducer,
  useRef,
  type ChangeEvent,
  type DragEvent,
  type RefObject,
} from 'react'
import pdfStepActive from '../../assets/sources/pdf-step-active.svg'
import pdfStepComplete from '../../assets/sources/pdf-step-complete.svg'
import pdfStepInactive from '../../assets/sources/pdf-step-inactive.svg'
import registrationComplete from '../../assets/sources/registration-complete.svg'
import upbitLogo from '../../assets/sources/upbit-logo.png'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import {
  createUpbitPdfIntentKey,
  formatPdfFileSize,
  initialUpbitPdfRegistrationState,
  registerUpbitPdfMock,
  upbitPdfRegistrationReducer,
  validateUpbitPdfFile,
  type RegisterUpbitPdf,
  type UpbitPdfRegistrationError,
  type UpbitPdfRegistrationErrorCode,
  type UpbitPdfRegistrationState,
  type UpbitPdfSelectionError,
  type UpbitPdfSelectionErrorCode,
} from './upbitPdfRegistration.ts'
import './upbit-pdf-flow.css'

const registrationSteps = ['PDF 선택', '등록 정보 확인', '등록 완료'] as const

const selectionErrorCopy: Record<
  UpbitPdfSelectionErrorCode,
  { body: string; title: string }
> = {
  EMPTY_FILE: {
    body: '내용이 없는 파일은 등록할 수 없습니다. 거래내역이 포함된 PDF를 선택해 주세요.',
    title: '빈 PDF는 등록할 수 없어요',
  },
  FILE_COUNT: {
    body: 'Upbit 거래내역서 PDF를 한 번에 하나씩 선택해 주세요.',
    title: 'PDF 한 개만 선택해 주세요',
  },
  FILE_REQUIRED: {
    body: '등록할 Upbit 거래내역서 PDF를 먼저 선택해 주세요.',
    title: 'PDF 파일이 필요해요',
  },
  FILE_TYPE: {
    body: '현재 단계에서는 .pdf 확장자의 Upbit 거래내역서만 선택할 수 있습니다.',
    title: 'PDF 파일만 등록할 수 있어요',
  },
}

const registrationErrorCopy: Record<
  UpbitPdfRegistrationErrorCode,
  {
    body: string
    recovery: 'manage-or-replace' | 'password' | 'replace' | 'retry'
    title: string
  }
> = {
  DUPLICATE_SOURCE: {
    body: '같은 내용의 PDF가 이미 이 workspace에 등록되어 있습니다. 기존 소스를 확인하거나 다른 파일을 선택해 주세요.',
    recovery: 'manage-or-replace',
    title: '이미 등록된 PDF예요',
  },
  ENCRYPTED_OR_DAMAGED_DOCUMENT: {
    body: '파일이 손상되었거나 서버에서 해독할 수 없습니다. 정상적으로 열리는 다른 PDF를 선택해 주세요.',
    recovery: 'replace',
    title: 'PDF를 열어 확인할 수 없어요',
  },
  PASSWORD_INVALID: {
    body: '입력한 비밀번호를 확인한 뒤 다시 입력해 주세요. 선택한 파일은 유지됩니다.',
    recovery: 'password',
    title: 'PDF 비밀번호가 올바르지 않아요',
  },
  PROCESSING_FAILED: {
    body: '문서를 확인하는 동안 일시적인 문제가 발생했습니다. 선택한 파일을 유지한 채 다시 시도할 수 있습니다.',
    recovery: 'retry',
    title: 'PDF 확인을 완료하지 못했어요',
  },
  UNSUPPORTED_DOCUMENT: {
    body: '지원되는 Upbit 거래내역서인지 확인한 뒤 올바른 PDF로 교체해 주세요.',
    recovery: 'replace',
    title: '지원하지 않는 문서예요',
  },
  UPLOAD_FAILED: {
    body: '파일을 안전한 저장소로 전송하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    recovery: 'retry',
    title: 'PDF 업로드에 실패했어요',
  },
  UPLOAD_CANCELLED: {
    body: '선택한 파일은 이 화면에 유지됩니다. 준비가 되면 같은 등록 요청으로 다시 시도할 수 있습니다.',
    recovery: 'retry',
    title: 'PDF 업로드를 취소했어요',
  },
}

function getCurrentStep(state: UpbitPdfRegistrationState) {
  if (state.view === 'complete') {
    return 3
  }

  if (state.view === 'review' || state.view === 'submitting') {
    return 2
  }

  return 1
}

function PdfRegistrationStepper({ currentStep }: { currentStep: number }) {
  return (
    <nav className="pdf-registration-stepper" aria-label="PDF 등록 단계">
      <ol>
        {registrationSteps.map((label, index) => {
          const step = index + 1
          const state =
            step < currentStep
              ? 'complete'
              : step === currentStep
                ? 'active'
                : 'inactive'
          const icon =
            state === 'complete'
              ? pdfStepComplete
              : state === 'active'
                ? pdfStepActive
                : pdfStepInactive

          return (
            <li
              key={label}
              className={`pdf-registration-stepper__item pdf-registration-stepper__item--${state}`}
              aria-current={state === 'active' ? 'step' : undefined}
            >
              <span className="pdf-registration-stepper__marker">
                <img src={icon} alt="" />
                <span aria-hidden="true">
                  {state === 'complete' ? '✓' : step}
                </span>
              </span>
              <strong>{label}</strong>
              <span className="pdf-registration-stepper__state">
                {state === 'complete'
                  ? '완료'
                  : state === 'active'
                    ? '진행 중'
                    : '대기'}
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function SelectionErrorNotice({
  error,
}: {
  error: UpbitPdfSelectionError
}) {
  const copy = selectionErrorCopy[error.code]

  return (
    <div id="upbit-pdf-selection-error" className="pdf-error-notice" role="alert">
      <span className="pdf-error-notice__icon" aria-hidden="true">
        !
      </span>
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
      </div>
    </div>
  )
}

function RegistrationErrorNotice({
  error,
}: {
  error: UpbitPdfRegistrationError
}) {
  const copy = registrationErrorCopy[error.code]

  return (
    <div
      id="upbit-pdf-registration-error"
      className="pdf-error-notice pdf-error-notice--registration"
      role="alert"
    >
      <span className="pdf-error-notice__icon" aria-hidden="true">
        !
      </span>
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
        {error.requestId ? (
          <span className="pdf-error-notice__request">
            요청 ID: {error.requestId}
          </span>
        ) : null}
        {copy.recovery === 'manage-or-replace' ? (
          <div className="pdf-error-notice__actions">
            <a href="/sources">기존 소스 확인</a>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FileSummary({
  name,
  size,
}: {
  name: string
  size: number
}) {
  return (
    <div className="pdf-file-summary">
      <span className="pdf-file-summary__icon" aria-hidden="true">
        PDF
      </span>
      <div>
        <strong>{name}</strong>
        <span>{formatPdfFileSize(size)} · PDF</span>
      </div>
    </div>
  )
}

function PdfSelectionStep({
  error,
  file,
  onContinue,
  onFilesSelected,
}: {
  error: UpbitPdfSelectionError | null
  file: File | null
  onContinue: () => void
  onFilesSelected: (files: FileList | null) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    onFilesSelected(event.currentTarget.files)
    event.currentTarget.value = ''
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    onFilesSelected(event.dataTransfer.files)
  }

  return (
    <div className="pdf-registration-grid">
      <section className="pdf-registration-card" aria-labelledby="pdf-select-title">
        <div className="pdf-registration-card__heading">
          <span>STEP 01</span>
          <div>
            <h2 id="pdf-select-title" tabIndex={-1}>
              거래내역서 PDF를 선택하세요
            </h2>
            <p>선택한 파일은 이 등록 화면의 메모리에만 유지됩니다.</p>
          </div>
        </div>

        {error ? <SelectionErrorNotice error={error} /> : null}

        <div
          className={`pdf-drop-zone${error ? ' pdf-drop-zone--error' : ''}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <span className="pdf-drop-zone__icon" aria-hidden="true">
            ↑
          </span>
          <label className="pdf-drop-zone__label" htmlFor="upbit-pdf-file">
            PDF를 여기로 끌어오거나 파일을 선택하세요
          </label>
          <p>Upbit 거래내역서 PDF 1개</p>
          <input
            ref={fileInputRef}
            id="upbit-pdf-file"
            className="pdf-registration__file-input"
            type="file"
            tabIndex={-1}
            accept=".pdf,application/pdf"
            aria-label="Upbit 거래내역서 PDF 선택"
            aria-describedby={error ? 'upbit-pdf-selection-error' : undefined}
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="pdf-secondary-action pdf-drop-zone__button"
            onClick={() => fileInputRef.current?.click()}
          >
            {file ? '다른 파일 선택' : '파일 선택'}
          </button>
        </div>

        {file ? (
          <div className="pdf-selection-resume">
            <FileSummary name={file.name} size={file.size} />
            <button
              type="button"
              className="source-primary-action"
              onClick={onContinue}
            >
              등록 정보 확인 <span aria-hidden="true">→</span>
            </button>
          </div>
        ) : null}
      </section>

      <aside className="pdf-registration-aside" aria-label="PDF 등록 기준">
        <span className="pdf-registration-aside__eyebrow">UPLOAD CHECKLIST</span>
        <h2>등록 전에 확인해 주세요</h2>
        <ul>
          <li>
            <span aria-hidden="true">01</span>
            <div>
              <strong>Upbit 거래내역서</strong>
              <p>입출금 증명서가 아닌 거래내역서 PDF를 준비합니다.</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">02</span>
            <div>
              <strong>파일이 열리는지 확인</strong>
              <p>손상된 PDF는 등록할 수 없습니다.</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">03</span>
            <div>
              <strong>최신 거래내역</strong>
              <p>새 거래가 생기면 최신 PDF를 다시 등록합니다.</p>
            </div>
          </li>
        </ul>
        <div className="pdf-registration-aside__password-note">
          <span>선택</span>
          <div>
            <strong>암호화된 PDF</strong>
            <p>
              다음 단계에서 비밀번호를 입력할 수 있으며, 입력값은 저장하지
              않습니다.
            </p>
          </div>
        </div>
        <div className="pdf-registration-aside__note">
          <strong>등록 후 처리</strong>
          <p>
            파일은 비공개 저장소로 전송되고 서버 확인에 성공한 뒤에만
            데이터 소스로 저장됩니다.
          </p>
        </div>
      </aside>
    </div>
  )
}

function PdfReviewStep({
  error,
  file,
  isSubmitting,
  onBack,
  onCancel,
  onReplace,
  onSubmit,
  passwordInputRef,
  status,
}: {
  error: UpbitPdfRegistrationError | null
  file: File
  isSubmitting: boolean
  onBack: () => void
  onCancel: () => void
  onReplace: () => void
  onSubmit: () => void
  passwordInputRef: RefObject<HTMLInputElement | null>
  status: 'DOCUMENT_UPLOADING' | 'SOURCE_EDITING' | 'SOURCE_SAVE_FAILED' | 'SOURCE_SUBMITTING'
}) {
  const recovery = error ? registrationErrorCopy[error.code].recovery : null
  const canRetry = recovery === 'password' || recovery === 'retry'
  const canCancelUpload =
    isSubmitting && status === 'DOCUMENT_UPLOADING'

  useEffect(() => {
    if (error?.code === 'PASSWORD_INVALID') {
      passwordInputRef.current?.focus()
    }
  }, [error, passwordInputRef])

  return (
    <div className="pdf-registration-grid">
      <section className="pdf-registration-card" aria-labelledby="pdf-review-title">
        <div className="pdf-registration-card__heading">
          <span>STEP 02</span>
          <div>
            <h2 id="pdf-review-title" tabIndex={-1}>
              선택한 파일을 확인하세요
            </h2>
            <p>등록하면 서버가 문서를 확인하고 Upbit 소스로 저장합니다.</p>
          </div>
        </div>

        {error ? (
          <RegistrationErrorNotice error={error} />
        ) : null}

        <dl className="pdf-review-list">
          <div>
            <dt>선택한 PDF</dt>
            <dd>
              <FileSummary name={file.name} size={file.size} />
            </dd>
          </div>
          <div>
            <dt>데이터 소스</dt>
            <dd className="pdf-review-source">
              <img src={upbitLogo} alt="" />
              <span>
                <strong>Upbit</strong>
                <small>거래내역서 snapshot</small>
              </span>
            </dd>
          </div>
          <div>
            <dt>등록 다음 단계</dt>
            <dd>
              <strong>조회 기간 설정</strong>
              <span className="pdf-review-list__description">
                소스가 저장된 뒤 조회 기간과 문서 포함 기간을 확인합니다.
              </span>
            </dd>
          </div>
        </dl>

        <div className="pdf-password-field">
          <label htmlFor="upbit-pdf-password">
            PDF 비밀번호 <span>(암호화되지 않은 경우 공백)</span>
          </label>
          <input
            ref={passwordInputRef}
            id="upbit-pdf-password"
            type="password"
            autoComplete="off"
            disabled={isSubmitting}
            aria-describedby={
              error?.code === 'PASSWORD_INVALID'
                ? 'upbit-pdf-password-notice upbit-pdf-registration-error'
                : 'upbit-pdf-password-notice'
            }
            aria-invalid={error?.code === 'PASSWORD_INVALID' || undefined}
            placeholder="비밀번호 입력"
            spellCheck={false}
          />
          <p id="upbit-pdf-password-notice">
            입력한 비밀번호는 파일 처리에만 사용하며 저장하지 않습니다.
          </p>
        </div>

        {isSubmitting ? (
          <div className="pdf-submit-status" role="status" aria-live="polite">
            <span className="pdf-submit-status__spinner" aria-hidden="true" />
            <div>
              <strong>
                {status === 'DOCUMENT_UPLOADING'
                  ? 'PDF를 안전하게 업로드하고 있어요'
                  : '서버에서 문서를 확인하고 있어요'}
              </strong>
              <p>이 화면을 닫지 말고 잠시 기다려 주세요.</p>
            </div>
          </div>
        ) : null}

        <div className="pdf-registration-actions">
          <button
            type="button"
            className="pdf-secondary-action"
            disabled={isSubmitting && !canCancelUpload}
            onClick={
              canCancelUpload ? onCancel : error ? onReplace : onBack
            }
          >
            {canCancelUpload
              ? '업로드 취소'
              : isSubmitting
                ? '서버 확인 중'
                : error
                  ? '다른 PDF 선택'
                  : '이전'}
          </button>
          {!error || canRetry ? (
            <button
              type="button"
              className="source-primary-action"
              disabled={isSubmitting}
              onClick={onSubmit}
            >
              {isSubmitting
                ? '등록 중…'
                : recovery === 'password'
                  ? '비밀번호로 다시 등록'
                  : canRetry
                  ? '다시 시도'
                  : 'Upbit PDF 등록'}
              {!isSubmitting ? <span aria-hidden="true">→</span> : null}
            </button>
          ) : null}
        </div>
      </section>

      <aside className="pdf-registration-aside" aria-label="등록 처리 순서">
        <span className="pdf-registration-aside__eyebrow">REGISTRATION</span>
        <h2>등록 버튼을 누르면</h2>
        <ol className="pdf-processing-list">
          <li>
            <span aria-hidden="true">01</span>
            <div>
              <strong>비공개 저장소 업로드</strong>
              <p>브라우저에 파일이나 파일명을 저장하지 않습니다.</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">02</span>
            <div>
              <strong>서버 문서 확인</strong>
              <p>파일 형식, 손상·암호화 여부와 중복을 확인합니다.</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">03</span>
            <div>
              <strong>데이터 소스 저장</strong>
              <p>모든 확인에 성공한 뒤에만 Source를 생성합니다.</p>
            </div>
          </li>
        </ol>
        <div className="pdf-registration-aside__note">
          <strong>아직 수집은 시작되지 않아요</strong>
          <p>
            조회 기간 연결과 수집 Job 생성은 소스 등록이 끝난 다음 단계에서
            진행합니다.
          </p>
        </div>
      </aside>
    </div>
  )
}

function PdfCompletionStep({
  fileSummary,
  onReset,
  periodHref,
  sourceStatus,
}: {
  fileSummary: { name: string; size: number }
  onReset: () => void
  periodHref: string
  sourceStatus: 'SOURCE_SAVED'
}) {
  return (
    <section className="pdf-completion-card" aria-labelledby="pdf-completion-title">
      <div className="pdf-completion-card__icon">
        <img src={registrationComplete} alt="" />
        <span aria-hidden="true">✓</span>
      </div>
      <span className="pdf-completion-card__eyebrow">SOURCE SAVED</span>
      <h2 id="pdf-completion-title" tabIndex={-1}>
        Upbit 데이터 소스를 등록했어요
      </h2>
      <p>
        PDF 서버 확인과 Source 저장이 완료되었습니다. 조회 기간을 연결하면
        수집을 시작할 수 있습니다.
      </p>

      <div className="pdf-completion-summary">
        <div>
          <span>현재 상태</span>
          <strong className="pdf-source-status">
            <span aria-hidden="true" />
            {sourceStatus}
          </strong>
        </div>
        <div>
          <span>등록한 파일</span>
          <FileSummary name={fileSummary.name} size={fileSummary.size} />
        </div>
        <div>
          <span>다음 단계</span>
          <strong>조회 기간 설정</strong>
        </div>
      </div>

      <div className="pdf-completion-actions">
        <a className="source-primary-action" href={periodHref}>
          조회 기간 설정 <span aria-hidden="true">→</span>
        </a>
        <button type="button" className="pdf-secondary-action" onClick={onReset}>
          PDF 추가 등록
        </button>
      </div>
      <p id="period-follow-up-note" className="pdf-completion-follow-up">
        등록한 Source는 유지되며, 다음 화면에서 문서 포함 기간을 확인합니다.
      </p>
    </section>
  )
}

export function UpbitPdfRegistrationPage({
  registerPdf = registerUpbitPdfMock,
}: {
  registerPdf?: RegisterUpbitPdf
}) {
  const [state, dispatch] = useReducer(
    upbitPdfRegistrationReducer,
    initialUpbitPdfRegistrationState,
  )
  const activeRequestRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)
  const stepContentRef = useRef<HTMLDivElement>(null)
  const previousStepRef = useRef(1)
  const currentStep = getCurrentStep(state)

  useEffect(
    () => () => {
      activeRequestRef.current += 1
      abortControllerRef.current?.abort()
    },
    [],
  )

  useEffect(() => {
    if (previousStepRef.current !== currentStep) {
      stepContentRef.current?.querySelector<HTMLElement>('h2')?.focus()
      previousStepRef.current = currentStep
    }
  }, [currentStep])

  function handleFilesSelected(files: FileList | null) {
    abortControllerRef.current?.abort()
    activeRequestRef.current += 1

    if (files && files.length > 1) {
      dispatch({
        error: { code: 'FILE_COUNT' },
        type: 'FILE_REJECTED',
      })
      return
    }

    const file = files?.[0]
    if (!file) {
      dispatch({
        error: { code: 'FILE_REQUIRED' },
        type: 'FILE_REJECTED',
      })
      return
    }

    const error = validateUpbitPdfFile(file)

    if (error) {
      dispatch({ error, type: 'FILE_REJECTED' })
      return
    }

    dispatch({
      file,
      intentKey: createUpbitPdfIntentKey(),
      type: 'FILE_ACCEPTED',
    })
  }

  function handleReplace() {
    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    if (passwordInputRef.current) {
      passwordInputRef.current.value = ''
    }
    submittingRef.current = false
    dispatch({ type: 'REPLACE_FILE' })
  }

  function handleCancelUpload() {
    if (
      state.view !== 'submitting' ||
      state.status !== 'DOCUMENT_UPLOADING'
    ) {
      return
    }

    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    submittingRef.current = false
    dispatch({ type: 'SUBMIT_CANCELLED' })
  }

  async function handleSubmit() {
    if (state.view !== 'review' || submittingRef.current) {
      return
    }

    submittingRef.current = true
    const requestId = activeRequestRef.current + 1
    activeRequestRef.current = requestId
    const controller = new AbortController()
    abortControllerRef.current = controller
    const { file, intentKey } = state
    const enteredPassword = passwordInputRef.current?.value ?? ''
    let password: string | null =
      enteredPassword === '' ? null : enteredPassword

    if (passwordInputRef.current) {
      passwordInputRef.current.value = ''
    }

    dispatch({ type: 'SUBMIT_STARTED' })

    try {
      const result = await registerPdf({
        file,
        intentKey,
        onStageChange: (status) => {
          if (
            activeRequestRef.current === requestId &&
            !controller.signal.aborted
          ) {
            dispatch({ status, type: 'SUBMIT_STAGE_CHANGED' })
          }
        },
        password,
        signal: controller.signal,
      })

      if (
        activeRequestRef.current !== requestId ||
        controller.signal.aborted
      ) {
        return
      }

      if (result.ok) {
        dispatch({
          sourceId: result.sourceId,
          sourceStatus: result.sourceStatus,
          type: 'SUBMIT_SUCCEEDED',
        })
      } else {
        dispatch({ error: result.error, type: 'SUBMIT_FAILED' })
      }
    } catch {
      if (
        activeRequestRef.current === requestId &&
        !controller.signal.aborted
      ) {
        dispatch({
          error: { code: 'PROCESSING_FAILED' },
          type: 'SUBMIT_FAILED',
        })
      }
    } finally {
      password = null
      if (activeRequestRef.current === requestId) {
        abortControllerRef.current = null
        submittingRef.current = false
      }
    }
  }

  const pageCopy =
    state.view === 'complete'
      ? {
          description:
            '서버 확인이 끝난 Upbit PDF 소스를 조회 기간 설정으로 연결합니다.',
          title: 'Upbit PDF 등록 완료',
        }
      : state.view === 'review' || state.view === 'submitting'
        ? {
            description:
              '선택한 파일을 확인한 뒤 Upbit 데이터 소스로 등록합니다.',
            title: '등록 정보 확인',
          }
        : {
            description:
              'Upbit 거래내역서 PDF 한 개를 등록하고, 암호화된 파일은 다음 단계에서 비밀번호를 입력합니다.',
            title: 'Upbit PDF 등록',
          }

  return (
    <SourceFlowLayout
      badge={{ label: `${currentStep} / 3`, tone: 'upbit', type: 'flow' }}
      description={pageCopy.description}
      eyebrow="DATA SOURCES · UPBIT"
      title={pageCopy.title}
    >
      <PdfRegistrationStepper currentStep={currentStep} />

      <div ref={stepContentRef}>
        {state.view === 'select' ? (
          <PdfSelectionStep
            error={state.error}
            file={state.file}
            onContinue={() => dispatch({ type: 'CONTINUE_TO_REVIEW' })}
            onFilesSelected={handleFilesSelected}
          />
        ) : null}

        {state.view === 'review' ? (
          <PdfReviewStep
            error={state.error}
            file={state.file}
            isSubmitting={false}
            onBack={() => dispatch({ type: 'BACK_TO_SELECT' })}
            onCancel={() => undefined}
            onReplace={handleReplace}
            onSubmit={handleSubmit}
            passwordInputRef={passwordInputRef}
            status={state.status}
          />
        ) : null}

        {state.view === 'submitting' ? (
          <PdfReviewStep
            error={null}
            file={state.file}
            isSubmitting
            onBack={() => undefined}
            onCancel={handleCancelUpload}
            onReplace={() => undefined}
            onSubmit={() => undefined}
            passwordInputRef={passwordInputRef}
            status={state.status}
          />
        ) : null}

        {state.view === 'complete' ? (
          <PdfCompletionStep
            fileSummary={state.fileSummary}
            onReset={() => dispatch({ type: 'RESET' })}
            periodHref={`/sources/${encodeURIComponent(state.sourceId)}/period`}
            sourceStatus={state.sourceStatus}
          />
        ) : null}
      </div>

      <p className="source-footer-note">
        PDF 파일·본문·파일명·비밀번호는 브라우저 저장소나 URL에 남기지
        않습니다.
      </p>
    </SourceFlowLayout>
  )
}
