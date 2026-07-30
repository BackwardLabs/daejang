import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { AppDialog } from './AppDialog.tsx'

function DialogHarness() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        모달 열기
      </button>
      {open ? (
        <AppDialog
          footer={
            <button type="button" onClick={() => setOpen(false)}>
              완료
            </button>
          }
          onClose={() => setOpen(false)}
          title="테스트 모달"
        >
          <p>모달 내용</p>
        </AppDialog>
      ) : null}
    </>
  )
}

afterEach(() => {
  document.body.style.overflow = ''
})

describe('AppDialog', () => {
  it('traps focus, closes with Escape, and restores the trigger focus', () => {
    render(<DialogHarness />)
    const trigger = screen.getByRole('button', { name: '모달 열기' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: '테스트 모달' })
    const closeButton = screen.getByRole('button', { name: '테스트 모달 닫기' })
    const completeButton = screen.getByRole('button', { name: '완료' })
    expect(dialog).toBeInTheDocument()
    expect(closeButton).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')

    completeButton.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(closeButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '테스트 모달' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('closes only when the backdrop itself is pressed', () => {
    render(<DialogHarness />)
    fireEvent.click(screen.getByRole('button', { name: '모달 열기' }))

    const dialog = screen.getByRole('dialog', { name: '테스트 모달' })
    const backdrop = dialog.parentElement
    expect(backdrop).not.toBeNull()

    fireEvent.mouseDown(dialog)
    expect(screen.getByRole('dialog', { name: '테스트 모달' })).toBeInTheDocument()

    fireEvent.mouseDown(backdrop as HTMLElement)
    expect(screen.queryByRole('dialog', { name: '테스트 모달' })).not.toBeInTheDocument()
  })
})
