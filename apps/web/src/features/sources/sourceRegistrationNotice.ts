const sourceRegistrationNoticeKey = 'source-registration-notice.v1'

export function queueWalletRegistrationNotice() {
  window.sessionStorage.setItem(sourceRegistrationNoticeKey, 'wallet')
}

export function consumeWalletRegistrationNotice() {
  const value = window.sessionStorage.getItem(sourceRegistrationNoticeKey)
  window.sessionStorage.removeItem(sourceRegistrationNoticeKey)
  return value === 'wallet'
}
