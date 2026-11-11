export interface ErrorBannerProps {
  message: string | null
}

export function ErrorBanner({ message }: ErrorBannerProps) {
  return message === null ? null : <p role="alert">{message}</p>
}
